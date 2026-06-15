# Integrating The Asynchronous PDF API

This guide migrates an application from synchronous `POST /pdf/html` calls to the SQS-backed job API.

## Configuration

Provide these environment variables to each consuming project:

```text
PDF_API_URL=https://API_ID.execute-api.REGION.amazonaws.com/prod
PDF_API_KEY=your-api-key
```

Keep `PDF_API_KEY` server-side. Browsers and mobile clients should call your application backend rather than the PDF API directly.

## Request Flow

1. Build the complete HTML and ensure remote images are publicly reachable.
2. Submit `POST $PDF_API_URL/pdf/jobs` with `x-api-key` and a stable `idempotency-key`.
3. Persist the returned `jobId` if the application request can outlive the current process.
4. Poll `statusUrl` with exponential backoff and jitter.
5. On `completed`, use or return the signed `url` before its one-hour expiry.
6. On `failed`, store the error code and stop polling.
7. Stop polling after the application's own deadline; the server job can still finish within its 24-hour retention window.

## Node.js Example

```js
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestPdf({ html, fileName, inlinePdf = false, options = {}, idempotencyKey }) {
  const response = await fetch(`${process.env.PDF_API_URL}/pdf/jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.PDF_API_KEY,
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ html, fileName, inlinePdf, options }),
  });

  const body = await response.json();
  if (response.status !== 202) {
    throw new Error(`${body.error?.code ?? "PDF_SUBMIT_FAILED"}: ${body.error?.message}`);
  }

  return body;
}

async function waitForPdf(statusUrl, { timeoutMs = 5 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 1_000;

  while (Date.now() < deadline) {
    const response = await fetch(statusUrl, {
      headers: { "x-api-key": process.env.PDF_API_KEY },
    });
    const job = await response.json();

    if (response.status === 404) {
      throw new Error("PDF_JOB_NOT_FOUND: the job expired or does not exist");
    }
    if (!response.ok) {
      throw new Error(`${job.error?.code ?? "PDF_STATUS_FAILED"}: ${job.error?.message}`);
    }
    if (job.status === "completed") return job;
    if (job.status === "failed") {
      throw new Error(`${job.error.code}: ${job.error.message}`);
    }

    const jitter = Math.floor(Math.random() * 250);
    await sleep(delayMs + jitter);
    delayMs = Math.min(Math.round(delayMs * 1.7), 10_000);
  }

  throw new Error("PDF_POLL_TIMEOUT: generation is still running");
}

export async function generatePdf(input) {
  const job = await requestPdf(input);
  return waitForPdf(job.statusUrl);
}
```

Use a business identifier for `idempotencyKey`, such as `invoice:123:revision:2`. Retrying the same payload with the same key returns the original job. Reusing that key with different content returns `409 IDEMPOTENCY_CONFLICT`.

## Curl Example

```sh
JOB_JSON=$(curl -sS -X POST "$PDF_API_URL/pdf/jobs" \
  -H "x-api-key: $PDF_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: report-2026-06-13" \
  -d '{"html":"<h1>Report</h1>","fileName":"report.pdf"}')

JOB_ID=$(printf '%s' "$JOB_JSON" | jq -r .jobId)

curl -sS \
  -H "x-api-key: $PDF_API_KEY" \
  "$PDF_API_URL/pdf/jobs/$JOB_ID"
```

## Error Handling

Submission errors:

- `INVALID_JSON`: body is not valid JSON.
- `VALIDATION_ERROR`: HTML, filename, options, or idempotency key is invalid.
- `IDEMPOTENCY_CONFLICT`: a key was reused with different content.

Terminal job errors:

- `ASSET_LOAD_FAILED`: at least one required image or font failed, was blocked, or timed out.
- `INPUT_READ_FAILED`: the stored input could not be read.
- `RENDER_FAILED`: Chromium or PDF serialization failed.
- `MAX_ATTEMPTS_EXCEEDED`: the job exhausted retries without a more specific stored error.

Do not automatically create a new idempotency key after a terminal failure unless the input or its asset availability has changed. Otherwise the application can create an unbounded stream of identical failing jobs.

## Migration Checklist

- Add `PDF_API_URL` and `PDF_API_KEY` to the project's secret configuration.
- Replace the synchronous URL call with submit plus polling.
- Generate a stable idempotency key for each logical PDF version.
- Ensure request handlers no longer wait synchronously when the user workflow permits background processing.
- Persist `jobId` when polling may continue in another process or request.
- Handle all four job statuses explicitly.
- Treat the signed URL as temporary and avoid storing it as the permanent PDF identifier.
- Resize large source images and move private images to accessible signed/public URLs before submission.
- Add application metrics for submission failures, completion latency, terminal errors, and poll timeouts.
- Migrate one project first and observe it for seven days before moving the remaining callers.

## Troubleshooting

`queued` for more than five minutes:

- Check the `QueueAgeAlarm`, worker reserved concurrency, Lambda throttles, and SQS queue depth.

Repeated `ASSET_LOAD_FAILED`:

- Confirm every image returns `2xx` without authentication from the Lambda network.
- Check redirects and DNS results; private, loopback, link-local, and metadata addresses are intentionally blocked.
- Reduce image dimensions and byte size, and increase `options.assetTimeoutMs` only when the origin is expected to be slow.

`processing` for a long time:

- Inspect worker duration and remaining-time metrics.
- Check for large decoded images, slow fonts, or Chromium memory pressure.
- Compare 3,072 and 4,096 MiB worker settings with the representative benchmark set.

Job returns `404`:

- Job metadata is unavailable or its 24-hour retention window has elapsed. Submit a new job with a new idempotency key.
