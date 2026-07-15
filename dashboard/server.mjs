#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LoginSecurityStore,
  parseCookies,
  passwordHashVersion,
  parsePasswordHash,
  requestClientIp,
  sessionCookie,
  verifyDashboardPassword,
} from "./auth.mjs";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicDir = path.join(dashboardDir, "public");
const defaultStatusFile = path.resolve(
  process.env.LDXP_DASHBOARD_STATUS_FILE ||
    path.join(dashboardDir, "..", "data", "ldxp-monitor-status.json"),
);
const defaultSecurityFile = path.resolve(
  process.env.LDXP_DASHBOARD_SECURITY_FILE ||
    path.join(dashboardDir, "..", "data", "ldxp-dashboard-security.json"),
);
const REFRESH_AFTER_MS = 15_000;
const MAX_REQUESTS_PER_MINUTE = 120;
const DEFAULT_INVENTORY_API_REQUESTS_PER_MINUTE = 120;
const INVENTORY_API_PATH = "/api/v1/inventory";
const DEFAULT_SESSION_COOKIE_NAME = "__Secure-ldxp_session";
const DEFAULT_SESSION_COOKIE_PATH = "/stock-monitor/";

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

function emptyResponse(res, statusCode, headers = {}) {
  res.writeHead(statusCode, {
    "cache-control": "private, no-store",
    ...headers,
  });
  res.end();
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

function createRateLimiter(limit = MAX_REQUESTS_PER_MINUTE) {
  const clients = new Map();

  return function allow(key) {
    const now = Date.now();
    if (clients.size >= 5_000) {
      for (const [client, entry] of clients) {
        if (now - entry.startedAt >= 60_000) clients.delete(client);
      }
      if (clients.size >= 5_000 && !clients.has(key)) return false;
    }
    const current = clients.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      clients.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
}

function validatePublicOrigin(value, allowHttp = false) {
  const origin = String(value || "");
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("LDXP_DASHBOARD_PUBLIC_ORIGIN must be an absolute origin");
  }
  if (parsed.origin !== origin || !["https:", ...(allowHttp ? ["http:"] : [])].includes(parsed.protocol)) {
    throw new Error("LDXP_DASHBOARD_PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
  return origin;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseOriginAllowlist(value) {
  const entries = (Array.isArray(value) ? value : String(value || "").split(","))
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const unique = [...new Set(entries)];
  if (unique.includes("*")) {
    if (unique.length !== 1) {
      throw new Error("inventory API origin wildcard cannot be combined with exact origins");
    }
    return { allowAny: true, origins: new Set() };
  }

  for (const origin of unique) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("invalid inventory API allowed origin");
    }
    if (parsed.origin !== origin || parsed.protocol !== "https:") {
      throw new Error("invalid inventory API allowed origin");
    }
  }
  return { allowAny: false, origins: new Set(unique) };
}

function inventoryCors(req, allowlist) {
  const header = req.headers.origin;
  if (Array.isArray(header)) return { allowed: false, headers: {} };
  const origin = String(header || "");
  if (!origin) return { allowed: true, headers: {} };
  if (allowlist.allowAny) {
    return { allowed: true, headers: { "access-control-allow-origin": "*" } };
  }
  if (!allowlist.origins.has(origin)) return { allowed: false, headers: {} };
  return {
    allowed: true,
    headers: { "access-control-allow-origin": origin, vary: "Origin" },
  };
}

function validInventoryApiKey(req, expectedHash) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!match) return false;
  const actual = createHash("sha256").update(match[1], "utf8").digest();
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

async function readJsonBody(req, maxBytes = 2_048) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim();
  if (contentType !== "application/json") {
    const error = new Error("content type must be application/json");
    error.statusCode = 415;
    error.publicCode = "unsupported_media_type";
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("request body too large");
      error.statusCode = 413;
      error.publicCode = "payload_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("invalid JSON body");
    error.statusCode = 400;
    error.publicCode = "invalid_json";
    throw error;
  }
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

function buildInventoryApi(snapshot, now = Date.now()) {
  const inventory = snapshot.inventory || {};
  const health = calculateHealth(snapshot, now);
  const items = (inventory.products || [])
    .filter((item) => item.status === "in_stock" || item.status === "out_of_stock")
    .map((item) => {
      const stockValue = Number(item.stock);
      const priceValue = Number(item.price);
      const categoryIdValue = Number(item.category?.id);
      const stock = Number.isFinite(stockValue) ? Math.max(0, Math.trunc(stockValue)) : 0;
      let url = null;
      try {
        const parsed = new URL(String(item.link || ""));
        if (
          parsed.origin === "https://pay.ldxp.cn" &&
          parsed.pathname.startsWith("/item/") &&
          !parsed.username &&
          !parsed.password
        ) {
          parsed.search = "";
          parsed.hash = "";
          url = parsed.href;
        }
      } catch {
        url = null;
      }
      return {
        id: String(item.key || "").slice(0, 160),
        name: String(item.name || "").slice(0, 300),
        url,
        category: {
          id: Number.isFinite(categoryIdValue) ? Math.max(0, Math.trunc(categoryIdValue)) : 0,
          name: String(item.category?.name || "未分类").slice(0, 120),
        },
        price: Number.isFinite(priceValue) ? Math.max(0, priceValue) : 0,
        stock,
        status: stock > 0 ? "in_stock" : "out_of_stock",
        lastChangedAt:
          validDateMs(item.lastChangedAt) === null
            ? null
            : new Date(validDateMs(item.lastChangedAt)).toISOString(),
      };
    })
    .filter((item) => item.id);

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    snapshotAt: inventory.snapshotAt || null,
    source: {
      status: health.status,
      lastSuccessAt: snapshot.monitor?.lastSuccessAt || null,
      ageMs: health.successAgeMs,
    },
    summary: {
      total: items.length,
      inStock: items.filter((item) => item.status === "in_stock").length,
      outOfStock: items.filter((item) => item.status === "out_of_stock").length,
    },
    items,
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
  const passwordHash = String(
    options.passwordHash || process.env.LDXP_DASHBOARD_PASSWORD_HASH || "",
  );
  const statusFile = path.resolve(options.statusFile || defaultStatusFile);
  const securityFile = path.resolve(options.securityFile || defaultSecurityFile);
  const publicDir = path.resolve(options.publicDir || defaultPublicDir);
  const trustProxy = options.trustProxy ?? booleanValue(process.env.LDXP_DASHBOARD_TRUST_PROXY);
  const secureCookie =
    options.secureCookie ?? booleanValue(process.env.LDXP_DASHBOARD_SECURE_COOKIE, true);
  const publicOrigin = validatePublicOrigin(
    options.publicOrigin || process.env.LDXP_DASHBOARD_PUBLIC_ORIGIN || "",
    !secureCookie,
  );
  const cookieName = String(
    options.cookieName || process.env.LDXP_DASHBOARD_COOKIE_NAME || DEFAULT_SESSION_COOKIE_NAME,
  );
  const cookiePath = String(
    options.cookiePath ||
      process.env.LDXP_DASHBOARD_COOKIE_PATH ||
      DEFAULT_SESSION_COOKIE_PATH,
  );
  const sessionTtlMs = parseInteger(
    options.sessionTtlMs || process.env.LDXP_DASHBOARD_SESSION_TTL_MS,
    30 * 24 * 60 * 60 * 1000,
    60_000,
    90 * 24 * 60 * 60 * 1000,
  );
  const inventoryApiKeyHash = String(
    options.inventoryApiKeyHash || process.env.LDXP_INVENTORY_API_KEY_HASH || "",
  ).toLowerCase();
  const inventoryApiAllowedOrigins = parseOriginAllowlist(
    options.inventoryApiAllowedOrigins ??
      process.env.LDXP_INVENTORY_API_ALLOWED_ORIGINS ??
      "",
  );
  const now = options.now || Date.now;
  const security = options.security || new LoginSecurityStore(securityFile, {
    maxFailures: parseInteger(
      options.maxFailures || process.env.LDXP_DASHBOARD_MAX_FAILURES,
      3,
      2,
      10,
    ),
    banMs: parseInteger(
      options.banMs || process.env.LDXP_DASHBOARD_BAN_MS,
      24 * 60 * 60 * 1000,
      60_000,
      365 * 24 * 60 * 60 * 1000,
    ),
    now,
  });
  const allowRequest = createRateLimiter(options.rateLimit || MAX_REQUESTS_PER_MINUTE);
  const allowInventoryApiRequest = createRateLimiter(
    parseInteger(
      options.inventoryApiRateLimit || process.env.LDXP_INVENTORY_API_RATE_LIMIT,
      DEFAULT_INVENTORY_API_REQUESTS_PER_MINUTE,
      10,
      10_000,
    ),
  );

  parsePasswordHash(passwordHash);
  const sessionVersion = passwordHashVersion(passwordHash);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cookieName)) {
    throw new Error("invalid dashboard cookie name");
  }
  if (inventoryApiKeyHash && !/^[a-f0-9]{64}$/.test(inventoryApiKeyHash)) {
    throw new Error("LDXP_INVENTORY_API_KEY_HASH must be a SHA-256 hex digest");
  }
  if (cookieName.startsWith("__Secure-") && !secureCookie) {
    throw new Error("__Secure- dashboard cookies require Secure");
  }
  if (cookieName.startsWith("__Host-") && (!secureCookie || cookiePath !== "/")) {
    throw new Error("__Host- dashboard cookies require Secure and Path=/");
  }

  function sessionToken(req) {
    return parseCookies(req.headers.cookie).get(cookieName);
  }

  function currentSession(req) {
    return security.sessionStatus(sessionToken(req), sessionVersion);
  }

  function validMutationOrigin(req) {
    return String(req.headers.origin || "") === publicOrigin;
  }

  function banResponse(res, ban) {
    const retryAfter = Math.max(
      1,
      Math.ceil((Date.parse(ban.bannedUntil) - Number(now())) / 1000),
    );
    jsonResponse(
      res,
      429,
      {
        ok: false,
        error: "ip_blocked",
        blockedUntil: ban.bannedUntil,
        retryAfterSeconds: retryAfter,
      },
      { "retry-after": String(retryAfter) },
    );
  }

  return createServer(async (req, res) => {
    applySecurityHeaders(res);
    try {
      let url;
      try {
      url = new URL(req.url || "/", "http://dashboard.local");
      } catch {
        jsonResponse(res, 400, { ok: false, error: "invalid_request_target" });
        return;
      }

    if (url.pathname === "/healthz") {
      if (!new Set(["GET", "HEAD"]).has(req.method || "GET")) {
        jsonResponse(res, 405, { ok: false, error: "method_not_allowed" }, { allow: "GET, HEAD" });
        return;
      }
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (url.pathname === INVENTORY_API_PATH) {
      if (!inventoryApiKeyHash) {
        jsonResponse(res, 404, { ok: false, error: "not_found" });
        return;
      }
      const cors = inventoryCors(req, inventoryApiAllowedOrigins);
      if (!cors.allowed) {
        jsonResponse(res, 403, { ok: false, error: "origin_rejected" });
        return;
      }
      if (req.method === "OPTIONS") {
        emptyResponse(res, 204, {
          ...cors.headers,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "Authorization",
          "access-control-max-age": "600",
        });
        return;
      }
      if (req.method !== "GET") {
        jsonResponse(
          res,
          405,
          { ok: false, error: "method_not_allowed" },
          { ...cors.headers, allow: "GET, OPTIONS" },
        );
        return;
      }
      if (!validInventoryApiKey(req, inventoryApiKeyHash)) {
        jsonResponse(
          res,
          401,
          { ok: false, error: "unauthorized" },
          {
            ...cors.headers,
            "www-authenticate": 'Bearer realm="ldxp-inventory"',
          },
        );
        return;
      }
      const clientIp = requestClientIp(req, trustProxy);
      if (!allowInventoryApiRequest(clientIp)) {
        jsonResponse(
          res,
          429,
          { ok: false, error: "rate_limited" },
          { ...cors.headers, "retry-after": "60" },
        );
        return;
      }
      try {
        const snapshot = await loadSnapshot(statusFile);
        const payload = buildInventoryApi(snapshot);
        if (payload.source.status === "down") {
          jsonResponse(
            res,
            503,
            {
              ok: false,
              error: "snapshot_stale",
              snapshotAt: payload.snapshotAt,
              source: payload.source,
            },
            { ...cors.headers, "retry-after": "30" },
          );
          return;
        }
        jsonResponse(res, 200, payload, cors.headers);
      } catch (error) {
        console.error(`INVENTORY_API_SNAPSHOT_ERROR message=${error.message}`);
        jsonResponse(
          res,
          503,
          { ok: false, error: "snapshot_unavailable" },
          { ...cors.headers, "retry-after": "30" },
        );
      }
      return;
    }

    if (url.pathname === "/api/v1/auth/session") {
      const clientIp = requestClientIp(req, trustProxy);
      if (req.method !== "GET") {
        jsonResponse(res, 405, { ok: false, error: "method_not_allowed" }, { allow: "GET" });
        return;
      }
      const ban = await security.banStatus(clientIp);
      if (ban.banned) {
        banResponse(res, ban);
        return;
      }
      const session = await currentSession(req);
      if (!session.valid) {
        jsonResponse(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        authenticated: true,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
      return;
    }

    if (url.pathname === "/api/v1/auth/logout") {
      if (req.method !== "POST") {
        jsonResponse(res, 405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
        return;
      }
      if (!validMutationOrigin(req)) {
        jsonResponse(res, 403, { ok: false, error: "origin_rejected" });
        return;
      }
      await security.deleteSession(sessionToken(req));
      res.setHeader(
        "set-cookie",
        sessionCookie(cookieName, "", {
          maxAgeMs: 0,
          path: cookiePath,
          secure: secureCookie,
        }),
      );
      emptyResponse(res, 204);
      return;
    }

    if (url.pathname === "/api/v1/auth/login") {
      const clientIp = requestClientIp(req, trustProxy);
      if (req.method !== "POST") {
        jsonResponse(res, 405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
        return;
      }
      if (!validMutationOrigin(req)) {
        jsonResponse(res, 403, { ok: false, error: "origin_rejected" });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        jsonResponse(res, error.statusCode || 400, {
          ok: false,
          error: error.publicCode || "invalid_request",
        });
        return;
      }
      if (
        typeof body.password !== "string" ||
        Buffer.byteLength(body.password, "utf8") > 256
      ) {
        jsonResponse(res, 400, { ok: false, error: "invalid_request" });
        return;
      }

      const result = await security.authenticate(clientIp, () =>
        verifyDashboardPassword(body.password, passwordHash),
      );
      if (result.busy) {
        jsonResponse(
          res,
          503,
          { ok: false, error: "authentication_busy" },
          { "retry-after": "5" },
        );
        return;
      }
      if (result.banned) {
        console.warn(`DASHBOARD_IP_BANNED ip=${clientIp} until=${result.bannedUntil}`);
        banResponse(res, result);
        return;
      }
      if (!result.ok) {
        console.warn(
          `DASHBOARD_LOGIN_FAILED ip=${clientIp} remaining=${result.remainingAttempts}`,
        );
        jsonResponse(res, 401, {
          ok: false,
          error: "invalid_credentials",
          attemptsRemaining: result.remainingAttempts,
        });
        return;
      }

      const session = await security.createSession(sessionTtlMs, sessionVersion);
      if (!session) {
        jsonResponse(
          res,
          503,
          { ok: false, error: "session_capacity_reached" },
          { "retry-after": "60" },
        );
        return;
      }
      res.setHeader(
        "set-cookie",
        sessionCookie(cookieName, session.value, {
          maxAgeMs: sessionTtlMs,
          path: cookiePath,
          secure: secureCookie,
        }),
      );
      console.log(`DASHBOARD_LOGIN_SUCCEEDED ip=${clientIp}`);
      emptyResponse(res, 204);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!new Set(["GET", "HEAD"]).has(req.method || "GET")) {
        jsonResponse(res, 405, { ok: false, error: "method_not_allowed" }, { allow: "GET, HEAD" });
        return;
      }
      const clientIp = requestClientIp(req, trustProxy);
      const ban = await security.banStatus(clientIp);
      if (ban.banned) {
        banResponse(res, ban);
        return;
      }
      const session = await currentSession(req);
      if (!session.valid) {
        jsonResponse(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (!allowRequest(clientIp)) {
        jsonResponse(res, 429, { ok: false, error: "rate_limited" }, { "retry-after": "60" });
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

    if (!new Set(["GET", "HEAD"]).has(req.method || "GET")) {
      jsonResponse(res, 405, { ok: false, error: "method_not_allowed" }, { allow: "GET, HEAD" });
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
        "cache-control":
          extension === ".html" ? "private, no-store" : "public, max-age=300",
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`DASHBOARD_STATIC_ERROR message=${error.message}`);
      jsonResponse(res, 404, { ok: false, error: "not_found" });
    }
    } catch (error) {
      console.error(`DASHBOARD_REQUEST_ERROR code=${error.code || "UNKNOWN"} message=${error.message}`);
      if (!res.headersSent) {
        jsonResponse(res, 500, { ok: false, error: "internal_error" });
      } else {
        res.destroy();
      }
    }
  });
}

async function main() {
  const host = process.env.LDXP_DASHBOARD_HOST || "127.0.0.1";
  const port = parseInteger(process.env.LDXP_DASHBOARD_PORT, 8788, 1, 65_535);
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

export {
  buildInventoryApi,
  buildOverview,
  buildProducts,
  calculateHealth,
  createDashboardServer,
  loadSnapshot,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`DASHBOARD_ERROR message=${error.message}`);
    process.exitCode = 1;
  });
}
