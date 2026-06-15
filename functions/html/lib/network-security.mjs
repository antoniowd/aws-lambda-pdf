import dns from "node:dns/promises";
import net from "node:net";
import { MAX_DATA_URL_BYTES } from "./constants.mjs";

const parseIpv4 = (address) => {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return parts;
};

const isPrivateIpv4 = (address) => {
  const parts = parseIpv4(address);
  if (!parts) return true;
  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

const isPrivateIpv6 = (address) => {
  const normalized = address.toLowerCase().split("%")[0];
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  ) {
    return true;
  }

  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
};

export const isPrivateAddress = (address) => {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
};

const getDataUrlSize = (url) => {
  const commaIndex = url.indexOf(",");
  if (commaIndex < 0) return Number.POSITIVE_INFINITY;
  const metadata = url.slice(0, commaIndex);
  const data = url.slice(commaIndex + 1);
  return metadata.includes(";base64")
    ? Math.floor((data.length * 3) / 4)
    : Buffer.byteLength(decodeURIComponent(data), "utf8");
};

export const createUrlPolicy = ({ lookup = dns.lookup } = {}) => {
  const hostnameCache = new Map();

  const assertAllowed = async (rawUrl) => {
    if (rawUrl === "about:blank") return;

    if (rawUrl.startsWith("data:")) {
      if (getDataUrlSize(rawUrl) > MAX_DATA_URL_BYTES) {
        throw new Error("Data URL exceeds the 2 MiB asset limit");
      }
      return;
    }

    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("Asset URL is invalid");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Asset protocol ${url.protocol} is not allowed`);
    }

    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw new Error("Private network assets are not allowed");
    }

    let addressesPromise = hostnameCache.get(hostname);
    if (!addressesPromise) {
      addressesPromise = net.isIP(hostname)
        ? Promise.resolve([{ address: hostname }])
        : lookup(hostname, { all: true, verbatim: true });
      hostnameCache.set(hostname, addressesPromise);
    }

    const addresses = await addressesPromise;
    if (
      !Array.isArray(addresses) ||
      addresses.length === 0 ||
      addresses.some(({ address }) => isPrivateAddress(address))
    ) {
      throw new Error("Private network assets are not allowed");
    }
  };

  return { assertAllowed };
};

export const securePageRequests = async (page, options = {}) => {
  const policy = createUrlPolicy(options);
  const pendingAssets = new Set();
  const failedAssets = [];

  await page.setRequestInterception(true);

  page.on("request", (request) => {
    const isAsset = ["image", "font"].includes(request.resourceType());
    if (isAsset) pendingAssets.add(request);

    void policy
      .assertAllowed(request.url())
      .then(() => request.continue())
      .catch(async (error) => {
        failedAssets.push({ url: request.url(), reason: error.message });
        pendingAssets.delete(request);
        await request.abort("blockedbyclient").catch(() => {});
      });
  });

  page.on("requestfinished", (request) => {
    pendingAssets.delete(request);
  });
  page.on("requestfailed", (request) => {
    if (pendingAssets.delete(request)) {
      failedAssets.push({
        url: request.url(),
        reason: request.failure()?.errorText ?? "Request failed",
      });
    }
  });
  page.on("response", (response) => {
    if (
      ["image", "font"].includes(response.request().resourceType()) &&
      response.status() >= 400
    ) {
      failedAssets.push({
        url: response.url(),
        reason: `HTTP ${response.status()}`,
      });
    }
  });

  return { pendingAssets, failedAssets };
};
