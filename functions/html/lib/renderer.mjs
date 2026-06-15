import {
  DEFAULT_ASSET_TIMEOUT_MS,
  ERROR_CODES,
  MAX_ASSET_TIMEOUT_MS,
  MAX_BROWSER_JOBS,
  RENDER_TIME_RESERVE_MS,
} from "./constants.mjs";
import { securePageRequests } from "./network-security.mjs";

const elapsedMs = (startedAt) => Date.now() - startedAt;

export class PdfGenerationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PdfGenerationError";
    this.code = code;
    this.details = details;
  }
}

const getAssetTimeout = ({ options, context, defaultTimeout, maxTimeout, reserve }) => {
  const requested = Number(options?.assetTimeoutMs);
  const configured = Number.isFinite(requested) ? requested : defaultTimeout;
  const remaining = context?.getRemainingTimeInMillis?.() ?? maxTimeout + reserve;
  return Math.max(1_000, Math.min(configured, maxTimeout, remaining - reserve));
};

const waitForAssets = async (page, networkState, timeoutMs) => {
  const startedAt = Date.now();
  let domState = null;
  let timedOut = false;

  while (elapsedMs(startedAt) < timeoutMs) {
    domState = await page.evaluate(async () => {
      const images = Array.from(document.images);
      const fontsReady = document.fonts?.status === "loaded";
      return {
        totalImages: images.length,
        loadedImages: images.filter((image) => image.complete && image.naturalWidth > 0)
          .length,
        failedImages: images.filter(
          (image) => image.complete && image.naturalWidth === 0,
        ).length,
        fontsReady,
      };
    });

    const imagesSettled =
      domState.loadedImages + domState.failedImages === domState.totalImages;
    if (imagesSettled && domState.fontsReady && networkState.pendingAssets.size === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!domState) {
    domState = { totalImages: 0, loadedImages: 0, failedImages: 0, fontsReady: false };
  }

  if (
    elapsedMs(startedAt) >= timeoutMs &&
    (!domState.fontsReady ||
      domState.loadedImages + domState.failedImages < domState.totalImages ||
      networkState.pendingAssets.size > 0)
  ) {
    timedOut = true;
  }

  return {
    totalImages: domState.totalImages,
    loadedImages: domState.loadedImages,
    failedImages: domState.failedImages,
    requestFailures: networkState.failedAssets.length,
    pendingRequests: networkState.pendingAssets.size,
    timedOut,
  };
};

const pdfOptions = (options = {}) => ({
  format: options.format ?? "A4",
  printBackground: options.printBackground ?? true,
  displayHeaderFooter: options.displayHeaderFooter ?? false,
  margin: {
    top: options.marginTop ?? "20px",
    right: options.marginRight ?? "20px",
    bottom: options.marginBottom ?? "20px",
    left: options.marginLeft ?? "20px",
  },
  headerTemplate: options.headerTemplate ?? "",
  footerTemplate: options.footerTemplate ?? "",
  landscape: options.landscape ?? false,
  scale: options.scale ?? 1,
  pageRanges: options.pageRanges ?? "",
  width: options.width || undefined,
  height: options.height || undefined,
  preferCSSPageSize: options.preferCSSPageSize ?? false,
  omitBackground: options.omitBackground ?? false,
});

export const createRenderer = ({
  puppeteer,
  chromium,
  reuseBrowser = true,
  maxBrowserJobs = MAX_BROWSER_JOBS,
  lookup,
} = {}) => {
  let browser = null;
  let jobsInBrowser = 0;

  const closeBrowser = async () => {
    const current = browser;
    browser = null;
    jobsInBrowser = 0;
    if (!current) return;
    for (const page of await current.pages().catch(() => [])) {
      await page.close().catch(() => {});
    }
    let closeTimer;
    try {
      await Promise.race([
        current.close(),
        new Promise((resolve) => {
          closeTimer = setTimeout(resolve, 5_000);
        }),
      ]);
    } catch {
      // The execution environment will reclaim a browser that cannot close cleanly.
    } finally {
      clearTimeout(closeTimer);
    }
  };

  const getBrowser = async () => {
    if (browser?.connected) return { browser, launched: false };

    const args = puppeteer.defaultArgs
      ? await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" })
      : chromium.args;
    browser = await puppeteer.launch({
      args,
      defaultViewport: chromium.defaultViewport ?? {
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
      },
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });
    jobsInBrowser = 0;
    browser.once?.("disconnected", () => {
      browser = null;
      jobsInBrowser = 0;
    });
    return { browser, launched: true };
  };

  const render = async ({
    html,
    options = {},
    context,
    strictAssets = true,
    defaultAssetTimeoutMs = DEFAULT_ASSET_TIMEOUT_MS,
    maxAssetTimeoutMs = MAX_ASSET_TIMEOUT_MS,
    reserveTimeMs = RENDER_TIME_RESERVE_MS,
  }) => {
    const startedAt = Date.now();
    let page;
    let launched = false;

    try {
      const browserResult = await getBrowser();
      launched = browserResult.launched;
      const browserLaunchMs = elapsedMs(startedAt);
      page = await browserResult.browser.newPage();
      const networkState = await securePageRequests(page, { lookup });

      await page.setContent(html, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(
          1_000,
          Math.min(15_000, context?.getRemainingTimeInMillis?.() ?? 15_000),
        ),
      });

      const assetStartedAt = Date.now();
      const assetTimeoutMs = getAssetTimeout({
        options,
        context,
        defaultTimeout: defaultAssetTimeoutMs,
        maxTimeout: maxAssetTimeoutMs,
        reserve: reserveTimeMs,
      });
      const assets = await waitForAssets(page, networkState, assetTimeoutMs);
      const assetLoadMs = elapsedMs(assetStartedAt);

      if (
        strictAssets &&
        (assets.timedOut ||
          assets.failedImages > 0 ||
          assets.requestFailures > 0 ||
          assets.loadedImages < assets.totalImages)
      ) {
        throw new PdfGenerationError(
          ERROR_CODES.ASSET_LOAD_FAILED,
          "One or more PDF assets failed to load",
          assets,
        );
      }

      const renderStartedAt = Date.now();
      const buffer = await page.pdf(pdfOptions(options));
      const pdfRenderMs = elapsedMs(renderStartedAt);
      jobsInBrowser += 1;

      return {
        buffer,
        assets,
        timings: {
          browserLaunchMs,
          assetLoadMs,
          pdfRenderMs,
          totalRenderMs: elapsedMs(startedAt),
        },
        coldBrowser: launched,
      };
    } catch (error) {
      if (error instanceof PdfGenerationError) throw error;
      throw new PdfGenerationError(
        ERROR_CODES.RENDER_FAILED,
        "PDF rendering failed",
        { cause: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      await page?.close().catch(() => {});
      if (!reuseBrowser || jobsInBrowser >= maxBrowserJobs || !browser?.connected) {
        await closeBrowser();
      }
    }
  };

  return { render, closeBrowser };
};
