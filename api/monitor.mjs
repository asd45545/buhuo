import { Buffer } from "node:buffer";

import {
  buildNextState,
  defaults,
  fetchAllGoods,
  makeVisitorId,
  sendTelegram,
  summarize,
} from "../scripts/monitor-ldxp-stock.mjs";

export const config = {
  maxDuration: 300,
};

const defaultStatePath = "data/ldxp-stock-state.json";
const defaultAlertPath = "data/ldxp-stock-alerts.md";

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const authHeader = req.headers.authorization || "";
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  const checkedAt = new Date().toISOString();
  try {
    const store = createGitHubStore();
    const state = await store.readJson(defaultState(), store.statePath);
    const cfg = createMonitorConfig();
    const goods = await fetchAllGoods(cfg, state.visitorId || makeVisitorId());
    const { nextState, alerts } = buildNextState(state, goods, checkedAt, cfg);
    const summary = summarize(goods, alerts);
    summary.checkedAt = checkedAt;
    const stateChanged = toJsonFile(nextState) !== toJsonFile(state);

    await sendTelegram(cfg, alerts);
    if (stateChanged) {
      await store.writeJson(nextState, store.statePath, `chore: update ldxp stock state ${checkedAt}`);
    }
    if (alerts.length > 0) {
      await store.appendText(formatAlertMarkdown(alerts, checkedAt), store.alertPath, `chore: append ldxp restock alerts ${checkedAt}`);
    }

    return sendJson(res, 200, {
      ok: true,
      checkedAt,
      totalGoods: summary.totalGoods,
      outOfStockCount: summary.outOfStockCount,
      restockedCount: summary.restockedCount,
      stateChanged,
      alerts: alerts.map((alert) => ({
        name: alert.name,
        previousStock: alert.previousStock,
        stock: alert.stock,
        price: alert.price,
        link: alert.link,
      })),
    });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, {
      ok: false,
      checkedAt,
      error: error.message,
    });
  }
}

function createMonitorConfig() {
  return {
    ...defaults,
    touchUnchanged: false,
    telegram: {
      botToken: process.env.LDXP_TELEGRAM_BOT_TOKEN || "",
      chatId: process.env.LDXP_TELEGRAM_CHAT_ID || "",
      threadId: process.env.LDXP_TELEGRAM_THREAD_ID || "",
    },
  };
}

function defaultState() {
  const now = new Date().toISOString();
  return {
    version: 1,
    visitorId: makeVisitorId(),
    items: {},
    runs: 0,
    createdAt: now,
  };
}

function createGitHubStore() {
  const token = process.env.LDXP_GITHUB_TOKEN;
  if (!token) {
    throw new Error("missing env LDXP_GITHUB_TOKEN");
  }

  return {
    ownerRepo: process.env.LDXP_STATE_REPO || "asd45545/buhuo",
    branch: process.env.LDXP_STATE_BRANCH || "main",
    statePath: process.env.LDXP_STATE_FILE || defaultStatePath,
    alertPath: process.env.LDXP_ALERT_FILE || defaultAlertPath,
    async readJson(fallback, filePath) {
      const file = await this.readFile(filePath);
      if (!file) return fallback;
      return JSON.parse(file.content);
    },
    async writeJson(value, filePath, message) {
      await this.writeFile(filePath, toJsonFile(value), message);
    },
    async appendText(text, filePath, message) {
      const file = await this.readFile(filePath);
      await this.writeFile(filePath, `${file?.content || ""}${text}`, message, file?.sha);
    },
    async readFile(filePath) {
      const response = await githubFetch(this, filePath);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`GitHub read ${filePath} HTTP ${response.status}: ${await response.text()}`);
      }
      const data = await response.json();
      return {
        sha: data.sha,
        content: Buffer.from(String(data.content || "").replace(/\s+/g, ""), "base64").toString("utf8"),
      };
    },
    async writeFile(filePath, content, message, knownSha) {
      const current = knownSha ? { sha: knownSha } : await this.readFile(filePath);
      const response = await githubFetch(this, filePath, {
        method: "PUT",
        body: JSON.stringify({
          message,
          branch: this.branch,
          content: Buffer.from(content, "utf8").toString("base64"),
          sha: current?.sha,
        }),
      });

      if (!response.ok) {
        throw new Error(`GitHub write ${filePath} HTTP ${response.status}: ${await response.text()}`);
      }
    },
  };

  async function githubFetch(store, filePath, options = {}) {
    const refQuery = options.method === "PUT" ? "" : `?ref=${encodeURIComponent(store.branch)}`;
    const url = `https://api.github.com/repos/${store.ownerRepo}/contents/${filePath}${refQuery}`;
    return fetch(url, {
      ...options,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "ldxp-vercel-stock-monitor",
        "x-github-api-version": "2022-11-28",
        ...options.headers,
      },
    });
  }
}

function toJsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatAlertMarkdown(alerts, checkedAt) {
  const lines = [`## ${checkedAt}`];
  for (const alert of alerts) {
    lines.push(`- ${alert.name}`);
    lines.push(`  - Stock: ${alert.previousStock} -> ${alert.stock}`);
    lines.push(`  - Price: ${alert.price}`);
    lines.push(`  - Category: ${alert.categoryName}`);
    lines.push(`  - Link: ${alert.link}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
