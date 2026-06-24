#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const defaults = {
  baseUrl: "https://pay.ldxp.cn",
  shopToken: "jisuai",
  goodsTypes: ["card"],
  pageSize: 100,
  requestDelayMs: 250,
  touchUnchanged: true,
  stateFile: path.join(rootDir, "data", "ldxp-stock-state.json"),
  alertFile: path.join(rootDir, "data", "ldxp-stock-alerts.md"),
  emailConfigFile: path.join(rootDir, "data", "ldxp-stock-email.json"),
  webhookUrl: process.env.LDXP_NOTIFY_WEBHOOK || "",
  telegram: {
    botToken: process.env.LDXP_TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.LDXP_TELEGRAM_CHAT_ID || "",
    threadId: process.env.LDXP_TELEGRAM_THREAD_ID || "",
  },
  email: {
    to: process.env.LDXP_NOTIFY_EMAIL_TO || "",
    from: process.env.LDXP_NOTIFY_EMAIL_FROM || process.env.LDXP_SMTP_USER || "",
    subjectPrefix: process.env.LDXP_NOTIFY_EMAIL_SUBJECT_PREFIX || "极速AI库存补货提醒",
    smtpHost: process.env.LDXP_SMTP_HOST || "",
    smtpPort: Number(process.env.LDXP_SMTP_PORT || 587),
    smtpSecure: parseBool(process.env.LDXP_SMTP_SECURE, false),
    smtpUser: process.env.LDXP_SMTP_USER || "",
    smtpPass: process.env.LDXP_SMTP_PASS || "",
  },
};

function parseArgs(argv) {
  const cfg = { ...defaults };
  const flags = {
    json: false,
    listOut: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--json") flags.json = true;
    else if (arg === "--list-out") flags.listOut = true;
    else if (arg === "--no-touch-unchanged") cfg.touchUnchanged = false;
    else if (arg === "--base-url" && next) {
      cfg.baseUrl = next.replace(/\/+$/, "");
      i += 1;
    } else if (arg === "--shop-token" && next) {
      cfg.shopToken = next;
      i += 1;
    } else if (arg === "--goods-types" && next) {
      cfg.goodsTypes = next.split(",").map((type) => type.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--state" && next) {
      cfg.stateFile = path.resolve(next);
      i += 1;
    } else if (arg === "--alerts" && next) {
      cfg.alertFile = path.resolve(next);
      i += 1;
    } else if (arg === "--email-config" && next) {
      cfg.emailConfigFile = path.resolve(next);
      i += 1;
    } else if (arg === "--webhook" && next) {
      cfg.webhookUrl = next;
      i += 1;
    } else if (arg === "--email-to" && next) {
      cfg.email.to = next;
      i += 1;
    } else if (arg === "--email-from" && next) {
      cfg.email.from = next;
      i += 1;
    } else if (arg === "--smtp-host" && next) {
      cfg.email.smtpHost = next;
      i += 1;
    } else if (arg === "--smtp-port" && next) {
      cfg.email.smtpPort = Number(next);
      i += 1;
    } else if (arg === "--smtp-user" && next) {
      cfg.email.smtpUser = next;
      cfg.email.from ||= next;
      i += 1;
    } else if (arg === "--smtp-secure" && next) {
      cfg.email.smtpSecure = parseBool(next, cfg.email.smtpSecure);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return { cfg, flags };
}

function printHelp() {
  console.log(`
Usage:
  node scripts/monitor-ldxp-stock.mjs

Options:
  --list-out              Print current out-of-stock goods.
  --json                  Print machine-readable result JSON.
  --no-touch-unchanged    Do not rewrite unchanged state entries.
  --shop-token TOKEN      Shop token, default: jisuai.
  --goods-types TYPES     Comma-separated goods types, default: card.
  --state PATH            State file path.
  --alerts PATH           Alert log path.
  --email-config PATH     Optional email config JSON path.
  --webhook URL           Optional generic JSON webhook URL.
  --email-to EMAIL        Optional recipient email.
  --email-from EMAIL      Optional sender email.
  --smtp-host HOST        Optional SMTP host.
  --smtp-port PORT        Optional SMTP port, default: 587.
  --smtp-user USER        Optional SMTP username.
  --smtp-secure BOOL      Use implicit TLS, usually true for port 465.

Environment:
  LDXP_NOTIFY_WEBHOOK     Optional generic JSON webhook URL.
  LDXP_TELEGRAM_BOT_TOKEN Telegram bot token.
  LDXP_TELEGRAM_CHAT_ID   Telegram group chat ID.
  LDXP_TELEGRAM_THREAD_ID Optional Telegram topic ID.
  LDXP_NOTIFY_EMAIL_TO    Recipient email.
  LDXP_NOTIFY_EMAIL_FROM  Sender email, defaults to LDXP_SMTP_USER.
  LDXP_SMTP_HOST          SMTP host, for example smtp.gmail.com.
  LDXP_SMTP_PORT          SMTP port, usually 587 or 465.
  LDXP_SMTP_SECURE        true for implicit TLS on port 465.
  LDXP_SMTP_USER          SMTP username.
  LDXP_SMTP_PASS          SMTP password or app password.
`);
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function makeVisitorId() {
  return Math.random().toString(36).slice(2, 11);
}

async function loadState(file) {
  if (!existsSync(file)) {
    return {
      version: 1,
      visitorId: makeVisitorId(),
      items: {},
      runs: 0,
      createdAt: new Date().toISOString(),
    };
  }

  const raw = await readFile(file, "utf8");
  const state = JSON.parse(raw);
  state.items ??= {};
  state.visitorId ||= makeVisitorId();
  state.version ||= 1;
  state.runs ||= 0;
  return state;
}

async function mergeEmailConfigFile(cfg) {
  if (!existsSync(cfg.emailConfigFile)) return;

  const raw = await readFile(cfg.emailConfigFile, "utf8");
  const fileConfig = JSON.parse(raw);
  const email = fileConfig.email || fileConfig;

  cfg.email = {
    ...cfg.email,
    ...Object.fromEntries(
      Object.entries(email).filter(([, value]) => value !== undefined && value !== null && value !== ""),
    ),
  };

  cfg.email.smtpPort = Number(cfg.email.smtpPort || 587);
  cfg.email.smtpSecure = parseBool(cfg.email.smtpSecure, false);
  cfg.email.from ||= cfg.email.smtpUser;
}

async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiPost(cfg, visitorId, endpoint, payload) {
  const response = await fetch(`${cfg.baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json;charset=UTF-8",
      origin: cfg.baseUrl,
      referer: `${cfg.baseUrl}/shop/${cfg.shopToken}`,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      visitorid: visitorId,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`${endpoint} HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.code !== 1) {
    throw new Error(`${endpoint} API ${data.code}: ${data.msg || "unknown error"}`);
  }
  return data.data;
}

async function fetchGoodsByType(cfg, visitorId, goodsType) {
  const all = [];
  let current = 1;
  let total = Infinity;

  while (all.length < total) {
    const data = await apiPost(cfg, visitorId, "/shopApi/Shop/goodsList", {
      token: cfg.shopToken,
      keywords: "",
      category_id: 0,
      goods_type: goodsType,
      current,
      pageSize: cfg.pageSize,
    });

    const list = Array.isArray(data.list) ? data.list : [];
    all.push(...list);
    total = Number.isFinite(Number(data.total)) ? Number(data.total) : all.length;

    if (list.length === 0 || all.length >= total) break;
    current += 1;
    await sleep(cfg.requestDelayMs);
  }

  return all;
}

async function fetchAllGoods(cfg, visitorId) {
  const seen = new Map();

  for (const goodsType of cfg.goodsTypes) {
    const goods = await fetchGoodsByType(cfg, visitorId, goodsType);
    for (const item of goods) {
      const normalized = normalizeItem(cfg, item);
      if (normalized.key) seen.set(normalized.key, normalized);
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function normalizeItem(cfg, item) {
  const stock = readStock(item);
  const key = String(item.goods_key || item.id || item.link || "");
  return {
    key,
    name: String(item.name || key),
    link: item.link || `${cfg.baseUrl}/item/${key}`,
    goodsType: item.goods_type || "",
    categoryId: item.category?.id ?? null,
    categoryName: item.category?.name || "",
    price: Number(item.price ?? item.real_price ?? 0),
    stock,
    inStock: stock > 0,
  };
}

function readStock(item) {
  const candidates = [
    item?.extend?.stock_count,
    item?.stock_count,
    item?.stock,
    item?.inventory,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function buildNextState(previousState, goods, checkedAt, cfg) {
  const previousItems = previousState.items || {};
  const nextItems = { ...previousItems };
  const alerts = [];
  const seenKeys = new Set();
  let stateChanged = false;

  for (const item of goods) {
    const prev = previousItems[item.key];
    const wasWatchedOut = Boolean(prev?.watchOutOfStock) || Number(prev?.stock ?? 0) <= 0;
    const isRestocked = Boolean(prev) && wasWatchedOut && item.stock > 0;
    const changed = hasItemChanged(prev, item);

    if (isRestocked) {
      alerts.push({
        ...item,
        previousStock: Number(prev.stock ?? 0),
        outOfStockSince: prev.outOfStockSince || null,
        checkedAt,
      });
    }

    if (!cfg.touchUnchanged && prev && !changed) {
      nextItems[item.key] = prev;
      seenKeys.add(item.key);
      continue;
    }

    stateChanged ||= changed;
    nextItems[item.key] = {
      ...item,
      watchOutOfStock: item.stock <= 0,
      outOfStockSince: item.stock <= 0 ? prev?.outOfStockSince || checkedAt : null,
      firstSeenAt: prev?.firstSeenAt || checkedAt,
      lastSeenAt: checkedAt,
      lastChangedAt: prev && Number(prev.stock) !== item.stock ? checkedAt : prev?.lastChangedAt || checkedAt,
      missingSince: null,
    };
    seenKeys.add(item.key);
  }

  for (const [key, prev] of Object.entries(previousItems)) {
    if (!seenKeys.has(key)) {
      stateChanged ||= !prev.missingSince;
      nextItems[key] = {
        ...prev,
        missingSince: prev.missingSince || checkedAt,
      };
    }
  }

  const shouldTouchRun = cfg.touchUnchanged || stateChanged;

  return {
    nextState: {
      version: 1,
      shop: `${cfg.baseUrl}/shop/${cfg.shopToken}`,
      shopToken: cfg.shopToken,
      goodsTypes: cfg.goodsTypes,
      visitorId: previousState.visitorId,
      runs: shouldTouchRun ? Number(previousState.runs || 0) + 1 : Number(previousState.runs || 0),
      createdAt: previousState.createdAt || checkedAt,
      updatedAt: shouldTouchRun ? checkedAt : previousState.updatedAt,
      items: nextItems,
    },
    alerts,
  };
}

function hasItemChanged(prev, item) {
  if (!prev) return true;
  if (prev.missingSince) return true;

  return (
    String(prev.name || "") !== item.name ||
    String(prev.link || "") !== item.link ||
    String(prev.goodsType || "") !== item.goodsType ||
    String(prev.categoryName || "") !== item.categoryName ||
    Number(prev.categoryId ?? 0) !== Number(item.categoryId ?? 0) ||
    Number(prev.price ?? 0) !== item.price ||
    Number(prev.stock ?? 0) !== item.stock ||
    Boolean(prev.inStock) !== item.inStock ||
    Boolean(prev.watchOutOfStock) !== (item.stock <= 0)
  );
}

async function appendAlerts(file, alerts) {
  if (alerts.length === 0) return;

  const lines = [];
  lines.push(`## ${new Date().toISOString()}`);
  for (const alert of alerts) {
    lines.push(`- ${alert.name}`);
    lines.push(`  - Stock: ${alert.previousStock} -> ${alert.stock}`);
    lines.push(`  - Price: ${alert.price}`);
    lines.push(`  - Category: ${alert.categoryName}`);
    lines.push(`  - Link: ${alert.link}`);
  }
  lines.push("");

  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${lines.join("\n")}\n`, "utf8");
}

async function sendWebhook(cfg, alerts) {
  if (!cfg.webhookUrl || alerts.length === 0) return;

  const text = alerts
    .map((alert) => `${alert.name}\nStock: ${alert.previousStock} -> ${alert.stock}\n${alert.link}`)
    .join("\n\n");

  const response = await fetch(cfg.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: `LDXP restock alert: ${alerts.length} item(s)\n\n${text}`,
      alerts,
    }),
  });

  if (!response.ok) {
    throw new Error(`webhook HTTP ${response.status}`);
  }
}

function formatTelegramMessage(alert) {
  const name = escapeTelegramHtml(alert.name);
  const link = escapeTelegramHtml(alert.link);
  const price = Number.isFinite(Number(alert.price)) ? Number(alert.price).toFixed(2) : String(alert.price);

  return [
    "补货啦，刚刚有新库存！",
    "",
    `商品：${name}`,
    `库存：${alert.previousStock} → ${alert.stock}`,
    `售价：¥${price}`,
    `商品链接：${link}`,
  ].join("\n");
}

function escapeTelegramHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function sendTelegram(cfg, alerts) {
  if (alerts.length === 0 || (!cfg.telegram.botToken && !cfg.telegram.chatId)) return;
  if (!cfg.telegram.botToken || !cfg.telegram.chatId) {
    throw new Error("Telegram config requires LDXP_TELEGRAM_BOT_TOKEN and LDXP_TELEGRAM_CHAT_ID");
  }

  for (const alert of alerts) {
    const payload = {
      chat_id: cfg.telegram.chatId,
      text: formatTelegramMessage(alert),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };

    if (cfg.telegram.threadId) {
      payload.message_thread_id = Number(cfg.telegram.threadId);
    }

    await sendTelegramRequest(cfg.telegram.botToken, payload);
  }
}

async function sendTelegramRequest(botToken, payload) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));

    if (response.ok && result.ok !== false) return;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 3) {
      throw new Error(`Telegram HTTP ${response.status}: ${result.description || "request failed"}`);
    }

    const retryAfter = Number(result.parameters?.retry_after || attempt * 2);
    await sleep(retryAfter * 1000);
  }
}

async function sendEmail(cfg, alerts) {
  if (alerts.length === 0 || !hasAnyEmailConfig(cfg.email)) return;

  validateEmailConfig(cfg.email);
  const toList = splitEmails(cfg.email.to);
  const subject = `${cfg.email.subjectPrefix}: ${alerts.length} 个商品补货`;
  const body = [
    `${alerts.length} 个缺货商品已经有新增库存：`,
    "",
    ...alerts.flatMap((alert) => [
      `${alert.name}`,
      `库存：${alert.previousStock} -> ${alert.stock}`,
      `价格：${alert.price}`,
      `分类：${alert.categoryName}`,
      `链接：${alert.link}`,
      "",
    ]),
    `检查时间：${new Date().toISOString()}`,
  ].join("\n");

  await smtpSend({
    host: cfg.email.smtpHost,
    port: cfg.email.smtpPort,
    secure: cfg.email.smtpSecure,
    user: cfg.email.smtpUser,
    pass: cfg.email.smtpPass,
    from: cfg.email.from,
    to: toList,
    subject,
    body,
  });
}

function hasAnyEmailConfig(email) {
  return Boolean(
    email.to ||
      email.from ||
      email.smtpHost ||
      email.smtpUser ||
      email.smtpPass ||
      process.env.LDXP_NOTIFY_EMAIL_TO,
  );
}

function validateEmailConfig(email) {
  const missing = [];
  if (!email.to) missing.push("LDXP_NOTIFY_EMAIL_TO");
  if (!email.from) missing.push("LDXP_NOTIFY_EMAIL_FROM or LDXP_SMTP_USER");
  if (!email.smtpHost) missing.push("LDXP_SMTP_HOST");
  if (!email.smtpPort || !Number.isFinite(Number(email.smtpPort))) missing.push("LDXP_SMTP_PORT");
  if (!email.smtpUser) missing.push("LDXP_SMTP_USER");
  if (!email.smtpPass) missing.push("LDXP_SMTP_PASS");

  if (missing.length > 0) {
    throw new Error(`email config missing: ${missing.join(", ")}`);
  }
}

function splitEmails(value) {
  return String(value)
    .split(/[;,]/)
    .map((email) => email.trim())
    .filter(Boolean);
}

async function smtpSend(options) {
  let session = await openSmtpSession(options);
  try {
    await expectSmtp(session, [220]);
    await smtpCommand(session, "EHLO localhost", [250]);

    if (!options.secure) {
      await smtpCommand(session, "STARTTLS", [220]);
      session = await upgradeSmtpTls(session, options.host);
      await smtpCommand(session, "EHLO localhost", [250]);
    }

    if (options.user || options.pass) {
      await smtpCommand(session, "AUTH LOGIN", [334]);
      await smtpCommand(session, Buffer.from(options.user).toString("base64"), [334]);
      await smtpCommand(session, Buffer.from(options.pass).toString("base64"), [235]);
    }

    await smtpCommand(session, `MAIL FROM:<${options.from}>`, [250]);
    for (const recipient of options.to) {
      await smtpCommand(session, `RCPT TO:<${recipient}>`, [250, 251]);
    }
    await smtpCommand(session, "DATA", [354]);
    session.write(`${formatEmailMessage(options)}\r\n.`);
    await expectSmtp(session, [250]);
    await smtpCommand(session, "QUIT", [221]);
  } finally {
    session.socket.end();
  }
}

async function openSmtpSession(options) {
  const socket = options.secure
    ? tls.connect({ host: options.host, port: options.port, servername: options.host })
    : net.connect({ host: options.host, port: options.port });

  await once(socket, options.secure ? "secureConnect" : "connect");
  return createSmtpSession(socket);
}

async function upgradeSmtpTls(session, host) {
  session.socket.removeAllListeners("data");
  const socket = tls.connect({ socket: session.socket, servername: host });
  await once(socket, "secureConnect");
  return createSmtpSession(socket);
}

function createSmtpSession(socket) {
  let buffer = "";
  const waiters = [];

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (waiters.length > 0) waiters.shift()();
  });

  return {
    socket,
    write(command) {
      socket.write(`${command}\r\n`);
    },
    async read() {
      let response = tryReadSmtpResponse();
      while (!response) {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            socket.off("close", onClose);
            reject(error);
          };
          const onClose = () => {
            socket.off("error", onError);
            reject(new Error("smtp socket closed"));
          };
          waiters.push(() => {
            socket.off("error", onError);
            socket.off("close", onClose);
            resolve();
          });
          socket.once("error", onError);
          socket.once("close", onClose);
        });
        response = tryReadSmtpResponse();
      }
      return response;
    },
  };

  function tryReadSmtpResponse() {
    let pos = 0;
    let code = null;
    const lines = [];

    while (true) {
      const newlineIndex = buffer.indexOf("\n", pos);
      if (newlineIndex === -1) return null;

      const line = buffer.slice(pos, newlineIndex).replace(/\r$/, "");
      pos = newlineIndex + 1;
      const match = line.match(/^(\d{3})([- ])/);
      if (!match) continue;

      code ||= match[1];
      if (match[1] === code) lines.push(line);
      if (match[1] === code && match[2] === " ") {
        buffer = buffer.slice(pos);
        return { code: Number(code), lines };
      }
    }
  }
}

async function smtpCommand(session, command, expectedCodes) {
  session.write(command);
  return expectSmtp(session, expectedCodes);
}

async function expectSmtp(session, expectedCodes) {
  const response = await session.read();
  if (!expectedCodes.includes(response.code)) {
    throw new Error(`smtp ${response.code}: ${response.lines.join(" | ")}`);
  }
  return response;
}

function formatEmailMessage(options) {
  const encodedBody = Buffer.from(options.body, "utf8")
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n") || "";
  const headers = [
    `From: ${options.from}`,
    `To: ${options.to.join(", ")}`,
    `Subject: ${encodeMimeHeader(options.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];

  return [...headers, "", encodedBody]
    .join("\r\n")
    .split(/\r?\n/)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function encodeMimeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function summarize(goods, alerts) {
  const outOfStock = goods.filter((item) => item.stock <= 0);
  return {
    checkedAt: new Date().toISOString(),
    totalGoods: goods.length,
    outOfStockCount: outOfStock.length,
    restockedCount: alerts.length,
    alerts,
    outOfStock,
  };
}

function printResult(summary, flags) {
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (summary.restockedCount > 0) {
    console.log(`RESTOCK_ALERT ${summary.restockedCount}`);
    for (const alert of summary.alerts) {
      console.log(`- [${alert.stock}] ${alert.name}`);
      console.log(`  ${alert.link}`);
    }
  } else {
    console.log(
      `OK checked ${summary.totalGoods} goods, out_of_stock ${summary.outOfStockCount}, restocked 0, time ${summary.checkedAt}`,
    );
  }

  if (flags.listOut && summary.outOfStock.length > 0) {
    console.log("");
    console.log("OUT_OF_STOCK");
    for (const item of summary.outOfStock) {
      console.log(`- ${item.name}`);
      console.log(`  ${item.link}`);
    }
  }
}

async function main() {
  const { cfg, flags } = parseArgs(process.argv.slice(2));
  await mergeEmailConfigFile(cfg);
  const checkedAt = new Date().toISOString();
  const state = await loadState(cfg.stateFile);
  const goods = await fetchAllGoods(cfg, state.visitorId);
  const { nextState, alerts } = buildNextState(state, goods, checkedAt, cfg);
  const summary = summarize(goods, alerts);
  summary.checkedAt = checkedAt;

  await sendWebhook(cfg, alerts);
  await sendTelegram(cfg, alerts);
  await sendEmail(cfg, alerts);
  await appendAlerts(cfg.alertFile, alerts);
  await saveState(cfg.stateFile, nextState);
  printResult(summary, flags);
}

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 1;
});
