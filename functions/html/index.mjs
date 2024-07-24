import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const BUCKET_NAME = process.env.BUCKET_NAME;

export const handler = async (event, context) => {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  const page = await browser.newPage();

  await page.goto("https://www.example.com", { waitUntil: "networkidle0" });

  const buffer = await page.pdf({ format: "A4" });

  const client = new S3Client({ region: "us-east-1" });
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: "test.pdf",
    Body: buffer,
  });

  await client.send(command);

  await page.close();

  await browser.close();

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: "https://www.example.com",
    }),
  };
};
