import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PDF_CONTENT_TYPE, SIGNED_URL_SECONDS } from "./lib/constants.mjs";
import { parseJsonBody, sendResponse } from "./lib/http.mjs";
import { logEvent } from "./lib/metrics.mjs";
import { createRenderer } from "./lib/renderer.mjs";
import { validatePdfRequest } from "./lib/validation.mjs";

const BUCKET_NAME = process.env.BUCKET_NAME;
const REGION = process.env.REGION;
const client = new S3Client({ region: REGION });

export const createSynchronousHandler = ({
  s3 = client,
  signUrl = getSignedUrl,
  pdfRenderer = createRenderer({ puppeteer, chromium, reuseBrowser: false }),
  bucketName = BUCKET_NAME,
  now = () => Date.now(),
} = {}) =>
  async (event, context) => {
    const startedAt = now();
    try {
      const request = validatePdfRequest(parseJsonBody(event));
      const rendered = await pdfRenderer.render({
        html: request.html,
        options: request.options,
        context,
        strictAssets: false,
        defaultAssetTimeoutMs: 15_000,
        maxAssetTimeoutMs: 20_000,
        reserveTimeMs: 8_000,
      });

      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: request.fileName,
          Body: rendered.buffer,
          ContentType: PDF_CONTENT_TYPE,
          ServerSideEncryption: "AES256",
        }),
      );

      const url = await signUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucketName,
          Key: request.fileName,
          ResponseContentDisposition: request.inlinePdf ? "inline" : "attachment",
          ResponseContentType: PDF_CONTENT_TYPE,
        }),
        { expiresIn: SIGNED_URL_SECONDS },
      );
      logEvent("info", "Synchronous PDF generated", {
        deprecated: true,
        elapsedMs: now() - startedAt,
        sizeBytes: rendered.buffer.length,
        assets: rendered.assets,
      });

      return sendResponse(
        200,
        {
          success: true,
          fileName: request.fileName,
          url,
          assets: rendered.assets,
        },
        {
          Deprecation: "true",
        },
      );
    } catch (error) {
      logEvent("error", "Synchronous PDF generation failed", {
        deprecated: true,
        elapsedMs: now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return sendResponse(Number(error?.statusCode) || 500, {
        success: false,
        error:
          Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500
            ? error.message
            : "The PDF service could not process the request",
      });
    }
  };

export const handler = createSynchronousHandler();
