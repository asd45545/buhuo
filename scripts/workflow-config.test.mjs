import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPaths = [
  ".github/workflows/telegram-notify.yml",
  ".github/workflows/telegram-delete.yml",
  ".github/workflows/ldxp-stock-monitor.yml",
];

test("queue workflows sync latest main before touching the delete queue", async () => {
  for (const workflowPath of workflowPaths) {
    const workflow = await readFile(workflowPath, "utf8");
    const syncIndex = workflow.indexOf("git pull --rebase origin main");
    const queueIndex = workflow.indexOf("telegram-delete-queue.mjs");

    assert.notEqual(syncIndex, -1, `${workflowPath} must sync latest main first`);
    assert.notEqual(queueIndex, -1, `${workflowPath} must touch the delete queue`);
    assert.ok(syncIndex < queueIndex, `${workflowPath} sync must happen before queue processing`);
  }
});

test("queue workflows retry push after rebasing remote changes", async () => {
  for (const workflowPath of workflowPaths) {
    const workflow = await readFile(workflowPath, "utf8");
    assert.match(workflow, /for attempt in 1 2 3 4 5/, `${workflowPath} must retry queue pushes`);
    assert.match(workflow, /git pull --rebase origin main/, `${workflowPath} must rebase before retry push`);
    assert.match(workflow, /git push && break/, `${workflowPath} must stop retrying after a successful push`);
  }
});

test("telegram delete workflow runs on a 5 minute schedule", async () => {
  const workflow = await readFile(".github/workflows/telegram-delete.yml", "utf8");

  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:\s*"\*\/5 \* \* \* \*"/);
});

test("systemd monitor service gets API transport from its environment file", async () => {
  const service = await readFile("deploy/ldxp-monitor.service", "utf8");
  const environment = await readFile("deploy/ldxp-monitor.env.example", "utf8");
  const monitor = await readFile("scripts/monitor-ldxp-stock.mjs", "utf8");

  assert.match(service, /^EnvironmentFile=\/etc\/ldxp-monitor\.env$/m);
  assert.doesNotMatch(service, /--api-transport/);
  assert.match(service, /--status \/var\/lib\/ldxp-monitor\/ldxp-monitor-status\.json/);
  assert.match(
    environment,
    /^LDXP_TELEGRAM_DELETE_QUEUE_FILE=\/var\/lib\/ldxp-monitor\/telegram-delete-queue\.json$/m,
  );
  assert.match(environment, /^LDXP_TELEGRAM_DELETE_AFTER_SECONDS=18000$/m);
  assert.match(monitor, /await cleanupTelegramDeletionQueueSafely\(cfg\)/);
});

test("dashboard service is isolated and listens on loopback by default", async () => {
  const service = await readFile("deploy/ldxp-dashboard.service", "utf8");
  const environment = await readFile("deploy/ldxp-dashboard.env.example", "utf8");
  const server = await readFile("dashboard/server.mjs", "utf8");

  assert.match(service, /^User=ldxp-dashboard$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^CapabilityBoundingSet=$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/ldxp-dashboard\.env$/m);
  assert.match(service, /^StateDirectory=ldxp-dashboard$/m);
  assert.match(service, /^StateDirectoryMode=0700$/m);
  assert.doesNotMatch(service, /ldxp-monitor\.env/);
  assert.match(environment, /^LDXP_DASHBOARD_HOST=127\.0\.0\.1$/m);
  assert.match(
    server,
    /parseInteger\(process\.env\.LDXP_DASHBOARD_PORT, 8788, 1, 65_535\)/,
  );
  assert.doesNotMatch(environment, /LDXP_DASHBOARD_TOKEN/);
  assert.match(environment, /^LDXP_DASHBOARD_PASSWORD_HASH=$/m);
  assert.match(environment, /^LDXP_DASHBOARD_PORT=8788$/m);
  assert.doesNotMatch(environment, /LDXP_DASHBOARD_SESSION_SECRET/);
  assert.match(environment, /^LDXP_DASHBOARD_COOKIE_NAME=__Secure-ldxp_session$/m);
  assert.match(environment, /^LDXP_DASHBOARD_COOKIE_PATH=\/stock-monitor\/$/m);
  assert.match(environment, /^LDXP_DASHBOARD_MAX_FAILURES=3$/m);
  assert.match(environment, /^LDXP_DASHBOARD_BAN_MS=86400000$/m);
  assert.match(environment, /^LDXP_DASHBOARD_STATUS_FILE=\/var\/lib\/ldxp-monitor\/ldxp-monitor-status\.json$/m);
  assert.match(environment, /^LDXP_INVENTORY_API_KEY_HASH=$/m);
  assert.match(environment, /^LDXP_INVENTORY_API_ALLOWED_ORIGINS=$/m);
  assert.match(environment, /^LDXP_INVENTORY_API_RATE_LIMIT=120$/m);
});

test("nginx dashboard proxy overwrites client identity headers", async () => {
  const headers = await readFile("deploy/nginx-ldxp-dashboard-proxy-headers.conf", "utf8");
  const locations = await readFile("deploy/nginx-ldxp-dashboard-locations.conf", "utf8");
  const nginxFiles = [
    locations,
    headers,
    await readFile("deploy/nginx-ldxp-dashboard-rate.conf", "utf8"),
  ].join("\n");
  const upstreams = [...nginxFiles.matchAll(/proxy_pass\s+http:\/\/([^/;\s]+)/g)].map(
    (match) => match[1],
  );

  assert.match(headers, /proxy_set_header X-Real-IP \$remote_addr;/);
  assert.match(headers, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(headers, /proxy_set_header Forwarded "";/);
  assert.doesNotMatch(headers, /proxy_add_x_forwarded_for/);
  assert.match(locations, /location = \/stock-monitor\/api\/v1\/auth\/login/);
  assert.match(locations, /limit_req zone=ldxp_dashboard_login/);
  assert.match(locations, /location = \/stock-monitor\/api\/v1\/inventory/);
  assert.match(locations, /limit_req zone=ldxp_inventory_api/);
  assert.match(nginxFiles, /limit_req_zone \$binary_remote_addr zone=ldxp_inventory_api:10m rate=120r\/m;/);
  assert.match(locations, /location \^~ \/stock-monitor\/\s*\{/);
  assert.match(
    locations,
    /location = \/stock-monitor\/healthz\s*\{\s*return 404;\s*\}/,
  );
  assert.ok(upstreams.length > 0, "nginx dashboard config must define an upstream");
  assert.deepEqual(
    [...new Set(upstreams)],
    ["127.0.0.1:8788"],
    "every dashboard upstream must use the loopback listener on port 8788",
  );
});

test("dashboard deployment docs describe opaque persistent sessions without a signing secret", async () => {
  const docs = await readFile("docs/ldxp-dashboard.md", "utf8");

  assert.match(docs, /server-side\s+persistent opaque session/i);
  assert.match(docs, /__Secure-ldxp_session/);
  assert.match(docs, /Path=\/stock-monitor\//);
  assert.match(docs, /GET \/stock-monitor\/api\/v1\/inventory/);
  assert.match(docs, /Authorization: Bearer <inventory-api-key>/);
  assert.match(docs, /Do not embed it in browser JavaScript/);
  assert.doesNotMatch(docs, /signed, HttpOnly/i);
  assert.doesNotMatch(docs, /session signing secret/i);
});

test("dashboard links to protected inventory API documentation without embedding a key", async () => {
  const dashboard = await readFile("dashboard/public/index.html", "utf8");
  const apiDocs = await readFile("dashboard/public/api-docs.html", "utf8");
  const markdown = await readFile("docs/inventory-api.md", "utf8");

  assert.match(dashboard, /href="api-docs\.html"/);
  assert.match(dashboard, />API 文档</);
  assert.match(apiDocs, /库存明细 API 接口文档/);
  assert.match(apiDocs, /stock-monitor\/api\/v1\/inventory/);
  assert.match(markdown, /^# 库存明细 API 接口文档$/m);
  assert.doesNotMatch(apiDocs, /Authorization: Bearer [A-Za-z0-9_-]{43}/);
  assert.doesNotMatch(markdown, /Authorization: Bearer [A-Za-z0-9_-]{43}/);
});
