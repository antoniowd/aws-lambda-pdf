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

const client = new S3Client({ region: REGION });

export const handler = async (event, _) => {
  const { html, fileName, inlinePdf, options } = JSON.parse(event.body);

  if (!html) {
    return sendResponse(400, { success: false, error: "html is required" });
  }

  const name = fileName ?? "sample-document.pdf";
  const key = `${fileName}`;
  let browser;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    await page.setContent(html, { waitUntil: "networkidle0" });

    const buffer = await page.pdf({
      format: options?.format ?? "A4",
      printBackground: options?.printBackground ?? true,
      displayHeaderFooter: options?.displayHeaderFooter ?? false,
      margin: {
        top: options?.marginTop ?? "20px",
        right: options?.marginRight ?? "20px",
        bottom: options?.marginBottom ?? "20px",
        left: options?.marginLeft ?? "20px",
      },
      headerTemplate: options?.headerTemplate ?? "",
      footerTemplate: options?.footerTemplate ?? "",
      landscape: options?.landscape ?? false,
      scale: options?.scale ?? 1,
      pageRanges: options?.pageRanges ?? "",
      width: options?.width ?? "",
      height: options?.height ?? "",
      preferCSSPageSize: options?.preferCSSPageSize ?? false,
      omitBackground: options?.omitBackground ?? false,
    });

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
    return sendResponse(200, {
      success: true,
      fileName: name,
      url,
    });
  } catch (err) {
    if (browser) {
      await browser.close();
    }
    return sendResponse(500, { success: false, error: err.message });
  }
};
