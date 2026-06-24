import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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
      "补货啦，刚刚有新库存！",
      "",
      "商品：ChatGPT Plus 月卡",
      "库存：0 → 25",
      "售价：¥19.90",
      "商品链接：https://example.com/item/1?a=1&amp;b=2",
    ].join("\n"),
  );
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

test("temporarily missing goods keep their prior out-of-stock watch state", async () => {
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
  assert.equal(returned.nextState.items["goods-1"].missingSince, null);
});

test("shop API retries a temporary HTML response before accepting JSON", async () => {
  const source = await readFile(new URL("./monitor-ldxp-stock.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function sleep");
  const end = source.indexOf("async function fetchGoodsByType", start);
  assert.notEqual(start, -1, "sleep should exist");
  assert.notEqual(end, -1, "API helper block should be extractable");

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
  const context = vm.createContext({
    fetch: async (_url, options) => {
      calls += 1;
      requestHeaders.push(options.headers);
      return responses.shift();
    },
    setTimeout: (resolve) => resolve(),
  });
  vm.runInContext(`${source.slice(start, end)}; globalThis.apiPost = apiPost;`, context);

  const result = await context.apiPost(
    {
      baseUrl: "https://pay.ldxp.cn",
      shopToken: "jisuai",
      apiRetries: 3,
      apiRetryDelayMs: 1,
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
