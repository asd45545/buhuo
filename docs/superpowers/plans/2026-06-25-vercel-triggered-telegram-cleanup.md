# Vercel-Triggered Telegram Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trigger Telegram message cleanup from each Vercel monitor check only when the persisted queue contains an expired entry.

**Architecture:** Extend the GitHub-backed store in `api/monitor.mjs` to read the deletion queue and dispatch a dedicated cleanup workflow. Add a small workflow that runs the existing queue processor and commits the pruned queue while sharing the existing queue concurrency group.

**Tech Stack:** Node.js ES modules, Node test runner, Vercel Functions, GitHub Actions, Telegram Bot API

---

### Task 1: Add API regression coverage

**Files:**
- Modify: `api/monitor.test.mjs`

- [ ] **Step 1: Write a test where the queue contains an expired entry**

Mock the GitHub contents response for `data/telegram-delete-queue.json`, invoke
the monitor, and assert that `telegram-delete.yml` receives one workflow
dispatch.

- [ ] **Step 2: Run the API test and verify it fails**

Run: `node --test api/monitor.test.mjs`

Expected: FAIL because the monitor does not read the queue or dispatch the
cleanup workflow.

- [ ] **Step 3: Add a not-due assertion**

Return a future `deleteAt` value in an existing no-restock case and assert that
no cleanup workflow dispatch occurs.

### Task 2: Implement conditional cleanup dispatch

**Files:**
- Modify: `api/monitor.mjs`

- [ ] **Step 1: Add queue and workflow paths to the GitHub store**

Use `data/telegram-delete-queue.json` and `telegram-delete.yml` as defaults,
while allowing environment-variable overrides consistent with the existing
store configuration.

- [ ] **Step 2: Add due-entry detection**

Treat an entry as due only when `deleteAt` parses as a valid date less than or
equal to the current monitor timestamp.

- [ ] **Step 3: Dispatch cleanup only when needed**

Read the queue once per monitor request, dispatch `telegram-delete.yml` with no
inputs when at least one item is due, and expose `telegramCleanupRequested` in
the JSON response.

- [ ] **Step 4: Run the API tests**

Run: `node --test api/monitor.test.mjs`

Expected: PASS.

### Task 3: Add the dedicated cleanup workflow

**Files:**
- Create: `.github/workflows/telegram-delete.yml`

- [ ] **Step 1: Create a manual workflow**

Configure `workflow_dispatch`, `contents: write`, and the
`telegram-delete-queue` concurrency group.

- [ ] **Step 2: Process and persist the queue**

Checkout the latest `main`, run `scripts/telegram-delete-queue.mjs` with
`LDXP_TELEGRAM_BOT_TOKEN`, then commit and push queue changes only when the file
changed.

### Task 4: Verify and publish

**Files:**
- Test: `api/monitor.test.mjs`
- Test: `scripts/monitor-ldxp-stock.test.mjs`
- Test: `scripts/telegram-delete-queue.test.mjs`

- [ ] **Step 1: Run the full suite**

Run: `npm.cmd test`

Expected: all tests pass.

- [ ] **Step 2: Review the diff and workflow syntax**

Run: `git diff --check` and inspect the new workflow.

- [ ] **Step 3: Commit and push**

Commit the focused changes and push the current branch to `origin/main`.
