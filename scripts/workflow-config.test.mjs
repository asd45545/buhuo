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
