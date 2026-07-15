import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildInventorySnapshot,
  createMonitorStatus,
  markMonitorStopped,
  recordPollFailure,
  recordPollSuccess,
} from "../scripts/monitor-health.mjs";
import { hashDashboardPassword } from "./auth.mjs";
import {
  buildInventoryApi,
  buildOverview,
  buildProducts,
  createDashboardServer,
} from "./server.mjs";

const PASSWORD = "dashboard-password-安全-123";
const PASSWORD_HASH = await hashDashboardPassword(PASSWORD, { salt: Buffer.alloc(16, 9) });
const CHANGED_PASSWORD_HASH = await hashDashboardPassword("changed-dashboard-password-安全-456", {
  salt: Buffer.alloc(16, 10),
});
const PUBLIC_ORIGIN = "http://dashboard.test";
const INVENTORY_API_KEY = Buffer.alloc(32, 11).toString("base64url");
const INVENTORY_API_KEY_HASH = createHash("sha256")
  .update(INVENTORY_API_KEY, "utf8")
  .digest("hex");

function fixtureStatus(now = Date.now()) {
  const finishedAt = new Date(now - 10_000).toISOString();
  const startedAt = new Date(now - 18_000).toISOString();
  const inventory = buildInventorySnapshot({
    updatedAt: finishedAt,
    items: {
      one: {
        key: "one",
        name: "ChatGPT Plus 商品",
        link: "https://pay.ldxp.cn/item/one",
        categoryId: 1,
        categoryName: "GPT PLUS",
        price: 9.9,
        stock: 12,
        lastChangedAt: finishedAt,
      },
      two: {
        key: "two",
        name: "缺货商品",
        link: "https://pay.ldxp.cn/item/two",
        categoryId: 2,
        categoryName: "邮箱",
        price: 3,
        stock: 0,
        lastChangedAt: finishedAt,
      },
    },
  });
  const status = createMonitorStatus({
    now: new Date(now - 60_000).toISOString(),
    intervalMs: 300_000,
    transport: "browser",
  });
  return recordPollSuccess(
    status,
    { totalGoods: 2, outOfStockCount: 1, restockedCount: 0, alerts: [] },
    inventory,
    { startedAt, finishedAt, durationMs: 8_000 },
  );
}

async function startDashboardServer(options = {}) {
  const server = createDashboardServer({
    passwordHash: PASSWORD_HASH,
    publicOrigin: PUBLIC_ORIGIN,
    secureCookie: false,
    cookieName: "ldxp_test_session",
    trustProxy: true,
    ...options,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function closeDashboardServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withServer(t, status, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-dashboard-"));
  const statusFile = path.join(directory, "status.json");
  const securityFile = path.join(directory, "auth-state.json");
  await writeFile(statusFile, JSON.stringify(status), "utf8");
  const { server, baseUrl } = await startDashboardServer({
    statusFile,
    securityFile,
    ...options,
  });
  t.after(
    () => closeDashboardServer(server),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return baseUrl;
}

async function login(
  baseUrl,
  password = PASSWORD,
  ip = "203.0.113.50",
  origin = PUBLIC_ORIGIN,
) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-real-ip": ip,
    },
    body: JSON.stringify({ password }),
  });
  const cookie = String(response.headers.get("set-cookie") || "").split(";", 1)[0];
  return { response, cookie };
}

function authenticatedHeaders(cookie, ip = "203.0.113.50") {
  return { cookie, "x-real-ip": ip };
}

async function createDashboardFiles(status) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-dashboard-persistent-"));
  const statusFile = path.join(directory, "status.json");
  const securityFile = path.join(directory, "auth-state.json");
  await writeFile(statusFile, JSON.stringify(status), "utf8");
  return { directory, statusFile, securityFile };
}

test("dashboard API rejects unauthenticated and legacy bearer requests", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus());
  const response = await fetch(`${baseUrl}/api/v1/dashboard/overview`);
  const legacy = await fetch(`${baseUrl}/api/v1/dashboard/overview`, {
    headers: { authorization: "Bearer dashboard-test-token-1234567890" },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
  assert.equal(legacy.status, 401);
});

test("password login sets a cookie and unlocks the dashboard API", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus());
  const { response: loginResponse, cookie } = await login(baseUrl);
  const response = await fetch(`${baseUrl}/api/v1/dashboard/overview`, {
    headers: authenticatedHeaders(cookie),
  });
  const body = await response.json();

  assert.equal(loginResponse.status, 204);
  assert.match(loginResponse.headers.get("set-cookie"), /HttpOnly/);
  assert.match(loginResponse.headers.get("set-cookie"), /SameSite=Strict/);
  assert.equal(response.status, 200);
  assert.equal(body.monitor.status, "healthy");
  assert.equal(body.monitor.transport, "browser");
  assert.equal(body.inventory.activeTotal, 2);
  assert.equal(body.inventory.inStockTotal, 1);
  assert.equal(body.inventory.outOfStockTotal, 1);
  assert.deepEqual(new Set(body.inventory.categories), new Set(["GPT PLUS", "邮箱"]));
  assert.equal("products" in body.inventory, false);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("default session cookie uses the Secure prefix and stock monitor path", async (t) => {
  const publicOrigin = "https://dashboard.example";
  const baseUrl = await withServer(t, fixtureStatus(), {
    cookieName: undefined,
    publicOrigin,
    secureCookie: true,
  });
  const { response } = await login(baseUrl, PASSWORD, "203.0.113.51", publicOrigin);
  const setCookie = response.headers.get("set-cookie");

  assert.equal(response.status, 204);
  assert.match(setCookie, /^__Secure-ldxp_session=/);
  assert.match(setCookie, /Path=\/stock-monitor\//);
  assert.match(setCookie, /(?:^|; )Secure(?:;|$)/);
});

test("Secure-prefixed cookies are rejected when Secure is disabled", () => {
  assert.throws(
    () =>
      createDashboardServer({
        passwordHash: PASSWORD_HASH,
        publicOrigin: PUBLIC_ORIGIN,
        secureCookie: false,
        cookieName: "__Secure-ldxp_session",
        cookiePath: "/stock-monitor/",
      }),
    /__Secure- dashboard cookies require Secure/,
  );
});

test("persisted sessions remain valid after the dashboard server restarts", async (t) => {
  const files = await createDashboardFiles(fixtureStatus());
  let firstServer;
  let secondServer;
  t.after(async () => {
    await closeDashboardServer(firstServer);
    await closeDashboardServer(secondServer);
    await rm(files.directory, { recursive: true, force: true });
  });

  const first = await startDashboardServer(files);
  firstServer = first.server;
  const { cookie } = await login(first.baseUrl, PASSWORD, "203.0.113.52");
  await closeDashboardServer(firstServer);

  const second = await startDashboardServer(files);
  secondServer = second.server;
  const response = await fetch(`${second.baseUrl}/api/v1/dashboard/overview`, {
    headers: authenticatedHeaders(cookie, "203.0.113.52"),
  });

  assert.equal(response.status, 200);
});

test("changing the password hash invalidates sessions from an earlier server", async (t) => {
  const files = await createDashboardFiles(fixtureStatus());
  let firstServer;
  let secondServer;
  t.after(async () => {
    await closeDashboardServer(firstServer);
    await closeDashboardServer(secondServer);
    await rm(files.directory, { recursive: true, force: true });
  });

  const first = await startDashboardServer(files);
  firstServer = first.server;
  const { cookie } = await login(first.baseUrl, PASSWORD, "203.0.113.53");
  await closeDashboardServer(firstServer);

  const second = await startDashboardServer({
    ...files,
    passwordHash: CHANGED_PASSWORD_HASH,
  });
  secondServer = second.server;
  const response = await fetch(`${second.baseUrl}/api/v1/dashboard/overview`, {
    headers: authenticatedHeaders(cookie, "203.0.113.53"),
  });

  assert.equal(response.status, 401);
});

test("product API filters and paginates the sanitized snapshot", async (t) => {
  const status = fixtureStatus();
  const baseUrl = await withServer(t, status);
  const { cookie } = await login(baseUrl);
  const response = await fetch(
    `${baseUrl}/api/v1/dashboard/products?status=in_stock&q=chatgpt&limit=1&offset=0`,
    { headers: authenticatedHeaders(cookie) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.page.total, 1);
  assert.equal(body.page.nextOffset, null);
  assert.equal(body.data[0].key, "one");
  assert.equal(body.data[0].status, "in_stock");
});

test("inventory API returns active stock details with an API key and no dashboard session", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus(), {
    inventoryApiKeyHash: INVENTORY_API_KEY_HASH,
  });
  const response = await fetch(`${baseUrl}/api/v1/inventory`, {
    headers: { authorization: `Bearer ${INVENTORY_API_KEY}` },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.summary.total, 2);
  assert.equal(body.summary.inStock, 1);
  assert.equal(body.summary.outOfStock, 1);
  assert.equal(typeof body.source.ageMs, "number");
  assert.equal(body.items.length, 2);
  assert.deepEqual(Object.keys(body.items[0]), [
    "id",
    "name",
    "url",
    "category",
    "price",
    "stock",
    "status",
    "lastChangedAt",
  ]);
  assert.equal("products" in body, false);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("inventory API rejects missing and incorrect keys without exposing stock", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus(), {
    inventoryApiKeyHash: INVENTORY_API_KEY_HASH,
  });
  const missing = await fetch(`${baseUrl}/api/v1/inventory`);
  const incorrect = await fetch(`${baseUrl}/api/v1/inventory`, {
    headers: { authorization: `Bearer ${Buffer.alloc(32, 12).toString("base64url")}` },
  });

  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { ok: false, error: "unauthorized" });
  assert.match(missing.headers.get("www-authenticate"), /Bearer/);
  assert.equal(incorrect.status, 401);
});

test("dashboard cookies and query parameters cannot replace the inventory API key", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus(), {
    inventoryApiKeyHash: INVENTORY_API_KEY_HASH,
  });
  const { cookie } = await login(baseUrl);
  const cookieOnly = await fetch(`${baseUrl}/api/v1/inventory`, {
    headers: authenticatedHeaders(cookie),
  });
  const queryKey = await fetch(
    `${baseUrl}/api/v1/inventory?api_key=${encodeURIComponent(INVENTORY_API_KEY)}`,
  );

  assert.equal(cookieOnly.status, 401);
  assert.equal(queryKey.status, 401);
});

test("inventory API supports credential-free CORS preflight for configured websites", async (t) => {
  const callerOrigin = "https://shop.example";
  const baseUrl = await withServer(t, fixtureStatus(), {
    inventoryApiKeyHash: INVENTORY_API_KEY_HASH,
    inventoryApiAllowedOrigins: [callerOrigin],
  });
  const preflight = await fetch(`${baseUrl}/api/v1/inventory`, {
    method: "OPTIONS",
    headers: {
      origin: callerOrigin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  const allowed = await fetch(`${baseUrl}/api/v1/inventory`, {
    headers: {
      authorization: `Bearer ${INVENTORY_API_KEY}`,
      origin: callerOrigin,
    },
  });
  const rejected = await fetch(`${baseUrl}/api/v1/inventory`, {
    headers: {
      authorization: `Bearer ${INVENTORY_API_KEY}`,
      origin: "https://evil.example",
    },
  });

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), callerOrigin);
  assert.match(preflight.headers.get("access-control-allow-methods"), /GET/);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/i);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), callerOrigin);
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);
});

test("inventory API wildcard CORS still requires the API key", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus(), {
    inventoryApiKeyHash: INVENTORY_API_KEY_HASH,
    inventoryApiAllowedOrigins: "*",
  });
  const response = await fetch(`${baseUrl}/api/v1/inventory`, {
    headers: { origin: "https://any-site.example" },
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("inventory API is disabled without a configured key hash", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus());
  const response = await fetch(`${baseUrl}/api/v1/inventory`, {
    headers: { authorization: `Bearer ${INVENTORY_API_KEY}` },
  });

  assert.equal(response.status, 404);
});

test("inventory API returns 503 instead of serving a stale snapshot", async (t) => {
  const baseUrl = await withServer(
    t,
    fixtureStatus(Date.now() - 60 * 60 * 1000),
    { inventoryApiKeyHash: INVENTORY_API_KEY_HASH },
  );
  const response = await fetch(`${baseUrl}/api/v1/inventory`, {
    headers: { authorization: `Bearer ${INVENTORY_API_KEY}` },
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "snapshot_stale");
  assert.equal(body.source.status, "down");
  assert.equal(response.headers.get("retry-after"), "30");
});

test("inventory API returns 503 before the first successful poll", async (t) => {
  const status = createMonitorStatus({
    now: new Date().toISOString(),
    intervalMs: 300_000,
    transport: "browser",
  });
  const baseUrl = await withServer(t, status, {
    inventoryApiKeyHash: INVENTORY_API_KEY_HASH,
  });
  const response = await fetch(`${baseUrl}/api/v1/inventory`, {
    headers: { authorization: `Bearer ${INVENTORY_API_KEY}` },
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "snapshot_unavailable");
  assert.equal(body.source.status, "starting");
  assert.equal(response.headers.get("retry-after"), "30");
});

test("inventory API does not leak unexpected snapshot fields", async (t) => {
  const status = fixtureStatus();
  status.shopToken = "shop-token-must-not-leak";
  status.inventory.proxyPassword = "proxy-password-must-not-leak";
  status.inventory.products[0].visitorId = "visitor-id-must-not-leak";
  const baseUrl = await withServer(t, status, {
    inventoryApiKeyHash: INVENTORY_API_KEY_HASH,
  });
  const response = await fetch(`${baseUrl}/api/v1/inventory`, {
    headers: { authorization: `Bearer ${INVENTORY_API_KEY}` },
  });
  const serialized = await response.text();

  assert.equal(response.status, 200);
  assert.doesNotMatch(serialized, /shop-token|proxy-password|visitor-id/);
});

test("inventory API builder excludes historical missing products", () => {
  const status = fixtureStatus();
  status.inventory.products.push({
    ...status.inventory.products[0],
    key: "historical",
    name: "historical product",
    status: "missing",
    missingSince: new Date().toISOString(),
  });
  const result = buildInventoryApi(status);

  assert.equal(result.summary.total, 2);
  assert.equal(result.items.some((item) => item.id === "historical"), false);
});

test("inventory API builder normalizes malformed snapshot fields", () => {
  const status = fixtureStatus();
  status.inventory.products = [
    {
      key: "unsafe",
      name: "unsafe product",
      link: "https://pay.ldxp.cn:8443/item/unsafe?token=secret",
      category: { id: -9, name: "unsafe" },
      price: -12,
      stock: -5,
      status: "in_stock",
      lastChangedAt: "not-a-date",
    },
    { key: "", status: "in_stock", stock: 1 },
  ];
  const result = buildInventoryApi(status);

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    id: "unsafe",
    name: "unsafe product",
    url: null,
    category: { id: 0, name: "unsafe" },
    price: 0,
    stock: 0,
    status: "out_of_stock",
    lastChangedAt: null,
  });
});

test("inventory API rejects malformed key hashes and origin allowlists", () => {
  assert.throws(
    () =>
      createDashboardServer({
        passwordHash: PASSWORD_HASH,
        publicOrigin: PUBLIC_ORIGIN,
        secureCookie: false,
        cookieName: "ldxp_test_session",
        inventoryApiKeyHash: "not-a-hash",
      }),
    /SHA-256/,
  );
  assert.throws(
    () =>
      createDashboardServer({
        passwordHash: PASSWORD_HASH,
        publicOrigin: PUBLIC_ORIGIN,
        secureCookie: false,
        cookieName: "ldxp_test_session",
        inventoryApiAllowedOrigins: "https://shop.example/path",
      }),
    /allowed origin/,
  );
});

test("overview marks snapshots down after three missed intervals", () => {
  const now = Date.parse("2026-07-15T16:00:00.000Z");
  const status = fixtureStatus(Date.parse("2026-07-15T15:00:00.000Z"));
  const overview = buildOverview(status, now);

  assert.equal(overview.monitor.status, "down");
  assert.equal(overview.monitor.reasonCode, "STATUS_STALE");
});

test("overview distinguishes first-poll failures from a healthy startup", () => {
  const now = Date.parse("2026-07-15T16:00:00.000Z");
  let status = createMonitorStatus({
    now: "2026-07-15T15:59:00.000Z",
    intervalMs: 300_000,
  });
  status = recordPollFailure(status, new Error("request failed"), {
    startedAt: "2026-07-15T15:59:01.000Z",
    finishedAt: "2026-07-15T15:59:31.000Z",
    consecutiveFailures: 1,
  });

  const overview = buildOverview(status, now);
  assert.equal(overview.monitor.status, "degraded");
  assert.equal(overview.monitor.reasonCode, "POLL_FAILURE");
  assert.equal("message" in overview.monitor.lastError, false);
});

test("overview marks a never-successful stale snapshot down", () => {
  const status = createMonitorStatus({
    now: "2026-07-15T15:00:00.000Z",
    intervalMs: 300_000,
  });
  const overview = buildOverview(status, Date.parse("2026-07-15T16:00:00.000Z"));

  assert.equal(overview.monitor.status, "down");
  assert.equal(overview.monitor.reasonCode, "STATUS_STALE");
});

test("overview freezes process uptime when the monitor has stopped", () => {
  let status = createMonitorStatus({ now: "2026-07-15T15:00:00.000Z" });
  status = markMonitorStopped(status, "2026-07-15T15:10:00.000Z");
  const overview = buildOverview(status, Date.parse("2026-07-15T16:00:00.000Z"));

  assert.equal(overview.monitor.service.uptimeSeconds, 600);
  assert.equal(overview.monitor.service.active, false);
});

test("dashboard rejects an invalid password hash", () => {
  assert.throws(
    () =>
      createDashboardServer({
        passwordHash: "not-a-password-hash",
        publicOrigin: PUBLIC_ORIGIN,
        secureCookie: false,
        cookieName: "ldxp_test_session",
      }),
    /password hash/,
  );
});

test("three bad passwords block only the real source IP", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus(), { banMs: 60_000 });
  const authenticated = await login(baseUrl, PASSWORD, "203.0.113.60");
  const first = await login(baseUrl, "wrong-password-value", "203.0.113.60");
  const second = await login(baseUrl, "wrong-password-value", "203.0.113.60");
  const third = await login(baseUrl, "wrong-password-value", "203.0.113.60");

  assert.equal(first.response.status, 401);
  assert.equal((await first.response.json()).attemptsRemaining, 2);
  assert.equal(second.response.status, 401);
  assert.equal((await second.response.json()).attemptsRemaining, 1);
  assert.equal(third.response.status, 429);
  assert.equal((await third.response.json()).error, "ip_blocked");
  assert.equal((await login(baseUrl, PASSWORD, "203.0.113.60")).response.status, 429);
  assert.equal(
    (
      await fetch(`${baseUrl}/api/v1/dashboard/overview`, {
        headers: authenticatedHeaders(authenticated.cookie, "203.0.113.60"),
      })
    ).status,
    429,
  );
  assert.equal((await login(baseUrl, PASSWORD, "203.0.113.61")).response.status, 204);
});

test("login validates content type, JSON syntax, and body size before password hashing", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus());
  const common = { method: "POST", headers: { origin: PUBLIC_ORIGIN } };
  const wrongType = await fetch(`${baseUrl}/api/v1/auth/login`, {
    ...common,
    body: JSON.stringify({ password: PASSWORD }),
  });
  const badJson = await fetch(`${baseUrl}/api/v1/auth/login`, {
    ...common,
    headers: { ...common.headers, "content-type": "application/json" },
    body: "{",
  });
  const oversized = await fetch(`${baseUrl}/api/v1/auth/login`, {
    ...common,
    headers: { ...common.headers, "content-type": "application/json" },
    body: JSON.stringify({ password: "x".repeat(3_000) }),
  });

  assert.equal(wrongType.status, 415);
  assert.equal(badJson.status, 400);
  assert.equal(oversized.status, 413);
});

test("login and logout reject cross-site origins", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus());
  const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const logoutResponse = await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });

  assert.equal(loginResponse.status, 403);
  assert.equal(logoutResponse.status, 403);
  assert.equal(loginResponse.headers.get("access-control-allow-origin"), null);
});

test("logout clears the browser cookie", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus());
  const { cookie } = await login(baseUrl);
  const response = await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: { ...authenticatedHeaders(cookie), origin: PUBLIC_ORIGIN },
  });
  const oldSessionResponse = await fetch(`${baseUrl}/api/v1/dashboard/overview`, {
    headers: authenticatedHeaders(cookie),
  });

  assert.equal(response.status, 204);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(oldSessionResponse.status, 401);
});

test("product builder rejects unknown statuses and caps page size", () => {
  const status = fixtureStatus();
  const result = buildProducts(
    status,
    new URLSearchParams({ status: "invalid", limit: "9999", offset: "-5" }),
  );

  assert.equal(result.page.limit, 100);
  assert.equal(result.page.offset, 0);
  assert.equal(result.page.total, 2);
});

test("static dashboard uses restrictive browser security headers", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus());
  const response = await fetch(baseUrl);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("API documentation requires a dashboard session and supports a canonical link", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus(), {
    inventoryApiKeyHash: INVENTORY_API_KEY_HASH,
  });
  const unauthenticated = await fetch(`${baseUrl}/api-docs.html`, {
    redirect: "manual",
  });
  const apiKeyOnly = await fetch(`${baseUrl}/api-docs.html`, {
    headers: { authorization: `Bearer ${INVENTORY_API_KEY}` },
    redirect: "manual",
  });
  const mixedCaseUnauthenticated = await fetch(`${baseUrl}/API-DOCS.HTML`, {
    redirect: "manual",
  });
  const { cookie } = await login(baseUrl);
  const authenticated = await fetch(`${baseUrl}/api-docs.html`, {
    headers: authenticatedHeaders(cookie),
  });
  const alias = await fetch(`${baseUrl}/api-docs`, {
    headers: authenticatedHeaders(cookie),
    redirect: "manual",
  });
  const mixedCaseAlias = await fetch(`${baseUrl}/API-DOCS.HTML`, {
    headers: authenticatedHeaders(cookie),
    redirect: "manual",
  });
  const html = await authenticated.text();

  assert.equal(unauthenticated.status, 302);
  assert.equal(unauthenticated.headers.get("location"), "/stock-monitor/");
  assert.equal(apiKeyOnly.status, 302);
  assert.equal(mixedCaseUnauthenticated.status, 302);
  assert.equal(authenticated.status, 200);
  assert.match(authenticated.headers.get("content-type"), /text\/html/);
  assert.match(authenticated.headers.get("cache-control"), /no-store/);
  assert.match(html, /库存明细 API 接口文档/);
  assert.doesNotMatch(html, new RegExp(INVENTORY_API_KEY));
  assert.equal(alias.status, 308);
  assert.equal(alias.headers.get("location"), "/stock-monitor/api-docs.html");
  assert.equal(mixedCaseAlias.status, 308);
  assert.equal(mixedCaseAlias.headers.get("location"), "/stock-monitor/api-docs.html");
});

test("dashboard rejects unsafe cookie paths before serving protected documentation", () => {
  for (const cookiePath of [
    "/stock-monitor/\r\nX-Injected: yes",
    "//evil.example/",
    "/\\evil.example/",
    "/stock-monitor/?next=//evil.example",
    "/stock-monitor/#outside",
  ]) {
    assert.throws(
      () =>
        createDashboardServer({
          passwordHash: PASSWORD_HASH,
          publicOrigin: PUBLIC_ORIGIN,
          secureCookie: false,
          cookieName: "ldxp_test_session",
          cookiePath,
        }),
      /cookie path/,
    );
  }
});

test("malformed request targets return 400 without terminating the server", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus());
  const { hostname, port } = new URL(baseUrl);
  const rawResponse = await new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write("GET // HTTP/1.1\r\nHost: dashboard.local\r\nConnection: close\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });

  assert.match(rawResponse, /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
});
