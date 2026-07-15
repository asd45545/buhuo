#!/usr/bin/env node

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicDir = path.join(dashboardDir, "public");
const defaultStatusFile = path.resolve(
  process.env.LDXP_DASHBOARD_STATUS_FILE ||
    path.join(dashboardDir, "..", "data", "ldxp-monitor-status.json"),
);
const REFRESH_AFTER_MS = 15_000;
const MAX_REQUESTS_PER_MINUTE = 120;

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function jsonResponse(res, statusCode, payload, headers = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "private, no-store",
    ...headers,
  });
  res.end(body);
}

function applySecurityHeaders(res) {
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
}

function validBearerToken(req, expectedToken) {
  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(authorization.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function createRateLimiter(limit = MAX_REQUESTS_PER_MINUTE) {
  const clients = new Map();

  return function allow(req) {
    const now = Date.now();
    const key = req.socket.remoteAddress || "unknown";
    const current = clients.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      clients.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
}

async function loadSnapshot(file) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (parsed?.schemaVersion !== 1 || !parsed.monitor || !parsed.inventory) {
    throw new Error("invalid dashboard snapshot");
  }
  return parsed;
}

function validDateMs(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function calculateHealth(snapshot, now = Date.now()) {
  const intervalMs = Math.max(30_000, Number(snapshot.schedule?.intervalMs || 300_000));
  const lastSuccessMs = validDateMs(snapshot.monitor?.lastSuccessAt);
  const updatedMs = validDateMs(snapshot.updatedAt);
  const successAgeMs = lastSuccessMs === null ? null : Math.max(0, now - lastSuccessMs);
  const snapshotAgeMs = updatedMs === null ? null : Math.max(0, now - updatedMs);
  const lifecycle = snapshot.monitor?.lifecycle || "starting";
  const consecutiveFailures = Number(snapshot.monitor?.consecutiveFailures || 0);

  if (lifecycle === "stopped") {
    return { status: "down", reasonCode: "SERVICE_STOPPED", successAgeMs, snapshotAgeMs };
  }
  if (snapshotAgeMs === null || snapshotAgeMs > intervalMs * 3) {
    return { status: "down", reasonCode: "STATUS_STALE", successAgeMs, snapshotAgeMs };
  }
  if (lastSuccessMs === null) {
    if (consecutiveFailures > 0 || lifecycle === "degraded") {
      return { status: "degraded", reasonCode: "POLL_FAILURE", successAgeMs, snapshotAgeMs };
    }
    return { status: "starting", reasonCode: "AWAITING_FIRST_POLL", successAgeMs, snapshotAgeMs };
  }
  if (successAgeMs > intervalMs * 3) {
    return { status: "down", reasonCode: "STATUS_STALE", successAgeMs, snapshotAgeMs };
  }
  if (consecutiveFailures > 0 || successAgeMs > intervalMs * 1.5) {
    return { status: "degraded", reasonCode: "POLL_FAILURE", successAgeMs, snapshotAgeMs };
  }
  return {
    status: "healthy",
    reasonCode: lifecycle === "checking" ? "POLL_IN_PROGRESS" : "OK",
    successAgeMs,
    snapshotAgeMs,
  };
}

function buildOverview(snapshot, now = Date.now()) {
  const health = calculateHealth(snapshot, now);
  const startedMs = validDateMs(snapshot.process?.startedAt);
  const stoppedMs = validDateMs(snapshot.process?.stoppedAt);
  const uptimeEndMs = stoppedMs === null ? now : Math.min(now, stoppedMs);
  const inventory = snapshot.inventory || {};
  const categories = [...new Set(
    (inventory.products || [])
      .filter((item) => item.status !== "missing")
      .map((item) => item.category?.name)
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right, "zh-CN"));

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    refreshAfterMs: REFRESH_AFTER_MS,
    monitor: {
      status: health.status,
      reasonCode: health.reasonCode,
      activity: snapshot.monitor?.lifecycle || "unknown",
      service: {
        active: health.status !== "down",
        startedAt: snapshot.process?.startedAt || null,
        uptimeSeconds:
          startedMs === null ? 0 : Math.max(0, Math.floor((uptimeEndMs - startedMs) / 1000)),
        processStarts: Number(snapshot.process?.starts || 0),
      },
      schedule: {
        intervalMs: Number(snapshot.schedule?.intervalMs || 300_000),
        nextExpectedPollAt: snapshot.schedule?.nextExpectedPollAt || null,
      },
      lastPoll: snapshot.monitor?.lastPoll || null,
      lastSuccessAt: snapshot.monitor?.lastSuccessAt || null,
      consecutiveFailures: Number(snapshot.monitor?.consecutiveFailures || 0),
      lastError: snapshot.monitor?.lastError
        ? {
            code: String(snapshot.monitor.lastError.code || "UNKNOWN")
              .toUpperCase()
              .replace(/[^A-Z0-9_-]/g, "_")
              .slice(0, 64) || "UNKNOWN",
            at: validDateMs(snapshot.monitor.lastError.at) === null
              ? null
              : snapshot.monitor.lastError.at,
          }
        : null,
      transport: snapshot.monitor?.transport || "unknown",
      snapshotAgeMs: health.snapshotAgeMs,
    },
    inventory: {
      activeTotal: Number(inventory.activeTotal || 0),
      inStockTotal: Number(inventory.inStockTotal || 0),
      outOfStockTotal: Number(inventory.outOfStockTotal || 0),
      missingTotal: Number(inventory.missingTotal || 0),
      snapshotAt: inventory.snapshotAt || null,
      categories,
    },
    system: {
      uptimeSeconds: Math.floor(os.uptime()),
      loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
      memory: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
        usedPercent: Number((((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1)),
      },
    },
    recentPolls: (snapshot.recentPolls || []).slice(-48),
    recentRestocks: (snapshot.recentRestocks || []).slice(-20).reverse(),
  };
}

function parseInteger(value, fallback, min, max) {
  const number = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function compareProducts(sort) {
  if (sort === "name_asc") {
    return (left, right) => left.name.localeCompare(right.name, "zh-CN");
  }
  if (sort === "stock_desc") {
    return (left, right) => right.stock - left.stock || left.name.localeCompare(right.name, "zh-CN");
  }
  if (sort === "price_asc") {
    return (left, right) => left.price - right.price || left.name.localeCompare(right.name, "zh-CN");
  }
  return (left, right) =>
    (validDateMs(right.lastChangedAt) || 0) - (validDateMs(left.lastChangedAt) || 0) ||
    left.name.localeCompare(right.name, "zh-CN");
}

function buildProducts(snapshot, searchParams) {
  const status = searchParams.get("status") || "all";
  const query = (searchParams.get("q") || "").trim().toLocaleLowerCase("zh-CN").slice(0, 100);
  const category = (searchParams.get("category") || "").trim().slice(0, 120);
  const sort = searchParams.get("sort") || "changed_desc";
  const limit = parseInteger(searchParams.get("limit"), 25, 1, 100);
  const offset = parseInteger(searchParams.get("offset"), 0, 0, 100_000);
  const allowedStatuses = new Set(["all", "in_stock", "out_of_stock", "missing"]);
  const normalizedStatus = allowedStatuses.has(status) ? status : "all";
  const products = (snapshot.inventory?.products || [])
    .filter((item) => normalizedStatus === "all" || item.status === normalizedStatus)
    .filter((item) => !category || item.category?.name === category)
    .filter((item) => {
      if (!query) return true;
      return `${item.name} ${item.category?.name || ""}`.toLocaleLowerCase("zh-CN").includes(query);
    })
    .sort(compareProducts(sort));

  return {
    data: products.slice(offset, offset + limit),
    page: {
      total: products.length,
      limit,
      offset,
      nextOffset: offset + limit < products.length ? offset + limit : null,
    },
  };
}

function safeStaticPath(publicDir, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const normalized = path.normalize(requested);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
  const resolved = path.resolve(publicDir, normalized);
  return resolved.startsWith(`${path.resolve(publicDir)}${path.sep}`) ? resolved : null;
}

function createDashboardServer(options = {}) {
  const token = String(options.token || process.env.LDXP_DASHBOARD_TOKEN || "");
  const statusFile = path.resolve(options.statusFile || defaultStatusFile);
  const publicDir = path.resolve(options.publicDir || defaultPublicDir);
  const allowRequest = createRateLimiter(options.rateLimit || MAX_REQUESTS_PER_MINUTE);

  if (token.length < 24 || token === "replace-with-at-least-32-random-characters") {
    throw new Error("LDXP_DASHBOARD_TOKEN must contain at least 24 characters");
  }

  return createServer(async (req, res) => {
    applySecurityHeaders(res);
    let url;
    try {
      url = new URL(req.url || "/", "http://dashboard.local");
    } catch {
      jsonResponse(res, 400, { ok: false, error: "invalid_request_target" });
      return;
    }

    if (!new Set(["GET", "HEAD"]).has(req.method || "GET")) {
      jsonResponse(res, 405, { ok: false, error: "method_not_allowed" }, { allow: "GET, HEAD" });
      return;
    }

    if (url.pathname === "/healthz") {
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!allowRequest(req)) {
        jsonResponse(res, 429, { ok: false, error: "rate_limited" }, { "retry-after": "60" });
        return;
      }
      if (!validBearerToken(req, token)) {
        jsonResponse(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      try {
        const snapshot = await loadSnapshot(statusFile);
        if (url.pathname === "/api/v1/dashboard/overview") {
          jsonResponse(res, 200, buildOverview(snapshot));
          return;
        }
        if (url.pathname === "/api/v1/dashboard/products") {
          jsonResponse(res, 200, buildProducts(snapshot, url.searchParams));
          return;
        }
        if (url.pathname === "/api/v1/dashboard/polls") {
          const limit = parseInteger(url.searchParams.get("limit"), 48, 1, 48);
          jsonResponse(res, 200, { data: (snapshot.recentPolls || []).slice(-limit).reverse() });
          return;
        }
        if (url.pathname === "/api/v1/dashboard/restocks") {
          const limit = parseInteger(url.searchParams.get("limit"), 20, 1, 30);
          jsonResponse(res, 200, { data: (snapshot.recentRestocks || []).slice(-limit).reverse() });
          return;
        }
        jsonResponse(res, 404, { ok: false, error: "not_found" });
      } catch (error) {
        console.error(`DASHBOARD_SNAPSHOT_ERROR message=${error.message}`);
        jsonResponse(res, 503, { ok: false, error: "snapshot_unavailable" });
      }
      return;
    }

    const file = safeStaticPath(publicDir, url.pathname);
    if (!file) {
      jsonResponse(res, 404, { ok: false, error: "not_found" });
      return;
    }

    try {
      const body = await readFile(file);
      const extension = path.extname(file).toLowerCase();
      res.writeHead(200, {
        "content-type": contentTypes.get(extension) || "application/octet-stream",
        "content-length": body.length,
        "cache-control": extension === ".html" ? "no-cache" : "public, max-age=300",
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`DASHBOARD_STATIC_ERROR message=${error.message}`);
      jsonResponse(res, 404, { ok: false, error: "not_found" });
    }
  });
}

async function main() {
  const host = process.env.LDXP_DASHBOARD_HOST || "127.0.0.1";
  const port = parseInteger(process.env.LDXP_DASHBOARD_PORT, 8787, 1, 65_535);
  const server = createDashboardServer();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`DASHBOARD_STARTED host=${host} port=${port}`);

  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export { buildOverview, buildProducts, calculateHealth, createDashboardServer, loadSnapshot };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`DASHBOARD_ERROR message=${error.message}`);
    process.exitCode = 1;
  });
}
