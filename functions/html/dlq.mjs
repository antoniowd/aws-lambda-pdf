import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ERROR_CODES, JOB_STATUS } from "./lib/constants.mjs";
import { isoTime } from "./lib/job-utils.mjs";
import { emitMetrics, logEvent } from "./lib/metrics.mjs";

const region = process.env.REGION;
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

export const createDlqHandler = ({
  dynamo = dynamoClient,
  tableName = process.env.JOBS_TABLE,
  now = () => Date.now(),
} = {}) =>
  async (event) => {
    const batchItemFailures = [];
    for (const record of event.Records ?? []) {
      try {
        const { jobId } = JSON.parse(record.body ?? "{}");
        if (!jobId) continue;
        const timestamp = isoTime(now());
        await dynamo.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { jobId },
            UpdateExpression:
              "SET #status = :failed, updatedAt = :updatedAt, failedAt = :updatedAt, errorCode = if_not_exists(errorCode, :errorCode), errorMessage = if_not_exists(errorMessage, :errorMessage) REMOVE leaseId, leaseExpiresAt",
            ConditionExpression:
              "attribute_exists(jobId) AND #status <> :completed AND #status <> :failed",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":failed": JOB_STATUS.FAILED,
              ":completed": JOB_STATUS.COMPLETED,
              ":updatedAt": timestamp,
              ":errorCode": ERROR_CODES.MAX_ATTEMPTS_EXCEEDED,
              ":errorMessage": "The PDF job failed after three attempts",
            },
          }),
        );
        emitMetrics({ PermanentFailures: 1 }, { Service: "PdfDlq" });
        logEvent("error", "PDF job permanently failed", { jobId });
      } catch (error) {
        if (error?.name === "ConditionalCheckFailedException") continue;
        batchItemFailures.push({ itemIdentifier: record.messageId });
        logEvent("error", "Failed to finalize DLQ job", {
          messageId: record.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { batchItemFailures };
  };

export const handler = createDlqHandler();
