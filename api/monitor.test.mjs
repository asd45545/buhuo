import assert from "node:assert/strict";
import test from "node:test";

import handler from "./monitor.mjs";

function base64Json(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8").toString("base64");
}

function createResponse() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(value) {
      chunks.push(value);
    },
    body() {
      return chunks.join("");
    },
  };
}

test("monitor rejects an invalid secret", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called for unauthorized requests");
  };

  try {
    process.env.CRON_SECRET = "correct-secret";
    const res = createResponse();
    await handler({ method: "GET", url: "/api/monitor?secret=wrong", headers: {} }, res);

    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body()), { ok: false, error: "unauthorized" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("monitor updates state without notifying when nothing restocked", async () => {
  const previousState = {
    version: 1,
    visitorId: "visitor-1",
    items: {
      goods_1: {
        key: "goods_1",
        name: "ChatGPT Plus 月卡",
        link: "https://pay.ldxp.cn/item/goods_1",
        goodsType: "card",
        categoryId: null,
        categoryName: "",
        price: 19.9,
        stock: 5,
        inStock: true,
        watchOutOfStock: false,
        outOfStockSince: null,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        lastChangedAt: "2026-01-01T00:00:00.000Z",
        missingSince: null,
      },
    },
    runs: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    shop: "https://pay.ldxp.cn/shop/jisuai",
    shopToken: "jisuai",
    goodsTypes: ["card"],
  };

  const stateContent = base64Json(previousState);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, method: options.method || "GET", body: options.body || "" });

    if (target.includes("/contents/data/ldxp-stock-state.json?ref=main")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ sha: "sha1", content: stateContent }),
        text: async () => "ok",
      };
    }

    if (target.includes("/shopApi/Shop/goodsList")) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => (name === "content-type" ? "application/json" : null),
          getSetCookie: () => [],
        },
        text: async () =>
          JSON.stringify({
            code: 1,
            data: {
              total: 1,
              list: [
                {
                  goods_key: "goods_1",
                  name: "ChatGPT Plus 月卡",
                  link: "https://pay.ldxp.cn/item/goods_1",
                  goods_type: "card",
                  price: 19.9,
                  extend: { stock_count: 5 },
                },
              ],
            },
          }),
      };
    }

    if (target.includes("/actions/workflows/telegram-notify.yml/dispatches")) {
      throw new Error("dispatch should not be called when there is no restock");
    }

    if (target.includes("/contents/data/ldxp-stock-state.json")) {
      return { ok: true, status: 200, text: async () => "ok", json: async () => ({ content: stateContent }) };
    }

    throw new Error(`unexpected fetch ${target}`);
  };

  try {
    process.env.CRON_SECRET = "correct-secret";
    process.env.LDXP_GITHUB_TOKEN = "token";
    const res = createResponse();
    await handler({ method: "GET", url: "/api/monitor?secret=correct-secret", headers: {} }, res);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body());
    assert.equal(body.ok, true);
    assert.equal(body.restockedCount, 0);
    assert.equal(body.notificationsSent, 0);
    assert.ok(calls.some((call) => call.target.includes("/shopApi/Shop/goodsList")));
    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("monitor dispatches telegram notifications for restocks", async () => {
  const previousState = {
    version: 1,
    visitorId: "visitor-1",
    items: {
      goods_1: {
        key: "goods_1",
        name: "ChatGPT Plus 月卡",
        link: "https://pay.ldxp.cn/item/goods_1",
        goodsType: "card",
        categoryId: null,
        categoryName: "",
        price: 19.9,
        stock: 0,
        inStock: false,
        watchOutOfStock: true,
        outOfStockSince: "2026-01-01T00:00:00.000Z",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        lastChangedAt: "2026-01-01T00:00:00.000Z",
        missingSince: null,
      },
    },
    runs: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    shop: "https://pay.ldxp.cn/shop/jisuai",
    shopToken: "jisuai",
    goodsTypes: ["card"],
  };

  const stateContent = base64Json(previousState);
  const dispatchBodies = [];
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, method: options.method || "GET" });

    if (target.includes("/contents/data/ldxp-stock-state.json?ref=main")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ sha: "sha1", content: stateContent }),
        text: async () => "ok",
      };
    }

    if (target.includes("/shopApi/Shop/goodsList")) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => (name === "content-type" ? "application/json" : null),
          getSetCookie: () => [],
        },
        text: async () =>
          JSON.stringify({
            code: 1,
            data: {
              total: 1,
              list: [
                {
                  goods_key: "goods_1",
                  name: "ChatGPT Plus 月卡",
                  link: "https://pay.ldxp.cn/item/goods_1",
                  goods_type: "card",
                  price: 19.9,
                  extend: { stock_count: 18 },
                },
              ],
            },
          }),
      };
    }

    if (target.includes("/actions/workflows/telegram-notify.yml/dispatches")) {
      dispatchBodies.push(JSON.parse(options.body));
      return { ok: true, status: 204, text: async () => "" };
    }

    if (target.includes("/contents/data/ldxp-stock-state.json")) {
      return { ok: true, status: 200, text: async () => "ok", json: async () => ({}) };
    }

    return { ok: true, status: 200, text: async () => "ok", json: async () => ({}) };
  };

  try {
    process.env.CRON_SECRET = "correct-secret";
    process.env.LDXP_GITHUB_TOKEN = "token";
    const res = createResponse();
    await handler({ method: "GET", url: "/api/monitor?secret=correct-secret", headers: {} }, res);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body());
    assert.equal(body.ok, true);
    assert.equal(body.restockedCount, 1);
    assert.equal(body.notificationsSent, 1);
    assert.equal(dispatchBodies.length, 1);
    assert.equal(dispatchBodies[0].ref, "main");
    const stateWriteIndex = calls.findIndex(
      (call) => call.method === "PUT" && call.target.includes("/contents/data/ldxp-stock-state.json"),
    );
    const dispatchIndex = calls.findIndex((call) =>
      call.target.includes("/actions/workflows/telegram-notify.yml/dispatches"),
    );
    assert.ok(stateWriteIndex >= 0);
    assert.ok(dispatchIndex > stateWriteIndex);
    assert.match(dispatchBodies[0].inputs.text, /商品：ChatGPT Plus 月卡/);
    assert.match(dispatchBodies[0].inputs.text, /库存：0 → 18/);
    assert.match(dispatchBodies[0].inputs.text, /商品链接：https:\/\/pay\.ldxp\.cn\/item\/goods_1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
