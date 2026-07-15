import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_RECENT_POLLS,
  buildInventorySnapshot,
  createMonitorStatus,
  loadMonitorStatus,
  markMonitorStopped,
  markPollStarted,
  recordPollFailure,
  recordPollSuccess,
  sanitizeError,
  saveMonitorStatus,
} from "./monitor-health.mjs";

function stateFixture() {
  return {
    updatedAt: "2026-07-15T15:00:00.000Z",
    items: {
      active: {
        key: "active",
        name: "有货商品",
        link: "https://pay.ldxp.cn/item/active",
        categoryId: 1,
        categoryName: "GPT PLUS",
        price: 9.9,
        stock: 5,
        lastChangedAt: "2026-07-15T14:59:00.000Z",
      },
      empty: {
        key: "empty",
        name: "缺货商品",
        link: "https://pay.ldxp.cn/item/empty",
        categoryId: 1,
        categoryName: "GPT PLUS",
        price: 4.5,
        stock: 0,
        outOfStockSince: "2026-07-15T14:00:00.000Z",
      },
      missing: {
        key: "missing",
        name: "历史下架商品",
        link: "https://evil.example/item/missing",
        categoryId: 2,
        categoryName: "历史",
        price: 1,
        stock: 99,
        missingSince: "2026-07-15T13:00:00.000Z",
      },
    },
  };
}

test("inventory snapshot separates active, out-of-stock, and missing goods", () => {
  const inventory = buildInventorySnapshot(stateFixture());

  assert.equal(inventory.activeTotal, 2);
  assert.equal(inventory.inStockTotal, 1);
  assert.equal(inventory.outOfStockTotal, 1);
  assert.equal(inventory.missingTotal, 1);
  assert.equal(inventory.products.find((item) => item.key === "missing").status, "missing");
  assert.equal(inventory.products.find((item) => item.key === "missing").link, "");
});

test("daemon status records successful polls and sanitized restocks", () => {
  const inventory = buildInventorySnapshot(stateFixture());
  let status = createMonitorStatus({
    now: "2026-07-15T15:00:00.000Z",
    intervalMs: 300_000,
    transport: "browser",
    pid: 42,
  });
  status = markPollStarted(status, "2026-07-15T15:00:01.000Z");
  status = recordPollSuccess(
    status,
    {
      checkedAt: "2026-07-15T15:00:01.000Z",
      totalGoods: 2,
      outOfStockCount: 1,
      restockedCount: 1,
      alerts: [
        {
          key: "active",
          name: "有货商品",
          link: "https://pay.ldxp.cn/item/active",
          categoryName: "GPT PLUS",
          previousStock: 0,
          stock: 5,
          price: 9.9,
        },
      ],
    },
    inventory,
    {
      startedAt: "2026-07-15T15:00:01.000Z",
      finishedAt: "2026-07-15T15:00:09.000Z",
      durationMs: 8_000,
    },
  );

  assert.equal(status.monitor.lifecycle, "healthy");
  assert.equal(status.monitor.consecutiveFailures, 0);
  assert.equal(status.monitor.lastPoll.totalGoods, 2);
  assert.equal(status.recentPolls.length, 1);
  assert.equal(status.recentRestocks.length, 1);
  assert.equal(status.recentRestocks[0].name, "有货商品");
  assert.equal(status.schedule.nextExpectedPollAt, "2026-07-15T15:05:01.000Z");
});

test("daemon status persists failures without leaking proxy credentials", () => {
  let status = createMonitorStatus({
    now: "2026-07-15T15:00:00.000Z",
    intervalMs: 300_000,
    transport: "browser",
  });
  status = recordPollFailure(
    status,
    {
      code: "UND_ERR_CONNECT_TIMEOUT",
      message:
        "request to socks5://user:password@proxy.example:8080 failed password=secret&token=abc",
    },
    {
      startedAt: "2026-07-15T15:00:01.000Z",
      finishedAt: "2026-07-15T15:00:31.000Z",
      durationMs: 30_000,
      consecutiveFailures: 2,
    },
  );

  assert.equal(status.monitor.lifecycle, "degraded");
  assert.equal(status.monitor.consecutiveFailures, 2);
  assert.equal(status.monitor.lastError.code, "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(status.monitor.lastError.message, "Monitor request timed out");
  assert.doesNotMatch(JSON.stringify(status.monitor.lastError), /user|password|secret|abc/);
});

test("recent poll history is bounded and process starts survive restarts", () => {
  let status = createMonitorStatus({ now: "2026-07-15T00:00:00.000Z" });
  const inventory = buildInventorySnapshot(stateFixture());
  for (let index = 0; index < MAX_RECENT_POLLS + 5; index += 1) {
    const startedAt = new Date(Date.parse("2026-07-15T00:00:00.000Z") + index * 300_000).toISOString();
    const finishedAt = new Date(Date.parse(startedAt) + 1000).toISOString();
    status = recordPollSuccess(status, { totalGoods: 2, outOfStockCount: 1, alerts: [] }, inventory, {
      startedAt,
      finishedAt,
      durationMs: 1000,
    });
  }

  assert.equal(status.recentPolls.length, MAX_RECENT_POLLS);
  const restarted = createMonitorStatus({ now: "2026-07-16T00:00:00.000Z" }, status);
  assert.equal(restarted.process.starts, 2);
  assert.equal(restarted.recentPolls.length, MAX_RECENT_POLLS);
  assert.equal(markMonitorStopped(restarted).monitor.lifecycle, "stopped");
});

test("status snapshot is written atomically and can be loaded", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-health-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "status.json");
  const status = createMonitorStatus({ now: "2026-07-15T15:00:00.000Z" });

  await saveMonitorStatus(file, status);
  assert.deepEqual(await loadMonitorStatus(file), status);
});

test("error sanitizer emits stable generic values", () => {
  assert.deepEqual(sanitizeError(null), {
    code: "UNKNOWN",
    message: "Monitor request failed",
  });
});
