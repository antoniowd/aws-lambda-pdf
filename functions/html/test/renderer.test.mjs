import assert from "node:assert/strict";
import test from "node:test";
import { createRenderer, PdfGenerationError } from "../lib/renderer.mjs";
import { createContext } from "./helpers.mjs";

const createFakePage = (domState = {}) => {
  const handlers = new Map();
  let closed = false;
  return {
    setRequestInterception: async () => {},
    on: (name, handler) => handlers.set(name, handler),
    setContent: async () => {},
    evaluate: async () => ({
      totalImages: 0,
      loadedImages: 0,
      failedImages: 0,
      fontsReady: true,
      ...domState,
    }),
    pdf: async (options) => {
      assert.equal(options.format, "A4");
      return Buffer.from("pdf");
    },
    close: async () => {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
};

const createFakeBrowser = (pages) => {
  let connected = true;
  let closeCount = 0;
  return {
    get connected() {
      return connected;
    },
    newPage: async () => pages.shift(),
    pages: async () => [],
    once: () => {},
    close: async () => {
      connected = false;
      closeCount += 1;
    },
    get closeCount() {
      return closeCount;
    },
  };
};

test("renderer reuses Chromium and recycles it after the configured job count", async () => {
  const pages = [createFakePage(), createFakePage(), createFakePage()];
  const browsers = [];
  let launches = 0;
  const puppeteer = {
    defaultArgs: async () => [],
    launch: async () => {
      launches += 1;
      const browser = createFakeBrowser(pages);
      browsers.push(browser);
      return browser;
    },
  };
  const chromium = { args: [], executablePath: async () => "/chromium" };
  const renderer = createRenderer({
    puppeteer,
    chromium,
    maxBrowserJobs: 2,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });

  await renderer.render({ html: "one", context: createContext() });
  await renderer.render({ html: "two", context: createContext() });
  assert.equal(launches, 1);
  assert.equal(browsers[0].closeCount, 1);

  await renderer.render({ html: "three", context: createContext() });
  assert.equal(launches, 2);
  await renderer.closeBrowser();
});

test("renderer fails when a required image is broken and still closes the page", async () => {
  const page = createFakePage({
    totalImages: 1,
    loadedImages: 0,
    failedImages: 1,
  });
  const browser = createFakeBrowser([page]);
  const renderer = createRenderer({
    puppeteer: {
      defaultArgs: async () => [],
      launch: async () => browser,
    },
    chromium: { args: [], executablePath: async () => "/chromium" },
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });

  await assert.rejects(
    renderer.render({ html: "<img>", context: createContext() }),
    (error) =>
      error instanceof PdfGenerationError && error.code === "ASSET_LOAD_FAILED",
  );
  assert.equal(page.closed, true);
  await renderer.closeBrowser();
});

test("renderer reports an asset timeout", async () => {
  const page = createFakePage({
    totalImages: 1,
    loadedImages: 0,
    failedImages: 0,
    fontsReady: false,
  });
  const browser = createFakeBrowser([page]);
  const renderer = createRenderer({
    puppeteer: {
      defaultArgs: async () => [],
      launch: async () => browser,
    },
    chromium: { args: [], executablePath: async () => "/chromium" },
  });

  await assert.rejects(
    renderer.render({
      html: "<img>",
      options: { assetTimeoutMs: 1_000 },
      context: createContext(),
    }),
    (error) =>
      error.code === "ASSET_LOAD_FAILED" && error.details.timedOut === true,
  );
  await renderer.closeBrowser();
});
