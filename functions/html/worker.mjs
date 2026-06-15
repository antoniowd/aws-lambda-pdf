import { randomUUID } from "node:crypto";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ERROR_CODES, JOB_STATUS, PDF_CONTENT_TYPE } from "./lib/constants.mjs";
import {
  classifyWorkerError,
  isConditionalError,
  isTerminalStatus,
  isoTime,
} from "./lib/job-utils.mjs";
import { emitMetrics, logEvent } from "./lib/metrics.mjs";
import { createRenderer, PdfGenerationError } from "./lib/renderer.mjs";

const region = process.env.REGION;
const s3Client = new S3Client({ region });
const sqsClient = new SQSClient({ region });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const renderer = createRenderer({ puppeteer, chromium, reuseBrowser: true });
let coldStart = true;

const readBody = async (body) => {
  if (typeof body?.transformToString === "function") return body.transformToString();
  if (typeof body === "string") return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

export const createWorkerHandler = ({
  s3 = s3Client,
  sqs = sqsClient,
  dynamo = dynamoClient,
  pdfRenderer = renderer,
  bucketName = process.env.BUCKET_NAME,
  queueUrl = process.env.QUEUE_URL,
  tableName = process.env.JOBS_TABLE,
  now = () => Date.now(),
  uuid = randomUUID,
  isColdStart = () => coldStart,
  markWarm = () => {
    coldStart = false;
  },
} = {}) => {
  const processRecord = async (record, context) => {
    const startedAt = now();
    const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? 1);
    const { jobId } = JSON.parse(record.body ?? "{}");
    if (!jobId) return;

    const jobResult = await dynamo.send(
      new GetCommand({ TableName: tableName, Key: { jobId }, ConsistentRead: true }),
    );
    const existingJob = jobResult.Item;
    if (!existingJob || isTerminalStatus(existingJob.status)) return;
    if (existingJob.ttl && existingJob.ttl <= Math.floor(now() / 1000)) return;

    const leaseId = uuid();
    const nowMs = now();
    const nowEpoch = Math.floor(nowMs / 1000);
    let job;
    try {
      const claimed = await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { jobId },
          UpdateExpression:
            "SET #status = :processing, attempts = if_not_exists(attempts, :zero) + :one, updatedAt = :updatedAt, leaseId = :leaseId, leaseExpiresAt = :leaseExpiresAt REMOVE errorCode, errorMessage",
          ConditionExpression:
            "#status = :queued OR (#status = :processing AND (attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt < :nowEpoch))",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":queued": JOB_STATUS.QUEUED,
            ":processing": JOB_STATUS.PROCESSING,
            ":zero": 0,
            ":one": 1,
            ":updatedAt": isoTime(nowMs),
            ":leaseId": leaseId,
            ":leaseExpiresAt": nowEpoch + 360,
            ":nowEpoch": nowEpoch,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      job = claimed.Attributes;
    } catch (error) {
      if (isConditionalError(error)) return;
      throw error;
    }

    try {
      let input;
      try {
        const object = await s3.send(
          new GetObjectCommand({ Bucket: bucketName, Key: job.inputKey }),
        );
        input = JSON.parse(await readBody(object.Body));
      } catch (error) {
        const wrapped = new PdfGenerationError(
          ERROR_CODES.INPUT_READ_FAILED,
          "Stored PDF input could not be read",
          { cause: error instanceof Error ? error.message : String(error) },
        );
        throw wrapped;
      }

      const rendered = await pdfRenderer.render({
        html: input.html,
        options: input.options,
        context,
        strictAssets: true,
      });
      const uploadStartedAt = now();
      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: job.outputKey,
          Body: rendered.buffer,
          ContentType: PDF_CONTENT_TYPE,
          ServerSideEncryption: "AES256",
        }),
      );
      const uploadMs = now() - uploadStartedAt;
      const completedAt = now();

      await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { jobId },
          UpdateExpression:
            "SET #status = :completed, updatedAt = :updatedAt, completedAt = :updatedAt, assets = :assets, pdfBytes = :pdfBytes, timings = :timings REMOVE leaseId, leaseExpiresAt, errorCode, errorMessage",
          ConditionExpression: "#status = :processing AND leaseId = :leaseId",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":completed": JOB_STATUS.COMPLETED,
            ":processing": JOB_STATUS.PROCESSING,
            ":leaseId": leaseId,
            ":updatedAt": isoTime(completedAt),
            ":assets": rendered.assets,
            ":pdfBytes": rendered.buffer.length,
            ":timings": { ...rendered.timings, uploadMs },
          },
        }),
      );

      emitMetrics(
        {
          JobsCompleted: 1,
          ColdStart: isColdStart() ? 1 : 0,
          BrowserColdStart: rendered.coldBrowser ? 1 : 0,
          BrowserLaunchMs: rendered.timings.browserLaunchMs,
          AssetLoadMs: rendered.timings.assetLoadMs,
          PdfRenderMs: rendered.timings.pdfRenderMs,
          UploadMs: uploadMs,
          TotalDurationMs: now() - startedAt,
          ImagesTotal: rendered.assets.totalImages,
          ImagesFailed: rendered.assets.failedImages,
          PdfBytes: rendered.buffer.length,
          RemainingTimeMs: context?.getRemainingTimeInMillis?.() ?? 0,
        },
        { Service: "PdfWorker" },
      );
      markWarm();
      logEvent("info", "PDF job completed", {
        jobId,
        attempt: job.attempts,
        receiveCount,
      });
    } catch (error) {
      const failure = classifyWorkerError(error);
      await dynamo
        .send(
          new UpdateCommand({
            TableName: tableName,
            Key: { jobId },
            UpdateExpression:
              "SET updatedAt = :updatedAt, errorCode = :errorCode, errorMessage = :errorMessage, leaseExpiresAt = :expired",
            ConditionExpression: "#status = :processing AND leaseId = :leaseId",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":updatedAt": isoTime(now()),
              ":errorCode": failure.code,
              ":errorMessage": failure.message,
              ":expired": 0,
              ":processing": JOB_STATUS.PROCESSING,
              ":leaseId": leaseId,
            },
          }),
        )
        .catch(() => {});
      await sqs
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: record.receiptHandle,
            VisibilityTimeout: 0,
          }),
        )
        .catch(() => {});

      emitMetrics(
        {
          JobsRetried: 1,
          TotalDurationMs: now() - startedAt,
          Attempt: receiveCount,
          RemainingTimeMs: context?.getRemainingTimeInMillis?.() ?? 0,
        },
        { Service: "PdfWorker" },
      );
      markWarm();
      logEvent("error", "PDF job attempt failed", {
        jobId,
        attempt: job.attempts,
        receiveCount,
        errorCode: failure.code,
        cause: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  return async (event, context) => {
    const batchItemFailures = [];
    for (const record of event.Records ?? []) {
      try {
        await processRecord(record, context);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
};

export const handler = createWorkerHandler();
