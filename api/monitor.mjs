import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";

import {
  buildNextState,
  defaults,
  fetchAllGoods,
  formatTelegramMessage,
  makeVisitorId,
  summarize,
} from "../scripts/monitor-ldxp-stock.mjs";

export const config = {
  maxDuration: 300,
};

const defaultStatePath = "data/ldxp-stock-state.json";
const defaultAlertPath = "data/ldxp-stock-alerts.md";
const defaultTelegramDeleteQueuePath = "data/telegram-delete-queue.json";
const defaultTelegramWorkflow = "telegram-notify.yml";
const defaultTelegramDeleteWorkflow = "telegram-delete.yml";

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const authHeader = req.headers.authorization || "";
  const requestUrl = new URL(req.url || "/api/monitor", "https://ldxp-monitor.local");
  const querySecret = requestUrl.searchParams.get("secret") || "";
  const isAuthorized =
    !process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}` ||
    querySecret === process.env.CRON_SECRET;

  if (!isAuthorized) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  const checkedAt = new Date().toISOString();
  try {
    const store = createGitHubStore();
    const state = normalizeState(await store.readJson(defaultState(), store.statePath), checkedAt);
    const telegramDeleteQueue = await store.readJson([], store.telegramDeleteQueuePath);
    const telegramCleanupRequested = hasDueTelegramDeletion(telegramDeleteQueue, checkedAt);
    if (telegramCleanupRequested) {
      await store.dispatchTelegramCleanup();
    }

    const cfg = createMonitorConfig();
    const goods = await fetchAllGoods(cfg, state.visitorId || makeVisitorId());
    const { nextState, alerts } = buildNextState(state, goods, checkedAt, cfg);
    const pendingAlerts = mergePendingAlerts(state.pendingAlerts, alerts, checkedAt);
    const nextStateWithPending = setPendingAlerts(nextState, pendingAlerts);
    const summary = summarize(goods, alerts);
    summary.checkedAt = checkedAt;
    const stateChanged = !isDeepStrictEqual(nextStateWithPending, state);

    if (stateChanged) {
      await store.writeJson(
        nextStateWithPending,
        store.statePath,
        `chore: update ldxp stock state ${checkedAt} [skip ci]`,
      );
    }

    if (alerts.length > 0) {
      await store.appendText(
        formatAlertMarkdown(alerts, checkedAt),
        store.alertPath,
        `chore: append ldxp restock alerts ${checkedAt} [skip ci]`,
      );
    }

    let notificationsSent = 0;
    if (pendingAlerts.length > 0) {
      await dispatchTelegramNotifications(store, pendingAlerts);
      notificationsSent = pendingAlerts.length;
      const clearedState = setPendingAlerts(nextStateWithPending, []);
      await store.writeJson(
        clearedState,
        store.statePath,
        `chore: clear ldxp pending alerts ${checkedAt} [skip ci]`,
      );
    }

    return sendJson(res, 200, {
      ok: true,
      checkedAt,
      totalGoods: summary.totalGoods,
      outOfStockCount: summary.outOfStockCount,
      restockedCount: summary.restockedCount,
      stateChanged,
      notificationsSent,
      pendingNotifications: pendingAlerts.length - notificationsSent,
      telegramCleanupRequested,
      alerts: pendingAlerts.map((alert) => ({
        alertType: alert.alertType,
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

function normalizeState(state, checkedAt) {
  const next = state && typeof state === "object" ? { ...state } : defaultState();
  next.items ??= {};
  next.visitorId ||= makeVisitorId();
  next.version ||= 1;
  next.runs ||= 0;
  next.createdAt ||= checkedAt;
  if (!Array.isArray(next.pendingAlerts)) delete next.pendingAlerts;
  return next;
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
    telegramDeleteQueuePath:
      process.env.LDXP_TELEGRAM_DELETE_QUEUE_FILE || defaultTelegramDeleteQueuePath,
    telegramWorkflow: process.env.LDXP_TELEGRAM_WORKFLOW_ID || defaultTelegramWorkflow,
    telegramDeleteWorkflow:
      process.env.LDXP_TELEGRAM_DELETE_WORKFLOW_ID || defaultTelegramDeleteWorkflow,
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
        const detail = await response.text();
        throw new Error(`GitHub write ${filePath} HTTP ${response.status}: ${detail}`);
      }
    },
    async dispatchTelegram(text) {
      const response = await githubFetch(this, `/actions/workflows/${this.telegramWorkflow}/dispatches`, {
        method: "POST",
        body: JSON.stringify({
          ref: this.branch,
          inputs: { text },
        }),
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`GitHub workflow dispatch HTTP ${response.status}: ${await response.text()}`);
      }
    },
    async dispatchTelegramCleanup() {
      const response = await githubFetch(
        this,
        `/actions/workflows/${this.telegramDeleteWorkflow}/dispatches`,
        {
          method: "POST",
          body: JSON.stringify({ ref: this.branch }),
        },
      );

      if (!response.ok && response.status !== 204) {
        throw new Error(
          `GitHub cleanup workflow dispatch HTTP ${response.status}: ${await response.text()}`,
        );
      }
    },
  };

  async function githubFetch(store, filePath, options = {}) {
    const path = filePath.startsWith("/actions/")
      ? filePath
      : `/contents/${encodePath(filePath)}${options.method === "PUT" ? "" : `?ref=${encodeURIComponent(store.branch)}`}`;
    const url = `https://api.github.com/repos/${store.ownerRepo}${path}`;
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

async function dispatchTelegramNotifications(store, alerts) {
  await store.dispatchTelegram(alerts.map((alert) => formatTelegramMessage(alert)).join("\n\n"));
}

function mergePendingAlerts(existingAlerts, detectedAlerts, checkedAt) {
  const pending = new Map();

  for (const alert of Array.isArray(existingAlerts) ? existingAlerts : []) {
    if (!alert || typeof alert !== "object") continue;
    const alertId = alert.alertId || makeAlertId(alert);
    pending.set(alertId, { ...alert, alertId });
  }

  for (const alert of detectedAlerts) {
    const alertId = makeAlertId(alert);
    pending.set(alertId, {
      ...alert,
      alertId,
      queuedAt: alert.queuedAt || checkedAt,
    });
  }

  return [...pending.values()];
}

function makeAlertId(alert) {
  return [
    alert.alertType || "restocked",
    alert.key || alert.link || alert.name || "",
    String(alert.previousStock ?? ""),
    String(alert.stock ?? ""),
    alert.outOfStockSince || "",
  ].join("|");
}

function setPendingAlerts(state, pendingAlerts) {
  const next = { ...state };
  if (pendingAlerts.length > 0) {
    next.pendingAlerts = pendingAlerts;
  } else {
    delete next.pendingAlerts;
  }
  return next;
}

function hasDueTelegramDeletion(queue, checkedAt) {
  const checkedAtMs = new Date(checkedAt).getTime();
  if (!Array.isArray(queue) || Number.isNaN(checkedAtMs)) return false;

  return queue.some((entry) => {
    const deleteAtMs = new Date(entry?.deleteAt).getTime();
    return !Number.isNaN(deleteAtMs) && deleteAtMs <= checkedAtMs;
  });
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

function encodePath(filePath) {
  return filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
