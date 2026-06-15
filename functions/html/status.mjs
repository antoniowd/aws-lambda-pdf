import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ERROR_CODES,
  JOB_STATUS,
  PDF_CONTENT_TYPE,
  SIGNED_URL_SECONDS,
} from "./lib/constants.mjs";
import { errorResponse, sendResponse } from "./lib/http.mjs";
import { logEvent } from "./lib/metrics.mjs";

const region = process.env.REGION;
const s3Client = new S3Client({ region });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const notFound = (code = ERROR_CODES.JOB_NOT_FOUND) => {
  const error = new Error("PDF job was not found or has expired");
  error.code = code;
  error.statusCode = 404;
  return error;
};

const contentDisposition = (job) => {
  const disposition = job.inlinePdf ? "inline" : "attachment";
  return `${disposition}; filename*=UTF-8''${encodeURIComponent(job.fileName)}`;
};

export const createStatusHandler = ({
  s3 = s3Client,
  dynamo = dynamoClient,
  signUrl = getSignedUrl,
  bucketName = process.env.BUCKET_NAME,
  tableName = process.env.JOBS_TABLE,
  now = () => Date.now(),
} = {}) =>
  async (event) => {
    const jobId = event?.pathParameters?.jobId;
    try {
      if (!jobId) throw notFound();

      const result = await dynamo.send(
        new GetCommand({
          TableName: tableName,
          Key: { jobId },
          ConsistentRead: true,
        }),
      );
      const job = result.Item;
      if (!job || job.recordType !== "job") throw notFound();
      if (job.ttl <= Math.floor(now() / 1000)) throw notFound(ERROR_CODES.JOB_EXPIRED);

      const response = {
        jobId: job.jobId,
        status: job.status,
        attempts: job.attempts ?? 0,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        expiresAt: job.expiresAt,
      };

      if (job.status === JOB_STATUS.COMPLETED) {
        response.fileName = job.fileName;
        response.assets = job.assets;
        response.url = await signUrl(
          s3,
          new GetObjectCommand({
            Bucket: bucketName,
            Key: job.outputKey,
            ResponseContentDisposition: contentDisposition(job),
            ResponseContentType: PDF_CONTENT_TYPE,
          }),
          { expiresIn: SIGNED_URL_SECONDS },
        );
      } else if (job.status === JOB_STATUS.FAILED) {
        response.error = {
          code: job.errorCode ?? ERROR_CODES.MAX_ATTEMPTS_EXCEEDED,
          message: job.errorMessage ?? "The PDF job failed",
        };
      }

      return sendResponse(200, response);
    } catch (error) {
      logEvent("error", "Failed to read PDF job", {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse(error);
    }
  };

export const handler = createStatusHandler();
