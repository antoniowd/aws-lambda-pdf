import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET_NAME = process.env.BUCKET_NAME;
const REGION = process.env.REGION;
const PDF_CONTENT_TYPE = "application/pdf";

const sendResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

export const handler = async (event, _) => {
  const { html, fileName, inlinePdf } = JSON.parse(event.body);

  if (!html) {
    return sendResponse(400, { message: "html is required" });
  }

  const name = fileName ?? "sample-document.pdf";
  const key = `${fileName}`;

  try {
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    await page.setContent(html, { waitUntil: "networkidle0" });

    const buffer = await page.pdf({ format: "A4" });

    const client = new S3Client({ region: REGION });

    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: PDF_CONTENT_TYPE,
      }),
    );

    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        ResponseContentDisposition: inlinePdf ? "inline" : "attachment",
        ResponseContentType: PDF_CONTENT_TYPE,
      }),
      { expiresIn: 3600 }, // 1 hour
    );

    await page.close();

    await browser.close();

    return sendResponse(200, { fileName: name, url });
  } catch (err) {
    return sendResponse(500, { message: err.message });
  }
};
