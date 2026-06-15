import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  ERROR_CODES,
  JOB_RETENTION_SECONDS,
  JOB_STATUS,
  JSON_CONTENT_TYPE,
} from "./lib/constants.mjs";
import {
  errorResponse,
  getHeader,
  getStatusUrl,
  parseJsonBody,
  sendResponse,
} from "./lib/http.mjs";
import {
  getIdempotencyRecordKey,
  getRequestHash,
  isConditionalError,
  isoTime,
} from "./lib/job-utils.mjs";
import { logEvent } from "./lib/metrics.mjs";
import { validatePdfRequest } from "./lib/validation.mjs";

const region = process.env.REGION;
const s3Client = new S3Client({ region });
const sqsClient = new SQSClient({ region });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const acceptedResponse = (event, job) =>
  sendResponse(202, {
    jobId: job.jobId,
    status: job.status,
    statusUrl: getStatusUrl(event, job.jobId),
    expiresAt: job.expiresAt,
  });

export const createSubmitHandler = ({
  s3 = s3Client,
  sqs = sqsClient,
  dynamo = dynamoClient,
  bucketName = process.env.BUCKET_NAME,
  queueUrl = process.env.QUEUE_URL,
  tableName = process.env.JOBS_TABLE,
  now = () => Date.now(),
  uuid = randomUUID,
} = {}) =>
  async (event) => {
    let inputKey;
    let jobId;
    let idempotencyRecordKey;
    let createdRecord = false;

    try {
      const request = validatePdfRequest(parseJsonBody(event));
      const requestHash = getRequestHash(request);
      const idempotencyKey = getHeader(event, "idempotency-key")?.trim();
      const apiKeyId = event?.requestContext?.identity?.apiKeyId ?? "unknown-api-key";
      const nowMs = now();
      const ttl = Math.floor(nowMs / 1000) + JOB_RETENTION_SECONDS;
      jobId = uuid();
      inputKey = `jobs/${jobId}/input.json`;
      const outputKey = `jobs/${jobId}/output.pdf`;

      if (idempotencyKey) {
        if (idempotencyKey.length > 200) {
          const error = new Error("Idempotency-Key must not exceed 200 characters");
          error.code = ERROR_CODES.VALIDATION_ERROR;
          error.statusCode = 400;
          throw error;
        }
        idempotencyRecordKey = getIdempotencyRecordKey(apiKeyId, idempotencyKey);
      }

      const job = {
        jobId,
        recordType: "job",
        status: JOB_STATUS.QUEUED,
        attempts: 0,
        inputKey,
        outputKey,
        fileName: request.fileName,
        inlinePdf: request.inlinePdf,
        requestHash,
        createdAt: isoTime(nowMs),
        updatedAt: isoTime(nowMs),
        expiresAt: isoTime(ttl * 1000),
        ttl,
      };

      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: inputKey,
          Body: JSON.stringify(request),
          ContentType: JSON_CONTENT_TYPE,
          ServerSideEncryption: "AES256",
        }),
      );

      try {
        if (idempotencyRecordKey) {
          await dynamo.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName: tableName,
                    Item: job,
                    ConditionExpression: "attribute_not_exists(jobId)",
                  },
                },
                {
                  Put: {
                    TableName: tableName,
                    Item: {
                      jobId: idempotencyRecordKey,
                      recordType: "idempotency",
                      targetJobId: jobId,
                      requestHash,
                      createdAt: job.createdAt,
                      expiresAt: job.expiresAt,
                      ttl,
                    },
                    ConditionExpression: "attribute_not_exists(jobId)",
                  },
                },
              ],
            }),
          );
        } else {
          await dynamo.send(
            new PutCommand({
              TableName: tableName,
              Item: job,
              ConditionExpression: "attribute_not_exists(jobId)",
            }),
          );
        }
        createdRecord = true;
      } catch (error) {
        if (!idempotencyRecordKey || !isConditionalError(error)) throw error;

        const idempotencyResult = await dynamo.send(
          new GetCommand({
            TableName: tableName,
            Key: { jobId: idempotencyRecordKey },
            ConsistentRead: true,
          }),
        );
        const existing = idempotencyResult.Item;
        if (!existing) throw error;
        if (existing.requestHash !== requestHash) {
          const conflict = new Error(
            "Idempotency-Key was already used with a different request",
          );
          conflict.code = ERROR_CODES.IDEMPOTENCY_CONFLICT;
          conflict.statusCode = 409;
          throw conflict;
        }

        const jobResult = await dynamo.send(
          new GetCommand({
            TableName: tableName,
            Key: { jobId: existing.targetJobId },
            ConsistentRead: true,
          }),
        );
        if (!jobResult.Item) throw error;
        await s3
          .send(new DeleteObjectCommand({ Bucket: bucketName, Key: inputKey }))
          .catch(() => {});
        return acceptedResponse(event, jobResult.Item);
      }

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ jobId }),
        }),
      );

      logEvent("info", "PDF job queued", { jobId, inputKey });
      return acceptedResponse(event, job);
    } catch (error) {
      if (createdRecord) {
        const deletes = [
          dynamo.send(
            new DeleteCommand({ TableName: tableName, Key: { jobId } }),
          ),
          s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: inputKey })),
        ];
        if (idempotencyRecordKey) {
          deletes.push(
            dynamo.send(
              new DeleteCommand({
                TableName: tableName,
                Key: { jobId: idempotencyRecordKey },
              }),
            ),
          );
        }
        await Promise.allSettled(deletes);
      } else if (inputKey) {
        await s3
          .send(new DeleteObjectCommand({ Bucket: bucketName, Key: inputKey }))
          .catch(() => {});
      }
      logEvent("error", "Failed to submit PDF job", {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse(error);
    }
  };

export const handler = createSubmitHandler();
