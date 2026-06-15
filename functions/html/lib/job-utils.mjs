import { createHash } from "node:crypto";
import { ERROR_CODES, JOB_STATUS } from "./constants.mjs";

export const isoTime = (epochMs) => new Date(epochMs).toISOString();

export const hashValue = (value) =>
  createHash("sha256").update(value).digest("hex");

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

export const getRequestHash = (request) =>
  hashValue(JSON.stringify(canonicalize(request)));

export const getIdempotencyRecordKey = (apiKeyId, idempotencyKey) =>
  `idempotency#${hashValue(`${apiKeyId}:${idempotencyKey}`)}`;

export const isConditionalError = (error) =>
  error?.name === "ConditionalCheckFailedException" ||
  error?.name === "TransactionCanceledException";

export const classifyWorkerError = (error) => {
  if (error?.code === ERROR_CODES.ASSET_LOAD_FAILED) {
    return {
      code: ERROR_CODES.ASSET_LOAD_FAILED,
      message: "One or more PDF assets failed to load",
    };
  }
  if (error?.code === ERROR_CODES.INPUT_READ_FAILED) {
    return {
      code: ERROR_CODES.INPUT_READ_FAILED,
      message: "The stored PDF input could not be read",
    };
  }
  return {
    code: ERROR_CODES.RENDER_FAILED,
    message: "The PDF could not be rendered",
  };
};

export const isTerminalStatus = (status) =>
  status === JOB_STATUS.COMPLETED || status === JOB_STATUS.FAILED;
