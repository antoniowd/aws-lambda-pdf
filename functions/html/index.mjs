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

export const handler = async (event, _) => {
  const { html, name } = JSON.parse(event.body);

  const key = `${name ?? "sample-document"}.pdf`;

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
    }),
  );

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    }),
    { expiresIn: 3600 }, // 1 hour
  );

  await page.close();

  await browser.close();

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: key,
      url,
    }),
  };
};
