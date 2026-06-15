import {
  DEFAULT_FILE_NAME,
  ERROR_CODES,
  MAX_HTML_BYTES,
} from "./constants.mjs";

const validationError = (message) => {
  const error = new Error(message);
  error.code = ERROR_CODES.VALIDATION_ERROR;
  error.statusCode = 400;
  return error;
};

export const validatePdfRequest = (payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw validationError("Request body must be a JSON object");
  }

  if (typeof payload.html !== "string" || payload.html.trim() === "") {
    throw validationError("html is required");
  }

  if (Buffer.byteLength(payload.html, "utf8") > MAX_HTML_BYTES) {
    throw validationError("html must not exceed 5 MiB");
  }

  const fileName = payload.fileName ?? DEFAULT_FILE_NAME;
  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    fileName.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(fileName)
  ) {
    throw validationError("fileName must be between 1 and 255 safe characters");
  }

  if (
    payload.options !== undefined &&
    (!payload.options ||
      typeof payload.options !== "object" ||
      Array.isArray(payload.options))
  ) {
    throw validationError("options must be an object");
  }

  if (
    payload.inlinePdf !== undefined &&
    typeof payload.inlinePdf !== "boolean"
  ) {
    throw validationError("inlinePdf must be a boolean");
  }

  return {
    html: payload.html,
    fileName,
    inlinePdf: payload.inlinePdf ?? false,
    options: payload.options ?? {},
  };
};
