# aws-lambda-pdf

Generate PDFs from HTML with Chromium on AWS Lambda. The recommended API is asynchronous: API Gateway stores a job, SQS controls rendering concurrency, DynamoDB exposes job status, and S3 retains inputs and PDFs for 24 hours.

## Architecture

```text
POST /pdf/jobs
  -> Submit Lambda
     -> S3 input.json
     -> DynamoDB queued job
     -> SQS
        -> Worker Lambda + Chromium
           -> S3 output.pdf
           -> DynamoDB completed job

GET /pdf/jobs/{jobId}
  -> Status Lambda
     -> DynamoDB
     -> one-hour signed S3 URL when completed
```

The worker retries failed jobs three times. Exhausted messages move to a DLQ, whose handler marks the job `failed`. SQS and DynamoDB processing is idempotent, so duplicate deliveries do not republish completed jobs.

`POST /pdf/html` remains available for migration but is deprecated and still constrained by API Gateway's synchronous request deadline.

## Requirements

- AWS CLI with deployment credentials
- AWS SAM CLI
- Node.js 24
- pnpm

## Install And Test

```sh
pnpm --dir functions/html install
pnpm --dir layers/chromium install
pnpm test
pnpm build
```

## Deploy

```sh
sam deploy --guided
```

For repeatable deployments, copy `samconfig.example.toml` to `samconfig.toml`, replace the placeholder values, and keep `samconfig.toml` local. The real config is ignored because bucket names, stack names, and Regions are environment-specific.

Deployment parameters:

- `AppBucketName`: globally unique S3 bucket name for job inputs and PDFs.
- `WorkerMemorySize`: `2048`, `3072` (default), or `4096` MiB.
- `WorkerReservedConcurrency`: worker concurrency, default `2`.

Useful stack outputs include `ApiUrl`, `SubmitJobUrl`, `JobsTableName`, `QueueUrl`, `DeadLetterQueueUrl`, and `WorkerFunctionName`.

Retrieve the generated API key:

```sh
aws apigateway get-api-keys \
  --name-query MyApiKey \
  --include-values \
  --region YOUR_REGION
```

## Deployment Safety And Rollback

The legacy synchronous endpoint, `POST /pdf/html`, remains deployed while callers migrate to `POST /pdf/jobs`. Keep existing callers on the synchronous endpoint until the asynchronous path has passed smoke tests in the target environment.

Before deploying a change:

1. Run `pnpm test` and `pnpm build`.
2. Deploy to a non-critical stack or stage first when possible.
3. Submit a small async job, poll it to `completed`, and open the signed URL.
4. Submit a legacy `POST /pdf/html` request to confirm current behavior still works.
5. Check the worker logs, DLQ depth, and the CloudWatch alarms before moving traffic.

If the asynchronous path has issues, roll back operationally by keeping callers on `POST /pdf/html` while you diagnose. If a deployed stack update must be reverted, redeploy the last known-good Git commit with the same parameters:

```sh
git checkout LAST_GOOD_COMMIT
pnpm install --frozen-lockfile
pnpm --dir functions/html install --frozen-lockfile
pnpm --dir layers/chromium install --frozen-lockfile
pnpm build
pnpm run deploy
```

After rollback, confirm `POST /pdf/html` succeeds, stop or drain new async submissions, and inspect `DeadLetterQueueUrl` plus `JobsTableName` for jobs that need application-level retry. Job inputs and outputs expire after 24 hours, so failed async jobs can be safely resubmitted with a new idempotency key once the fix is deployed.

## Asynchronous API

Submit a job:

```sh
curl -X POST "$PDF_API_URL/pdf/jobs" \
  -H "x-api-key: $PDF_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: invoice-123" \
  -d '{
    "html": "<h1>Hello</h1>",
    "fileName": "hello.pdf",
    "inlinePdf": true,
    "options": { "format": "A4", "assetTimeoutMs": 60000 }
  }'
```

The service returns `202`:

```json
{
  "jobId": "d772913f-8ad6-4df7-a9cb-efad122c32e1",
  "status": "queued",
  "statusUrl": "https://example.execute-api.us-east-1.amazonaws.com/prod/pdf/jobs/d772913f-8ad6-4df7-a9cb-efad122c32e1",
  "expiresAt": "2026-06-14T12:00:00.000Z"
}
```

Poll the returned URL with the same API key. Status is one of `queued`, `processing`, `completed`, or `failed`. Completed responses contain a one-hour signed `url`; failed responses contain a stable error code and safe message.

Request rules:

- `html` is required and limited to 5 MiB.
- Missing or timed-out images fail the asynchronous job.
- Public HTTP(S) images and fonts are allowed.
- Loopback, link-local, metadata, and private-network assets are blocked.
- Individual `data:` assets are limited to 2 MiB.
- Job metadata, input HTML, and output PDFs expire after 24 hours.

See [docs/async-integration.md](docs/async-integration.md) for application migration and polling examples.

## PDF Options

Supported options include `format`, `printBackground`, `displayHeaderFooter`, margins, header/footer templates, `landscape`, `scale`, `pageRanges`, `width`, `height`, `preferCSSPageSize`, `omitBackground`, and `assetTimeoutMs`.

The asynchronous asset timeout defaults to 60 seconds and is capped at 120 seconds. The worker reserves at least 45 seconds for rendering, upload, and cleanup.

## Operations And Tuning

The default worker configuration is:

- 3,072 MiB memory
- 1,024 MiB ephemeral storage
- 300-second Lambda timeout
- reserved concurrency and SQS maximum concurrency of `2`
- SQS visibility timeout of 1,800 seconds
- batch size `1` with partial batch failure reporting
- Chromium recycled after 20 jobs per warm environment

CloudWatch alarms cover queue age above five minutes, worker errors, worker throttles, worker p95 duration above 240 seconds, and every permanent DLQ failure. Structured logs and embedded metrics include browser launch, asset loading, PDF rendering, upload, total duration, image counts, PDF bytes, retries, cold starts, and remaining Lambda time.

For tuning, run representative documents containing 0, 10, and 50 images at each supported `WorkerMemorySize`. Keep the least expensive size where:

- all expected jobs complete reliably;
- p95 duration is below 180 seconds;
- peak memory stays below 75%;
- the DLQ remains empty for valid documents.

Run the included benchmark after deploying each memory setting:

```sh
PDF_API_URL=https://API_ID.execute-api.REGION.amazonaws.com/prod \
PDF_API_KEY=secret \
BENCHMARK_IMAGE_URL=https://cdn.example.com/benchmark.jpg \
BENCHMARK_ITERATIONS=5 \
pnpm benchmark
```

Use a representative same-Region image. Correlate the printed job IDs with Lambda `Duration` and `Max Memory Used` in CloudWatch.

Resize and compress images before submission and serve them from S3 or a CDN close to the Lambda Region. More memory gives Lambda more CPU and network capacity and can reduce both latency and billed duration for Chromium workloads.

## Legacy Endpoint

`POST /pdf/html` accepts the same payload and returns the signed URL synchronously. Responses include `Deprecation: true`. Migrate every caller to `/pdf/jobs`, observe the first migrated project for seven days, then migrate the remaining projects before removing the legacy route.

## License

MIT. See [LICENSE.txt](LICENSE.txt).
