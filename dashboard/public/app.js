const TOKEN_KEY = "ldxp-dashboard-token";
const PAGE_SIZE = 25;

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || "",
  overview: null,
  products: null,
  offset: 0,
  controller: null,
  refreshTimer: null,
  countdownTimer: null,
  toastTimer: null,
};

const elementIds = {
  dashboard: "dashboard",
  authScreen: "auth-screen",
  authForm: "auth-form",
  authError: "auth-error",
  tokenInput: "token-input",
  refreshButton: "refresh-button",
  lockButton: "lock-button",
  liveIndicator: "live-indicator",
  liveLabel: "live-label",
  pageRefreshedAt: "page-refreshed-at",
  refreshCountdown: "refresh-countdown",
  serviceChip: "service-chip",
  serviceStatus: "service-status",
  serviceDetail: "service-detail",
  pollDuration: "poll-duration",
  lastPoll: "last-poll",
  nextPoll: "next-poll",
  missingCount: "missing-count",
  activeProducts: "active-products",
  stockBarIn: "stock-bar-in",
  stockBarOut: "stock-bar-out",
  inStockCount: "in-stock-count",
  outStockCount: "out-stock-count",
  transportLabel: "transport-label",
  failureCount: "failure-count",
  failureDetail: "failure-detail",
  pollStrip: "poll-strip",
  successRate: "success-rate",
  averageDuration: "average-duration",
  memoryUsage: "memory-usage",
  serviceUptime: "service-uptime",
  restockCount: "restock-count",
  restockList: "restock-list",
  productResultCount: "product-result-count",
  productFilters: "product-filters",
  productQuery: "product-query",
  productStatus: "product-status",
  productCategory: "product-category",
  productSort: "product-sort",
  productsBody: "products-body",
  productsEmpty: "products-empty",
  previousPage: "previous-page",
  nextPage: "next-page",
  pageLabel: "page-label",
  toast: "toast",
};
const elements = Object.fromEntries(
  Object.entries(elementIds).map(([name, id]) => [name, document.getElementById(id)]),
);

const statusCopy = {
  healthy: { label: "运行正常", chip: "健康" },
  degraded: { label: "服务降级", chip: "需关注" },
  down: { label: "服务异常", chip: "已中断" },
  starting: { label: "正在启动", chip: "启动中" },
};

const productStatusCopy = {
  in_stock: "有货",
  out_of_stock: "缺货",
  missing: "已下架",
};

function text(element, value) {
  element.textContent = value ?? "—";
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function formatMoney(value) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

function formatDateTime(value, includeSeconds = false) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
    hour12: false,
  }).format(date);
}

function formatClock(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDuration(milliseconds) {
  const ms = Number(milliseconds);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.floor((ms % 60_000) / 1000)} 秒`;
}

function formatUptime(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function formatRelative(value) {
  const timestamp = new Date(value || "").getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const diff = Date.now() - timestamp;
  if (Math.abs(diff) < 10_000) return "刚刚";
  const future = diff < 0;
  const absolute = Math.abs(diff);
  const amount = absolute < 60_000
    ? `${Math.ceil(absolute / 1000)} 秒`
    : absolute < 3_600_000
      ? `${Math.ceil(absolute / 60_000)} 分钟`
      : `${Math.ceil(absolute / 3_600_000)} 小时`;
  return future ? `${amount}后` : `${amount}前`;
}

function showToast(message) {
  text(elements.toast, message);
  elements.toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 3200);
}

function setAuthenticated(authenticated) {
  elements.authScreen.classList.toggle("is-hidden", authenticated);
  if (!authenticated) {
    elements.tokenInput.value = "";
    setTimeout(() => elements.tokenInput.focus(), 50);
  }
}

function lockDashboard() {
  state.token = "";
  state.overview = null;
  state.products = null;
  sessionStorage.removeItem(TOKEN_KEY);
  state.controller?.abort();
  clearTimeout(state.refreshTimer);
  setAuthenticated(false);
  text(elements.authError, "");
}

async function apiFetch(path, signal) {
  const response = await fetch(path, {
    headers: { authorization: `Bearer ${state.token}` },
    cache: "no-store",
    signal,
  });
  if (response.status === 401) {
    const error = new Error("unauthorized");
    error.code = "UNAUTHORIZED";
    throw error;
  }
  if (!response.ok) throw new Error(`status_${response.status}`);
  return response.json();
}

function productQueryString() {
  const params = new URLSearchParams({
    status: elements.productStatus.value,
    category: elements.productCategory.value,
    sort: elements.productSort.value,
    q: elements.productQuery.value.trim(),
    limit: String(PAGE_SIZE),
    offset: String(state.offset),
  });
  return params.toString();
}

async function refreshDashboard({ silent = false, productsOnly = false } = {}) {
  if (!state.token) return;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  elements.refreshButton.classList.add("is-loading");
  elements.dashboard.setAttribute("aria-busy", "true");

  try {
    if (productsOnly) {
      state.products = await apiFetch(`/api/v1/dashboard/products?${productQueryString()}`, controller.signal);
      renderProducts();
    } else {
      const [overview, products] = await Promise.all([
        apiFetch("/api/v1/dashboard/overview", controller.signal),
        apiFetch(`/api/v1/dashboard/products?${productQueryString()}`, controller.signal),
      ]);
      state.overview = overview;
      state.products = products;
      renderOverview();
      renderProducts();
      setAuthenticated(true);
      text(elements.pageRefreshedAt, formatClock(overview.generatedAt));
    }
    text(elements.authError, "");
  } catch (error) {
    if (error.name === "AbortError") return;
    if (error.code === "UNAUTHORIZED") {
      sessionStorage.removeItem(TOKEN_KEY);
      state.token = "";
      setAuthenticated(false);
      text(elements.authError, "访问令牌无效，请重新输入。");
      return;
    }
    elements.liveIndicator.dataset.status = "degraded";
    text(elements.liveLabel, "快照连接异常");
    if (!silent) showToast("暂时无法读取服务器快照，页面保留上次数据。 ");
  } finally {
    if (state.controller === controller) state.controller = null;
    elements.refreshButton.classList.remove("is-loading");
    elements.dashboard.setAttribute("aria-busy", "false");
    scheduleRefresh();
  }
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (!state.token || document.hidden) return;
  const delay = state.overview?.refreshAfterMs || 15_000;
  state.refreshTimer = setTimeout(() => refreshDashboard({ silent: true }), delay);
}

function renderOverview() {
  const overview = state.overview;
  if (!overview) return;
  const monitor = overview.monitor;
  const inventory = overview.inventory;
  const status = statusCopy[monitor.status] || statusCopy.starting;
  const lastPoll = monitor.lastPoll;

  elements.liveIndicator.dataset.status = monitor.status;
  text(elements.liveLabel, status.label);
  elements.serviceChip.dataset.status = monitor.status;
  text(elements.serviceChip, status.chip);
  text(elements.serviceStatus, status.label);
  text(
    elements.serviceDetail,
    `已运行 ${formatUptime(monitor.service.uptimeSeconds)} · 进程启动 ${monitor.service.processStarts} 次`,
  );

  text(elements.pollDuration, lastPoll ? formatDuration(lastPoll.durationMs) : "暂无耗时");
  text(elements.lastPoll, monitor.lastSuccessAt ? formatRelative(monitor.lastSuccessAt) : "等待首轮");
  updateCountdown();

  text(elements.activeProducts, formatNumber(inventory.activeTotal));
  text(elements.inStockCount, formatNumber(inventory.inStockTotal));
  text(elements.outStockCount, formatNumber(inventory.outOfStockTotal));
  text(elements.missingCount, `${formatNumber(inventory.missingTotal)} 条历史下架`);
  const total = Math.max(1, inventory.activeTotal);
  elements.stockBarIn.style.width = `${(inventory.inStockTotal / total) * 100}%`;
  elements.stockBarOut.style.width = `${(inventory.outOfStockTotal / total) * 100}%`;

  text(elements.transportLabel, monitor.transport === "browser" ? "浏览器代理" : monitor.transport);
  text(elements.failureCount, formatNumber(monitor.consecutiveFailures));
  text(
    elements.failureDetail,
    monitor.lastError
      ? `${monitor.lastError.code} · ${formatRelative(monitor.lastError.at)}`
      : "当前没有轮询错误",
  );

  renderPolls(overview.recentPolls || []);
  renderRestocks(overview.recentRestocks || []);
  text(elements.memoryUsage, `${overview.system.memory.usedPercent}%`);
  text(elements.serviceUptime, formatUptime(monitor.service.uptimeSeconds));
  populateCategories(inventory.categories || []);
}

function renderPolls(polls) {
  elements.pollStrip.replaceChildren();
  const recent = polls.slice(-24);
  const padded = [
    ...Array.from({ length: Math.max(0, 24 - recent.length) }, () => ({ status: "missing" })),
    ...recent,
  ];
  const completed = recent.filter((poll) => ["success", "failure"].includes(poll.status));
  const successes = completed.filter((poll) => poll.status === "success");
  const durations = successes.map((poll) => Number(poll.durationMs)).filter(Number.isFinite);

  for (const poll of padded) {
    const block = document.createElement("span");
    block.className = "poll-block";
    block.dataset.status = poll.status || "missing";
    block.tabIndex = 0;
    const duration = Number(poll.durationMs || 0);
    block.style.minHeight = `${Math.min(90, Math.max(38, 46 + Math.log10(duration + 1) * 9))}px`;
    block.dataset.tooltip = poll.startedAt
      ? `${formatDateTime(poll.startedAt, true)} · ${poll.status === "success" ? "成功" : poll.status === "failure" ? `失败 ${poll.errorCode || ""}` : "进行中"} · ${formatDuration(poll.durationMs)}`
      : "暂无记录";
    block.setAttribute("role", "listitem");
    block.setAttribute("aria-label", block.dataset.tooltip);
    elements.pollStrip.append(block);
  }

  text(elements.successRate, completed.length ? `${Math.round((successes.length / completed.length) * 100)}%` : "—");
  text(
    elements.averageDuration,
    durations.length ? formatDuration(durations.reduce((sum, value) => sum + value, 0) / durations.length) : "—",
  );
}

function renderRestocks(restocks) {
  elements.restockList.replaceChildren();
  text(elements.restockCount, `${restocks.length} 条`);
  if (restocks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-mini";
    const wrapper = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "暂无补货记录";
    const copy = document.createElement("span");
    copy.textContent = "发现补货后会显示在这里。";
    wrapper.append(title, copy);
    empty.append(wrapper);
    elements.restockList.append(empty);
    return;
  }

  for (const restock of restocks) {
    const item = document.createElement(restock.link ? "a" : "div");
    item.className = "restock-item";
    if (restock.link) {
      item.href = restock.link;
      item.target = "_blank";
      item.rel = "noopener noreferrer";
    }
    const dot = document.createElement("span");
    dot.className = "restock-item__dot";
    dot.setAttribute("aria-hidden", "true");
    const content = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = restock.name;
    const meta = document.createElement("small");
    meta.textContent = `${formatDateTime(restock.checkedAt)} · ${restock.categoryName || "未分类"}`;
    content.append(name, meta);
    const stock = document.createElement("span");
    stock.className = "restock-stock";
    stock.textContent = `${restock.previousStock ?? 0} → ${restock.stock}`;
    item.append(dot, content, stock);
    elements.restockList.append(item);
  }
}

function populateCategories(categories) {
  const selected = elements.productCategory.value;
  const existing = new Set([...elements.productCategory.options].slice(1).map((option) => option.value));
  if (categories.length === existing.size && categories.every((category) => existing.has(category))) return;
  elements.productCategory.replaceChildren(new Option("全部分类", ""));
  for (const category of categories) elements.productCategory.add(new Option(category, category));
  elements.productCategory.value = categories.includes(selected) ? selected : "";
}

function createCell(label, content, className = "") {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  if (className) cell.className = className;
  if (content instanceof Node) cell.append(content);
  else cell.textContent = content;
  return cell;
}

function renderProducts() {
  const payload = state.products;
  if (!payload) return;
  elements.productsBody.replaceChildren();
  const products = payload.data || [];
  elements.productsEmpty.hidden = products.length > 0;
  text(elements.productResultCount, `${formatNumber(payload.page.total)} 条结果`);

  for (const product of products) {
    const row = document.createElement("tr");
    const link = document.createElement(product.link ? "a" : "span");
    link.className = "product-link";
    link.textContent = product.name;
    if (product.link) {
      link.href = product.link;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    const category = document.createElement("span");
    category.className = "category-label";
    category.textContent = product.category?.name || "未分类";
    const status = document.createElement("span");
    status.className = `product-status product-status--${product.status}`;
    status.textContent = productStatusCopy[product.status] || product.status;
    row.append(
      createCell("商品", link),
      createCell("分类", category),
      createCell("售价", formatMoney(product.price), "numeric-cell"),
      createCell("库存", formatNumber(product.stock), "numeric-cell"),
      createCell("状态", status),
      createCell("最后变化", formatDateTime(product.lastChangedAt), "date-cell"),
    );
    elements.productsBody.append(row);
  }

  const pageNumber = Math.floor(payload.page.offset / payload.page.limit) + 1;
  const pageTotal = Math.max(1, Math.ceil(payload.page.total / payload.page.limit));
  text(elements.pageLabel, `第 ${pageNumber} / ${pageTotal} 页`);
  elements.previousPage.disabled = payload.page.offset <= 0;
  elements.nextPage.disabled = payload.page.nextOffset === null;
}

function updateCountdown() {
  const overview = state.overview;
  if (!overview) return;
  const next = overview.monitor.schedule.nextExpectedPollAt;
  const timestamp = new Date(next || "").getTime();
  const activity = overview.monitor.activity;
  if (activity === "checking") {
    text(elements.nextPoll, "正在执行新一轮检查");
  } else if (Number.isFinite(timestamp)) {
    text(elements.nextPoll, `下次检查 ${formatRelative(next)} · ${formatClock(next)}`);
  } else {
    text(elements.nextPoll, "等待下一轮检查");
  }
  text(elements.refreshCountdown, `监控最后成功 ${formatRelative(overview.monitor.lastSuccessAt)}`);
}

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = elements.tokenInput.value.trim();
  if (token.length < 24) {
    text(elements.authError, "访问令牌长度不正确。");
    return;
  }
  state.token = token;
  sessionStorage.setItem(TOKEN_KEY, token);
  await refreshDashboard();
});

elements.refreshButton.addEventListener("click", () => refreshDashboard());
elements.lockButton.addEventListener("click", lockDashboard);

let filterTimer;
elements.productFilters.addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    state.offset = 0;
    refreshDashboard({ productsOnly: true });
  }, 300);
});
elements.productFilters.addEventListener("change", () => {
  clearTimeout(filterTimer);
  state.offset = 0;
  refreshDashboard({ productsOnly: true });
});

elements.previousPage.addEventListener("click", () => {
  state.offset = Math.max(0, state.offset - PAGE_SIZE);
  refreshDashboard({ productsOnly: true });
});
elements.nextPage.addEventListener("click", () => {
  if (state.products?.page?.nextOffset === null) return;
  state.offset = state.products.page.nextOffset;
  refreshDashboard({ productsOnly: true });
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(state.refreshTimer);
    state.controller?.abort();
  } else if (state.token) {
    refreshDashboard({ silent: true });
  }
});

state.countdownTimer = setInterval(updateCountdown, 1000);

if (location.hash.startsWith("#token=")) {
  const hashToken = decodeURIComponent(location.hash.slice(7));
  if (hashToken.length >= 24) {
    state.token = hashToken;
    sessionStorage.setItem(TOKEN_KEY, hashToken);
  }
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

if (state.token) refreshDashboard();
else setAuthenticated(false);
