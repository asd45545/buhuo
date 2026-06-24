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
      "商品：ChatGPT Plus 月卡",
      "库存：0 → 25",
      "售价：¥19.90",
      '<a href="https://example.com/item/1?a=1&amp;b=2">商品链接</a>',
    ].join("\n"),
  );
});
