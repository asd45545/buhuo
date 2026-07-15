import assert from "node:assert/strict";
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
import { buildOverview, buildProducts, createDashboardServer } from "./server.mjs";

const TOKEN = "dashboard-test-token-1234567890";

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

async function withServer(t, status) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-dashboard-"));
  const statusFile = path.join(directory, "status.json");
  await writeFile(statusFile, JSON.stringify(status), "utf8");
  const server = createDashboardServer({ token: TOKEN, statusFile });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("dashboard API requires a bearer token", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus());
  const response = await fetch(`${baseUrl}/api/v1/dashboard/overview`);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
});

test("dashboard overview returns fresh health and sanitized inventory totals", async (t) => {
  const baseUrl = await withServer(t, fixtureStatus());
  const response = await fetch(`${baseUrl}/api/v1/dashboard/overview`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const body = await response.json();

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

test("product API filters and paginates the sanitized snapshot", async (t) => {
  const status = fixtureStatus();
  const baseUrl = await withServer(t, status);
  const response = await fetch(
    `${baseUrl}/api/v1/dashboard/products?status=in_stock&q=chatgpt&limit=1&offset=0`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.page.total, 1);
  assert.equal(body.page.nextOffset, null);
  assert.equal(body.data[0].key, "one");
  assert.equal(body.data[0].status, "in_stock");
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

test("dashboard rejects the published placeholder token", () => {
  assert.throws(
    () => createDashboardServer({ token: "replace-with-at-least-32-random-characters" }),
    /at least 24 characters/,
  );
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
