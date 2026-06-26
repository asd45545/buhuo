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
