import { randomUUID } from "node:crypto";

const apiUrl = process.env.PDF_API_URL?.replace(/\/$/, "");
const apiKey = process.env.PDF_API_KEY;
const imageUrl = process.env.BENCHMARK_IMAGE_URL;
const iterations = Number(process.env.BENCHMARK_ITERATIONS ?? 5);
const imageCounts = [0, 10, 50];

if (!apiUrl || !apiKey || !imageUrl) {
  throw new Error(
    "PDF_API_URL, PDF_API_KEY, and BENCHMARK_IMAGE_URL are required",
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getImageUrl = (index) => {
  const url = new URL(imageUrl);
  url.searchParams.set("copy", String(index));
  return url.toString();
};

const buildHtml = (imageCount) => `
<!doctype html>
<html>
  <body>
    <h1>PDF benchmark: ${imageCount} images</h1>
    ${Array.from(
      { length: imageCount },
      (_, index) => `<img src="${getImageUrl(index)}" width="600">`,
    ).join("\n")}
  </body>
</html>`;

const submit = async (imageCount) => {
  const response = await fetch(`${apiUrl}/pdf/jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "idempotency-key": `benchmark:${imageCount}:${randomUUID()}`,
    },
    body: JSON.stringify({
      html: buildHtml(imageCount),
      fileName: `benchmark-${imageCount}.pdf`,
    }),
  });
  const body = await response.json();
  if (response.status !== 202) throw new Error(JSON.stringify(body));
  return body;
};

const waitForCompletion = async (statusUrl) => {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(statusUrl, {
      headers: { "x-api-key": apiKey },
    });
    const job = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(job));
    if (job.status === "completed" || job.status === "failed") return job;
    await sleep(1_000);
  }
  throw new Error(`Benchmark job timed out: ${statusUrl}`);
};

const results = [];
for (const imageCount of imageCounts) {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const startedAt = Date.now();
    const submitted = await submit(imageCount);
    const job = await waitForCompletion(submitted.statusUrl);
    results.push({
      imageCount,
      iteration,
      jobId: job.jobId,
      status: job.status,
      attempts: job.attempts,
      elapsedMs: Date.now() - startedAt,
      assets: job.assets,
      error: job.error,
    });
    console.log(JSON.stringify(results.at(-1)));
  }
}

const successful = results.filter(({ status }) => status === "completed");
const sortedDurations = successful.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
const p95Index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1);
console.log(
  JSON.stringify({
    summary: {
      total: results.length,
      completed: successful.length,
      failed: results.length - successful.length,
      p95ElapsedMs: sortedDurations[p95Index] ?? null,
    },
  }),
);
