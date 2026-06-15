import assert from "node:assert/strict";
import test from "node:test";
import { createUrlPolicy, isPrivateAddress } from "../lib/network-security.mjs";
import { validatePdfRequest } from "../lib/validation.mjs";

test("validates and normalizes a PDF request", () => {
  assert.deepEqual(validatePdfRequest({ html: "<h1>Hello</h1>" }), {
    html: "<h1>Hello</h1>",
    fileName: "sample-document.pdf",
    inlinePdf: false,
    options: {},
  });
});

test("rejects HTML larger than 5 MiB", () => {
  assert.throws(
    () => validatePdfRequest({ html: "x".repeat(5 * 1024 * 1024 + 1) }),
    /5 MiB/,
  );
});

test("identifies private IPv4 and IPv6 addresses", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("10.0.0.8"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("fd00::1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("URL policy blocks private DNS answers and allows public assets", async () => {
  const privatePolicy = createUrlPolicy({
    lookup: async () => [{ address: "10.0.0.2", family: 4 }],
  });
  await assert.rejects(
    privatePolicy.assertAllowed("https://internal.example/image.png"),
    /Private network/,
  );

  const publicPolicy = createUrlPolicy({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  await publicPolicy.assertAllowed("https://cdn.example/image.png");
});

test("URL policy bounds data URLs", async () => {
  const policy = createUrlPolicy();
  await policy.assertAllowed("data:image/png;base64,AAAA");
  await assert.rejects(
    policy.assertAllowed(`data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`),
    /2 MiB/,
  );
});
