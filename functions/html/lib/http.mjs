import { ERROR_CODES, JSON_CONTENT_TYPE } from "./constants.mjs";

export const sendResponse = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: {
    "Content-Type": JSON_CONTENT_TYPE,
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});

export const getHeader = (event, name) => {
  const headers = event?.headers ?? {};
  const target = name.toLowerCase();
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === target,
  );
  return key ? headers[key] : undefined;
};

export const parseJsonBody = (event) => {
  try {
    return JSON.parse(event?.body ?? "{}");
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.code = ERROR_CODES.INVALID_JSON;
    error.statusCode = 400;
    throw error;
  }
};

export const errorResponse = (error) => {
  const statusCode = Number(error?.statusCode) || 500;
  const code = error?.code ?? ERROR_CODES.INTERNAL_ERROR;
  const message =
    statusCode >= 500 ? "The PDF service could not process the request" : error.message;

  return sendResponse(statusCode, {
    success: false,
    error: { code, message },
  });
};

export const getStatusUrl = (event, jobId) => {
  const domain = event?.requestContext?.domainName;
  const stage = event?.requestContext?.stage;
  if (!domain) return `/pdf/jobs/${jobId}`;

  const forwardedProtocol = getHeader(event, "x-forwarded-proto") ?? "https";
  const stagePath = stage && stage !== "$default" ? `/${stage}` : "";
  return `${forwardedProtocol}://${domain}${stagePath}/pdf/jobs/${jobId}`;
};
