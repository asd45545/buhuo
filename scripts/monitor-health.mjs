import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const STATUS_SCHEMA_VERSION = 1;
const MAX_RECENT_POLLS = 48;
const MAX_RECENT_RESTOCKS = 30;

function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeError(error) {
  const code = String(error?.code || "UNKNOWN")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "_")
    .slice(0, 64) || "UNKNOWN";
  const message = code.includes("TIMEOUT")
    ? "Monitor request timed out"
    : code.includes("WAF") || code.includes("CHALLENGE")
      ? "Shop request was blocked"
      : code.includes("PROXY")
        ? "Proxy connection failed"
        : code.includes("BROWSER")
          ? "Browser transport failed"
          : code.includes("SHOP_API")
            ? "Shop API request failed"
            : "Monitor request failed";

  return { code, message };
}

function safeProductLink(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.hostname !== "pay.ldxp.cn") return "";
    if (!url.pathname.startsWith("/item/")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function sanitizeProduct(item) {
  const missingSince = item?.missingSince || null;
  const stock = finiteNumber(item?.stock, 0);
  const status = missingSince ? "missing" : stock > 0 ? "in_stock" : "out_of_stock";

  return {
    key: String(item?.key || "").slice(0, 160),
    name: String(item?.name || "Unnamed product").slice(0, 300),
    link: safeProductLink(item?.link),
    category: {
      id: finiteNumber(item?.categoryId, 0),
      name: String(item?.categoryName || "未分类").slice(0, 120),
    },
    price: finiteNumber(item?.price, 0),
    stock,
    status,
    firstSeenAt: item?.firstSeenAt || null,
    lastSeenAt: item?.lastSeenAt || null,
    lastChangedAt: item?.lastChangedAt || null,
    outOfStockSince: item?.outOfStockSince || null,
    missingSince,
  };
}

function buildInventorySnapshot(state = {}) {
  const products = Object.values(state.items || {})
    .map(sanitizeProduct)
    .filter((item) => item.key)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const activeProducts = products.filter((item) => item.status !== "missing");
  const inStockTotal = activeProducts.filter((item) => item.status === "in_stock").length;
  const outOfStockTotal = activeProducts.filter((item) => item.status === "out_of_stock").length;

  return {
    activeTotal: activeProducts.length,
    inStockTotal,
    outOfStockTotal,
    missingTotal: products.length - activeProducts.length,
    snapshotAt: state.updatedAt || null,
    products,
  };
}

function normalizeExisting(existing = {}) {
  return {
    recentPolls: Array.isArray(existing.recentPolls)
      ? existing.recentPolls.slice(-MAX_RECENT_POLLS)
      : [],
    recentRestocks: Array.isArray(existing.recentRestocks)
      ? existing.recentRestocks.slice(-MAX_RECENT_RESTOCKS)
      : [],
    processStarts: Math.max(0, finiteNumber(existing.process?.starts, 0)),
  };
}

function createMonitorStatus(options = {}, existing = {}) {
  const now = options.now || isoNow();
  const previous = normalizeExisting(existing);

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    updatedAt: now,
    process: {
      pid: finiteNumber(options.pid, process.pid),
      startedAt: now,
      stoppedAt: null,
      starts: previous.processStarts + 1,
    },
    schedule: {
      intervalMs: Math.max(30_000, finiteNumber(options.intervalMs, 300_000)),
      nextExpectedPollAt: now,
    },
    monitor: {
      lifecycle: "starting",
      transport: String(options.transport || "unknown").slice(0, 32),
      lastPoll: null,
      lastSuccessAt: existing.monitor?.lastSuccessAt || null,
      consecutiveFailures: 0,
      lastError: null,
    },
    inventory: existing.inventory || {
      activeTotal: 0,
      inStockTotal: 0,
      outOfStockTotal: 0,
      missingTotal: 0,
      snapshotAt: null,
      products: [],
    },
    recentPolls: previous.recentPolls,
    recentRestocks: previous.recentRestocks,
  };
}

function markPollStarted(status, startedAt = isoNow()) {
  return {
    ...status,
    updatedAt: startedAt,
    monitor: {
      ...status.monitor,
      lifecycle: "checking",
      lastPoll: {
        status: "running",
        startedAt,
        finishedAt: null,
        durationMs: null,
        totalGoods: status.monitor?.lastPoll?.totalGoods ?? null,
        outOfStockCount: status.monitor?.lastPoll?.outOfStockCount ?? null,
        restockCount: 0,
        notificationCount: 0,
      },
    },
  };
}

function appendLimited(items, value, limit) {
  return [...items, value].slice(-limit);
}

function sanitizeRestock(alert, checkedAt) {
  return {
    checkedAt,
    key: String(alert?.key || "").slice(0, 160),
    name: String(alert?.name || "Unnamed product").slice(0, 300),
    link: safeProductLink(alert?.link),
    categoryName: String(alert?.categoryName || "未分类").slice(0, 120),
    price: finiteNumber(alert?.price, 0),
    previousStock: alert?.previousStock ?? null,
    stock: finiteNumber(alert?.stock, 0),
    alertType: String(alert?.alertType || "restock").slice(0, 64),
    notificationStatus: "sent",
  };
}

function recordPollSuccess(status, summary, inventory, options = {}) {
  const startedAt = options.startedAt || status.monitor?.lastPoll?.startedAt || isoNow();
  const finishedAt = options.finishedAt || isoNow();
  const durationMs = Math.max(0, finiteNumber(options.durationMs, 0));
  const intervalMs = status.schedule.intervalMs;
  const nextExpectedPollAt = new Date(
    Math.max(Date.parse(startedAt) + intervalMs, Date.parse(finishedAt)),
  ).toISOString();
  const poll = {
    status: "success",
    startedAt,
    finishedAt,
    durationMs,
    totalGoods: finiteNumber(summary?.totalGoods, inventory?.activeTotal || 0),
    outOfStockCount: finiteNumber(summary?.outOfStockCount, inventory?.outOfStockTotal || 0),
    restockCount: finiteNumber(summary?.restockedCount, 0),
    notificationCount: finiteNumber(summary?.restockedCount, 0),
  };
  const recentRestocks = (summary?.alerts || []).reduce(
    (items, alert) =>
      appendLimited(items, sanitizeRestock(alert, summary.checkedAt || finishedAt), MAX_RECENT_RESTOCKS),
    status.recentRestocks || [],
  );

  return {
    ...status,
    updatedAt: finishedAt,
    schedule: {
      ...status.schedule,
      nextExpectedPollAt,
    },
    monitor: {
      ...status.monitor,
      lifecycle: "healthy",
      lastPoll: poll,
      lastSuccessAt: finishedAt,
      consecutiveFailures: 0,
      lastError: null,
    },
    inventory,
    recentPolls: appendLimited(status.recentPolls || [], poll, MAX_RECENT_POLLS),
    recentRestocks,
  };
}

function recordPollFailure(status, error, options = {}) {
  const startedAt = options.startedAt || status.monitor?.lastPoll?.startedAt || isoNow();
  const finishedAt = options.finishedAt || isoNow();
  const durationMs = Math.max(0, finiteNumber(options.durationMs, 0));
  const intervalMs = status.schedule.intervalMs;
  const failure = sanitizeError(error);
  const consecutiveFailures = Math.max(1, finiteNumber(options.consecutiveFailures, 1));
  const nextExpectedPollAt = new Date(
    Math.max(Date.parse(startedAt) + intervalMs, Date.parse(finishedAt)),
  ).toISOString();
  const poll = {
    status: "failure",
    startedAt,
    finishedAt,
    durationMs,
    errorCode: failure.code,
  };

  return {
    ...status,
    updatedAt: finishedAt,
    schedule: {
      ...status.schedule,
      nextExpectedPollAt,
    },
    monitor: {
      ...status.monitor,
      lifecycle: "degraded",
      lastPoll: poll,
      consecutiveFailures,
      lastError: {
        ...failure,
        at: finishedAt,
      },
    },
    recentPolls: appendLimited(status.recentPolls || [], poll, MAX_RECENT_POLLS),
  };
}

function markMonitorStopped(status, stoppedAt = isoNow()) {
  return {
    ...status,
    updatedAt: stoppedAt,
    process: {
      ...status.process,
      stoppedAt,
    },
    monitor: {
      ...status.monitor,
      lifecycle: "stopped",
    },
  };
}

async function loadMonitorStatus(file) {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.schemaVersion === STATUS_SCHEMA_VERSION ? parsed : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveMonitorStatus(file, status) {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(status)}\n`;

  try {
    await writeFile(temp, payload, { encoding: "utf8", mode: 0o644 });
    await chmod(temp, 0o644);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export {
  MAX_RECENT_POLLS,
  MAX_RECENT_RESTOCKS,
  STATUS_SCHEMA_VERSION,
  buildInventorySnapshot,
  createMonitorStatus,
  loadMonitorStatus,
  markMonitorStopped,
  markPollStarted,
  recordPollFailure,
  recordPollSuccess,
  sanitizeError,
  sanitizeProduct,
  saveMonitorStatus,
};
