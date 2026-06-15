import assert from "node:assert/strict";
import test from "node:test";
import { createDlqHandler } from "../dlq.mjs";
import { PdfGenerationError } from "../lib/renderer.mjs";
import { createWorkerHandler } from "../worker.mjs";
import { commandName, createContext } from "./helpers.mjs";

const queuedJob = {
  jobId: "job-1",
  recordType: "job",
  status: "queued",
  attempts: 0,
  inputKey: "jobs/job-1/input.json",
  outputKey: "jobs/job-1/output.pdf",
};

const sqsEvent = {
  Records: [
    {
      messageId: "message-1",
      receiptHandle: "receipt-1",
      body: JSON.stringify({ jobId: "job-1" }),
      attributes: { ApproximateReceiveCount: "1" },
    },
  ],
};

test("worker claims, renders, uploads, and completes a job", async () => {
  const dynamoCommands = [];
  const dynamo = {
    send: async (command) => {
      dynamoCommands.push(command);
      if (commandName(command) === "GetCommand") return { Item: queuedJob };
      if (dynamoCommands.length === 2) {
        return { Attributes: { ...queuedJob, status: "processing", attempts: 1 } };
      }
      return {};
    },
  };
  const s3Commands = [];
  const s3 = {
    send: async (command) => {
      s3Commands.push(command);
      if (commandName(command) === "GetObjectCommand") {
        return {
          Body: {
            transformToString: async () => JSON.stringify({
              html: "<p>Hello</p>",
              options: {},
            }),
          },
        };
      }
      return {};
    },
  };
  const handler = createWorkerHandler({
    s3,
    sqs: { send: async () => ({}) },
    dynamo,
    pdfRenderer: {
      render: async () => ({
        buffer: Buffer.from("pdf"),
        assets: { totalImages: 0, loadedImages: 0, failedImages: 0 },
        timings: { browserLaunchMs: 10, assetLoadMs: 2, pdfRenderMs: 3 },
        coldBrowser: true,
      }),
    },
    bucketName: "bucket",
    queueUrl: "queue",
    tableName: "jobs",
    now: (() => {
      let value = 1_000_000;
      return () => (value += 10);
    })(),
    uuid: () => "lease-1",
  });

  const result = await handler(sqsEvent, createContext());
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(s3Commands.map(commandName), [
    "GetObjectCommand",
    "PutObjectCommand",
  ]);
  assert.equal(dynamoCommands.filter((command) => commandName(command) === "UpdateCommand").length, 2);
});

test("worker reports strict asset failure for retry and releases visibility", async () => {
  let updateCount = 0;
  const dynamo = {
    send: async (command) => {
      if (commandName(command) === "GetCommand") return { Item: queuedJob };
      updateCount += 1;
      if (updateCount === 1) {
        return { Attributes: { ...queuedJob, status: "processing", attempts: 1 } };
      }
      return {};
    },
  };
  const sqsCommands = [];
  const handler = createWorkerHandler({
    s3: {
      send: async () => ({
        Body: {
          transformToString: async () => JSON.stringify({ html: "<img>" }),
        },
      }),
    },
    sqs: { send: async (command) => (sqsCommands.push(command), {}) },
    dynamo,
    pdfRenderer: {
      render: async () => {
        throw new PdfGenerationError(
          "ASSET_LOAD_FAILED",
          "asset failed",
        );
      },
    },
    bucketName: "bucket",
    queueUrl: "queue",
    tableName: "jobs",
    uuid: () => "lease-1",
  });

  const result = await handler(sqsEvent, createContext());
  assert.deepEqual(result, {
    batchItemFailures: [{ itemIdentifier: "message-1" }],
  });
  assert.equal(commandName(sqsCommands[0]), "ChangeMessageVisibilityCommand");
  assert.equal(sqsCommands[0].input.VisibilityTimeout, 0);
});

test("worker ignores an already completed duplicate delivery", async () => {
  let calls = 0;
  const handler = createWorkerHandler({
    dynamo: {
      send: async () => {
        calls += 1;
        return { Item: { ...queuedJob, status: "completed" } };
      },
    },
    tableName: "jobs",
  });
  const result = await handler(sqsEvent, createContext());
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(calls, 1);
});

test("DLQ handler marks exhausted jobs failed", async () => {
  const commands = [];
  const handler = createDlqHandler({
    dynamo: { send: async (command) => (commands.push(command), {}) },
    tableName: "jobs",
    now: () => Date.parse("2026-06-13T12:00:00.000Z"),
  });
  const result = await handler(sqsEvent);
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(commandName(commands[0]), "UpdateCommand");
  assert.equal(
    commands[0].input.ExpressionAttributeValues[":errorCode"],
    "MAX_ATTEMPTS_EXCEEDED",
  );
});
