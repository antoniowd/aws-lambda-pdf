import assert from "node:assert/strict";
import test from "node:test";
import { createStatusHandler } from "../status.mjs";
import { createSubmitHandler } from "../submit.mjs";
import { createApiEvent, jsonBody, commandName } from "./helpers.mjs";

const fixedNow = Date.parse("2026-06-13T12:00:00.000Z");

test("submits a PDF job and returns its polling URL", async () => {
  const calls = [];
  const client = { send: async (command) => (calls.push(command), {}) };
  const handler = createSubmitHandler({
    s3: client,
    sqs: client,
    dynamo: client,
    bucketName: "bucket",
    queueUrl: "queue",
    tableName: "jobs",
    now: () => fixedNow,
    uuid: () => "job-123",
  });

  const response = await handler(createApiEvent({ html: "<p>Hello</p>" }));
  const body = jsonBody(response);

  assert.equal(response.statusCode, 202);
  assert.equal(body.jobId, "job-123");
  assert.equal(body.status, "queued");
  assert.equal(body.statusUrl, "https://api.example.com/prod/pdf/jobs/job-123");
  assert.deepEqual(calls.map(commandName), [
    "PutObjectCommand",
    "PutCommand",
    "SendMessageCommand",
  ]);
});

test("returns the original job for a repeated idempotency key", async () => {
  const records = new Map();
  let transactionCount = 0;
  const s3Calls = [];
  const s3 = { send: async (command) => (s3Calls.push(commandName(command)), {}) };
  const sqs = { send: async () => ({}) };
  const dynamo = {
    send: async (command) => {
      if (commandName(command) === "TransactWriteCommand") {
        transactionCount += 1;
        if (transactionCount > 1) {
          const error = new Error("duplicate");
          error.name = "TransactionCanceledException";
          throw error;
        }
        for (const item of command.input.TransactItems) {
          records.set(item.Put.Item.jobId, item.Put.Item);
        }
        return {};
      }
      if (commandName(command) === "GetCommand") {
        return { Item: records.get(command.input.Key.jobId) };
      }
      return {};
    },
  };
  let nextId = 0;
  const handler = createSubmitHandler({
    s3,
    sqs,
    dynamo,
    bucketName: "bucket",
    queueUrl: "queue",
    tableName: "jobs",
    now: () => fixedNow,
    uuid: () => `job-${++nextId}`,
  });
  const event = createApiEvent(
    { html: "<p>Hello</p>", options: { printBackground: true } },
    { "Idempotency-Key": "invoice-42" },
  );

  const first = jsonBody(await handler(event));
  const second = jsonBody(await handler(event));

  assert.equal(first.jobId, "job-1");
  assert.equal(second.jobId, "job-1");
  assert.equal(s3Calls.filter((name) => name === "DeleteObjectCommand").length, 1);
});

test("rejects an idempotency key reused for different content", async () => {
  const records = new Map();
  let transactionCount = 0;
  const noop = { send: async () => ({}) };
  const dynamo = {
    send: async (command) => {
      if (commandName(command) === "TransactWriteCommand") {
        transactionCount += 1;
        if (transactionCount > 1) {
          const error = new Error("duplicate");
          error.name = "TransactionCanceledException";
          throw error;
        }
        for (const item of command.input.TransactItems) {
          records.set(item.Put.Item.jobId, item.Put.Item);
        }
        return {};
      }
      if (commandName(command) === "GetCommand") {
        return { Item: records.get(command.input.Key.jobId) };
      }
      return {};
    },
  };
  const handler = createSubmitHandler({
    s3: noop,
    sqs: noop,
    dynamo,
    bucketName: "bucket",
    queueUrl: "queue",
    tableName: "jobs",
    now: () => fixedNow,
  });
  const headers = { "Idempotency-Key": "same-key" };
  await handler(createApiEvent({ html: "first" }, headers));
  const response = await handler(createApiEvent({ html: "second" }, headers));

  assert.equal(response.statusCode, 409);
  assert.equal(jsonBody(response).error.code, "IDEMPOTENCY_CONFLICT");
});

test("returns a signed URL for a completed job", async () => {
  const job = {
    jobId: "job-123",
    recordType: "job",
    status: "completed",
    attempts: 1,
    fileName: "invoice.pdf",
    inlinePdf: false,
    outputKey: "jobs/job-123/output.pdf",
    assets: { totalImages: 2, loadedImages: 2, failedImages: 0 },
    createdAt: "2026-06-13T12:00:00.000Z",
    updatedAt: "2026-06-13T12:01:00.000Z",
    expiresAt: "2026-06-14T12:00:00.000Z",
    ttl: Math.floor(fixedNow / 1000) + 86400,
  };
  const handler = createStatusHandler({
    s3: {},
    dynamo: { send: async () => ({ Item: job }) },
    signUrl: async (_client, command) => {
      assert.match(command.input.ResponseContentDisposition, /invoice.pdf/);
      return "https://signed.example/pdf";
    },
    bucketName: "bucket",
    tableName: "jobs",
    now: () => fixedNow,
  });

  const response = await handler({ pathParameters: { jobId: "job-123" } });
  assert.equal(response.statusCode, 200);
  assert.equal(jsonBody(response).url, "https://signed.example/pdf");
});

test("returns 404 when job metadata has expired", async () => {
  const handler = createStatusHandler({
    dynamo: {
      send: async () => ({
        Item: { jobId: "old", recordType: "job", ttl: 1 },
      }),
    },
    tableName: "jobs",
    now: () => fixedNow,
  });
  const response = await handler({ pathParameters: { jobId: "old" } });
  assert.equal(response.statusCode, 404);
  assert.equal(jsonBody(response).error.code, "JOB_EXPIRED");
});
