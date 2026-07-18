import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  apiPost,
  cleanupTelegramDeletionQueue,
  sendTelegram,
} from "./monitor-ldxp-stock.mjs";

async function loadEmailFormatter() {
  const source = await readFile(new URL("./monitor-ldxp-stock.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function formatEmailMessage");
  const end = source.indexOf("function summarize", start);
  assert.notEqual(start, -1, "formatEmailMessage should exist");
  assert.notEqual(end, -1, "email formatter block should be extractable");

  const context = vm.createContext({ Buffer });
  vm.runInContext(`${source.slice(start, end)}; globalThis.formatEmailMessage = formatEmailMessage;`, context);
  return context.formatEmailMessage;
}

test("email subject and body preserve Chinese text through MIME encoding", async () => {
  const formatEmailMessage = await loadEmailFormatter();
  const subject = "LDXP 库存监控邮件测试";
  const body = "这是一封库存监控测试邮件。";
  const message = formatEmailMessage({
    from: "admin@example.com",
    to: ["receiver@example.com"],
    subject,
    body,
  });

  assert.match(message, /Content-Transfer-Encoding: base64/);

  const [headers, encodedBody] = message.split("\r\n\r\n");
  const subjectValue = headers.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m)?.[1];
  assert.equal(Buffer.from(subjectValue, "base64").toString("utf8"), subject);
  assert.equal(Buffer.from(encodedBody.replace(/\r\n/g, ""), "base64").toString("utf8"), body);
});

test("Telegram restock message uses the requested four-line format", async () => {
  const source = await readFile(new URL("./monitor-ldxp-stock.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function formatTelegramMessage");
  const end = source.indexOf("async function sendTelegram", start);
  assert.notEqual(start, -1, "formatTelegramMessage should exist");
  assert.notEqual(end, -1, "Telegram formatter block should be extractable");

  const context = vm.createContext({});
  vm.runInContext(`${source.slice(start, end)}; globalThis.formatTelegramMessage = formatTelegramMessage;`, context);

  assert.equal(
    context.formatTelegramMessage({
      name: "ChatGPT Plus 月卡",
      previousStock: 0,
      stock: 25,
      price: 19.9,
      link: "https://example.com/item/1?a=1&b=2",
    }),
    [
      "商品：ChatGPT Plus 月卡",
      "库存：0 → 25",
      "售价：¥19.90",
      "商品链接：https://example.com/item/1?a=1&amp;b=2",
    ].join("\n"),
  );
});

test("server Telegram notifications are queued for deletion after five hours", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-telegram-send-"));
  const queueFile = path.join(directory, "telegram-delete-queue.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  let sentPayload;

  const sent = await sendTelegram(
    {
      telegram: {
        botToken: "test-bot-token",
        chatId: "-1001",
        threadId: "99",
      },
      telegramDeleteQueueFile: queueFile,
      telegramDeleteAfterSeconds: 18_000,
    },
    [
      {
        name: "ChatGPT Plus 月卡",
        previousStock: 0,
        stock: 25,
        price: 19.9,
        link: "https://example.com/item/1",
      },
    ],
    {
      now: new Date("2026-01-01T00:00:00.000Z"),
      sendRequest: async (_botToken, payload) => {
        sentPayload = payload;
        return { message_id: 321, chat: { id: -1001 } };
      },
    },
  );

  const queue = JSON.parse(await readFile(queueFile, "utf8"));
  assert.equal(sent.length, 1);
  assert.equal(sentPayload.message_thread_id, 99);
  assert.deepEqual(queue, [
    {
      chatId: "-1001",
      messageId: 321,
      deleteAt: "2026-01-01T05:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      attempts: 0,
    },
  ]);
});

test("server cleanup deletes due Telegram messages and persists future entries", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-telegram-cleanup-"));
  const queueFile = path.join(directory, "telegram-delete-queue.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    queueFile,
    JSON.stringify([
      {
        chatId: "-1001",
        messageId: 401,
        deleteAt: "2026-01-01T04:59:00.000Z",
        createdAt: "2025-12-31T23:59:00.000Z",
        attempts: 0,
      },
      {
        chatId: "-1001",
        messageId: 402,
        deleteAt: "2026-01-01T05:01:00.000Z",
        createdAt: "2026-01-01T00:01:00.000Z",
        attempts: 0,
      },
    ]),
    "utf8",
  );
  const deleted = [];

  const result = await cleanupTelegramDeletionQueue(
    {
      telegram: { botToken: "test-bot-token" },
      telegramDeleteQueueFile: queueFile,
    },
    {
      now: new Date("2026-01-01T05:00:00.000Z"),
      deleteMessage: async (entry) => deleted.push(entry.messageId),
    },
  );
  const persisted = JSON.parse(await readFile(queueFile, "utf8"));

  assert.deepEqual(deleted, [401]);
  assert.deepEqual(result.deleted.map((entry) => entry.messageId), [401]);
  assert.deepEqual(persisted.map((entry) => entry.messageId), [402]);
});

test("daemon cleanup runs before the stock request so shop failures do not block deletion", async () => {
  const source = await readFile(new URL("./monitor-ldxp-stock.mjs", import.meta.url), "utf8");
  const cleanupIndex = source.indexOf("await cleanupTelegramDeletionQueueSafely(cfg)");
  const pollIndex = source.indexOf("const summary = await runMonitorOnce(cfg, flags)", cleanupIndex);

  assert.notEqual(cleanupIndex, -1);
  assert.notEqual(pollIndex, -1);
  assert.ok(cleanupIndex < pollIndex);
});

test("stock monitor notification flow does not send email", async () => {
  const source = await readFile(new URL("./monitor-ldxp-stock.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /await (?:mergeEmailConfigFile|sendEmail)\(/);
});

async function loadStateTransitionFunctions() {
  const source = await readFile(new URL("./monitor-ldxp-stock.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function buildNextState");
  const end = source.indexOf("async function appendAlerts", start);
  assert.notEqual(start, -1, "buildNextState should exist");
  assert.notEqual(end, -1, "state transition block should be extractable");

  const context = vm.createContext({});
  vm.runInContext(
    `${source.slice(start, end)}; globalThis.buildNextState = buildNextState;`,
    context,
  );
  return context.buildNextState;
}

function item(overrides = {}) {
  const stock = overrides.stock ?? 0;
  return {
    key: "goods-1",
    name: "ChatGPT Plus 月卡",
    link: "https://example.com/goods-1",
    goodsType: "card",
    categoryId: 1,
    categoryName: "AI",
    price: 19.9,
    stock,
    inStock: stock > 0,
    ...overrides,
  };
}

function stateWith(goodsItem, overrides = {}) {
  return {
    version: 1,
    visitorId: "visitor",
    runs: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    items: goodsItem ? { [goodsItem.key]: goodsItem } : {},
    ...overrides,
  };
}

const transitionConfig = {
  baseUrl: "https://pay.ldxp.cn",
  shopToken: "jisuai",
  goodsTypes: ["card"],
  touchUnchanged: false,
};

test("new out-of-stock goods are retained without sending a false alert", async () => {
  const buildNextState = await loadStateTransitionFunctions();
  const result = buildNextState(
    stateWith(null),
    [item({ stock: 0 })],
    "2026-01-02T00:00:00.000Z",
    transitionConfig,
  );

  assert.equal(result.alerts.length, 0);
  assert.equal(result.nextState.items["goods-1"].watchOutOfStock, true);
  assert.equal(result.nextState.items["goods-1"].outOfStockSince, "2026-01-02T00:00:00.000Z");
});

test("initial in-stock snapshot does not alert every current good", async () => {
  const buildNextState = await loadStateTransitionFunctions();
  const result = buildNextState(
    stateWith(null, { runs: 0, updatedAt: null }),
    [item({ stock: 25 })],
    "2026-01-02T00:00:00.000Z",
    transitionConfig,
  );

  assert.equal(result.alerts.length, 0);
  assert.equal(result.nextState.items["goods-1"].stock, 25);
  assert.equal(result.nextState.items["goods-1"].watchOutOfStock, false);
});

test("new in-stock goods alert after a snapshot exists", async () => {
  const buildNextState = await loadStateTransitionFunctions();
  const result = buildNextState(
    stateWith(null),
    [item({ stock: 25 })],
    "2026-01-02T00:00:00.000Z",
    transitionConfig,
  );

  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].alertType, "new_in_stock");
  assert.equal(result.alerts[0].previousStock, "新上架");
  assert.equal(result.alerts[0].stock, 25);
});

test("out-of-stock goods trigger one alert when stock returns", async () => {
  const buildNextState = await loadStateTransitionFunctions();
  const previous = item({
    stock: 0,
    inStock: false,
    watchOutOfStock: true,
    outOfStockSince: "2026-01-01T00:00:00.000Z",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  });
  const result = buildNextState(
    stateWith(previous),
    [item({ stock: 25 })],
    "2026-01-02T00:00:00.000Z",
    transitionConfig,
  );

  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].previousStock, 0);
  assert.equal(result.alerts[0].stock, 25);
  assert.equal(result.nextState.items["goods-1"].watchOutOfStock, false);
});

test("in-stock goods do not send the same restock alert twice", async () => {
  const buildNextState = await loadStateTransitionFunctions();
  const previous = item({
    stock: 25,
    inStock: true,
    watchOutOfStock: false,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-02T00:00:00.000Z",
  });
  const result = buildNextState(
    stateWith(previous),
    [item({ stock: 25 })],
    "2026-01-03T00:00:00.000Z",
    transitionConfig,
  );

  assert.equal(result.alerts.length, 0);
  assert.equal(result.nextState.items["goods-1"].watchOutOfStock, false);
});

test("in-stock goods do not alert when stock increases", async () => {
  const buildNextState = await loadStateTransitionFunctions();
  const previous = item({
    stock: 5,
    inStock: true,
    watchOutOfStock: false,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-02T00:00:00.000Z",
  });
  const result = buildNextState(
    stateWith(previous),
    [item({ stock: 10 })],
    "2026-01-03T00:00:00.000Z",
    transitionConfig,
  );

  assert.equal(result.alerts.length, 0);
  assert.equal(result.nextState.items["goods-1"].stock, 10);
  assert.equal(result.nextState.items["goods-1"].watchOutOfStock, false);
});

test("stale out-of-stock watch flags do not alert for positive stock increases", async () => {
  const buildNextState = await loadStateTransitionFunctions();
  const previous = item({
    stock: 5,
    inStock: true,
    watchOutOfStock: true,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-02T00:00:00.000Z",
  });
  const result = buildNextState(
    stateWith(previous),
    [item({ stock: 10 })],
    "2026-01-03T00:00:00.000Z",
    transitionConfig,
  );

  assert.equal(result.alerts.length, 0);
  assert.equal(result.nextState.items["goods-1"].watchOutOfStock, false);
});

test("goods can go out of stock and trigger a later second restock alert", async () => {
  const buildNextState = await loadStateTransitionFunctions();
  const inStock = item({
    stock: 25,
    inStock: true,
    watchOutOfStock: false,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  });
  const soldOut = buildNextState(
    stateWith(inStock),
    [item({ stock: 0 })],
    "2026-01-02T00:00:00.000Z",
    transitionConfig,
  );
  const restocked = buildNextState(
    soldOut.nextState,
    [item({ stock: 5 })],
    "2026-01-03T00:00:00.000Z",
    transitionConfig,
  );

  assert.equal(soldOut.alerts.length, 0);
  assert.equal(soldOut.nextState.items["goods-1"].watchOutOfStock, true);
  assert.equal(restocked.alerts.length, 1);
  assert.equal(restocked.alerts[0].previousStock, 0);
  assert.equal(restocked.alerts[0].stock, 5);
});

test("missing out-of-stock goods alert when they reappear with stock", async () => {
  const buildNextState = await loadStateTransitionFunctions();
  const previous = item({
    stock: 0,
    inStock: false,
    watchOutOfStock: true,
    outOfStockSince: "2026-01-01T00:00:00.000Z",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  });
  const missing = buildNextState(
    stateWith(previous),
    [],
    "2026-01-02T00:00:00.000Z",
    transitionConfig,
  );
  const returned = buildNextState(
    missing.nextState,
    [item({ stock: 10 })],
    "2026-01-03T00:00:00.000Z",
    transitionConfig,
  );

  assert.equal(missing.nextState.items["goods-1"].watchOutOfStock, true);
  assert.equal(missing.nextState.items["goods-1"].missingSince, "2026-01-02T00:00:00.000Z");
  assert.equal(returned.alerts.length, 1);
  assert.equal(returned.alerts[0].alertType, "restocked");
  assert.equal(returned.alerts[0].previousStock, 0);
  assert.equal(returned.alerts[0].stock, 10);
  assert.equal(returned.nextState.items["goods-1"].missingSince, null);
});

test("missing out-of-stock goods wait to alert until reappearing stock is positive", async () => {
  const buildNextState = await loadStateTransitionFunctions();
  const previous = item({
    stock: 0,
    inStock: false,
    watchOutOfStock: true,
    outOfStockSince: "2026-01-01T00:00:00.000Z",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    missingSince: "2026-01-02T00:00:00.000Z",
  });
  const returnedEmpty = buildNextState(
    stateWith(previous),
    [item({ stock: 0 })],
    "2026-01-03T00:00:00.000Z",
    transitionConfig,
  );
  const restocked = buildNextState(
    returnedEmpty.nextState,
    [item({ stock: 10 })],
    "2026-01-04T00:00:00.000Z",
    transitionConfig,
  );

  assert.equal(returnedEmpty.alerts.length, 0);
  assert.equal(returnedEmpty.nextState.items["goods-1"].watchOutOfStock, true);
  assert.equal(returnedEmpty.nextState.items["goods-1"].missingSince, null);
  assert.equal(restocked.alerts.length, 1);
  assert.equal(restocked.alerts[0].previousStock, 0);
  assert.equal(restocked.alerts[0].stock, 10);
});

test("missing in-stock goods do not trigger a restock alert when they reappear stocked", async () => {
  const buildNextState = await loadStateTransitionFunctions();
  const previous = item({
    stock: 8,
    inStock: true,
    watchOutOfStock: false,
    outOfStockSince: null,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    missingSince: "2026-01-02T00:00:00.000Z",
  });
  const returned = buildNextState(
    stateWith(previous),
    [item({ stock: 10 })],
    "2026-01-03T00:00:00.000Z",
    transitionConfig,
  );

  assert.equal(returned.alerts.length, 0);
  assert.equal(returned.nextState.items["goods-1"].watchOutOfStock, false);
  assert.equal(returned.nextState.items["goods-1"].missingSince, null);
});

test("shop API retries a temporary HTML response before accepting JSON", async (t) => {
  let calls = 0;
  const requestHeaders = [];
  const responses = [
    {
      ok: true,
      status: 200,
      headers: {
        get: (name) => (name === "content-type" ? "text/html" : null),
        getSetCookie: () => ["acw_tc=test-token; Path=/; HttpOnly"],
      },
      text: async () =>
        "<html><script>var arg1='274E1264B626E35EEB058EECE01149F3496502CE';</script></html>",
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    },
    {
      ok: true,
      status: 200,
      headers: {
        get: (name) => (name === "content-type" ? "application/json" : null),
        getSetCookie: () => [],
      },
      text: async () => JSON.stringify({ code: 1, data: { total: 111 } }),
      json: async () => ({ code: 1, data: { total: 111 } }),
    },
  ];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    requestHeaders.push(options.headers);
    return responses.shift();
  };

  const result = await apiPost(
    {
      baseUrl: "https://pay.ldxp.cn",
      shopToken: "jisuai",
      apiTransport: "fetch",
      apiRetries: 3,
      apiRetryDelayMs: 1,
      requestTimeoutMs: 1000,
    },
    "visitor",
    "/shopApi/Shop/goodsList",
    { current: 1 },
  );

  assert.equal(calls, 2);
  assert.equal(result.total, 111);
  assert.match(requestHeaders[1].cookie, /acw_tc=test-token/);
  assert.match(requestHeaders[1].cookie, /acw_sc__v2=664c59426b8a81e8e837ca070833106ec6c19310/);
});

test("shop API switches to persistent browser transport for an HTML challenge", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (name) => (name === "content-type" ? "text/html; charset=utf-8" : null),
      getSetCookie: () => ["acw_tc=test-token; Path=/; HttpOnly"],
    },
    text: async () => "<!doctype html><script src='/challenge.js'></script>",
  });

  let browserCalls = 0;
  const cfg = {
    baseUrl: "https://pay.ldxp.cn",
    shopToken: "jisuai",
    apiTransport: "auto",
    apiRetries: 1,
    apiRetryDelayMs: 1,
    requestTimeoutMs: 1000,
    _browserTransportPromise: Promise.resolve({
      post: async () => {
        browserCalls += 1;
        return {
          ok: true,
          status: 200,
          contentType: "application/json; charset=utf-8",
          raw: JSON.stringify({ code: 1, data: { total: 129 } }),
        };
      },
      close: async () => {},
    }),
  };

  const result = await apiPost(cfg, "visitor", "/shopApi/Shop/goodsList", { current: 1 });
  const secondResult = await apiPost(cfg, "visitor", "/shopApi/Shop/goodsList", { current: 2 });

  assert.equal(browserCalls, 2);
  assert.equal(result.total, 129);
  assert.equal(secondResult.total, 129);
  assert.equal(cfg._browserPreferred, true);
});

test("shop API recreates a crashed browser transport", async () => {
  let factories = 0;
  let closed = 0;
  const cfg = {
    baseUrl: "https://pay.ldxp.cn",
    shopToken: "jisuai",
    apiTransport: "browser",
    apiRetries: 2,
    apiRetryDelayMs: 1,
    requestTimeoutMs: 1000,
    browserTransportFactory: async () => {
      factories += 1;
      const instance = factories;
      return {
        post: async () => {
          if (instance === 1) {
            const error = new Error("page crashed");
            error.code = "BROWSER_REQUEST_FAILED";
            throw error;
          }
          return {
            ok: true,
            status: 200,
            contentType: "application/json",
            raw: JSON.stringify({ code: 1, data: { total: 130 } }),
          };
        },
        close: async () => {
          closed += 1;
        },
      };
    },
  };

  const result = await apiPost(cfg, "visitor", "/shopApi/Shop/goodsList", { current: 1 });

  assert.equal(result.total, 130);
  assert.equal(factories, 2);
  assert.equal(closed, 1);
});
