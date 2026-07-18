import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  enqueueDeletion,
  loadQueue,
  processDeletionQueue,
  saveQueue,
} from "./telegram-delete-queue.mjs";

test("enqueueDeletion uses a five-hour default and replaces duplicate message IDs", () => {
  const first = enqueueDeletion(
    [],
    { chatId: "-1001", messageId: 10 },
    new Date("2026-01-01T00:00:00.000Z"),
  );
  const replaced = enqueueDeletion(
    first,
    { chatId: "-1001", messageId: 10 },
    new Date("2026-01-01T00:05:00.000Z"),
  );

  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].createdAt, "2026-01-01T00:05:00.000Z");
  assert.equal(replaced[0].deleteAt, "2026-01-01T05:05:00.000Z");
  assert.throws(
    () => enqueueDeletion([], { chatId: "-1001", messageId: "bad" }),
    /valid chatId and messageId/,
  );
});

test("saveQueue replaces an existing queue and keeps the file private", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-delete-queue-"));
  const queueFile = path.join(directory, "queue.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await saveQueue(queueFile, [{ chatId: "-1001", messageId: 1, deleteAt: "2026-01-01T01:00:00.000Z" }]);
  await saveQueue(queueFile, [{ chatId: "-1001", messageId: 2, deleteAt: "2026-01-01T02:00:00.000Z" }]);

  assert.deepEqual((await loadQueue(queueFile)).map((entry) => entry.messageId), [2]);
  if (process.platform !== "win32") {
    assert.equal((await stat(queueFile)).mode & 0o777, 0o600);
  }
});

test("processDeletionQueue deletes due messages and keeps future messages", async () => {
  const deleted = [];
  const queue = [
    {
      chatId: "-1001",
      messageId: 11,
      deleteAt: "2026-01-01T04:59:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      chatId: "-1001",
      messageId: 12,
      deleteAt: "2026-01-01T05:01:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  const result = await processDeletionQueue(queue, {
    now: new Date("2026-01-01T05:00:00.000Z"),
    deleteMessage: async (entry) => {
      deleted.push(entry.messageId);
    },
  });

  assert.deepEqual(deleted, [11]);
  assert.deepEqual(result.remaining.map((entry) => entry.messageId), [12]);
  assert.equal(result.deleted.length, 1);
  assert.equal(result.failed.length, 0);
});

test("processDeletionQueue keeps failed deletions for retry", async () => {
  const queue = [
    {
      chatId: "-1001",
      messageId: 21,
      deleteAt: "2026-01-01T05:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      attempts: 0,
    },
  ];

  const result = await processDeletionQueue(queue, {
    now: new Date("2026-01-01T05:01:00.000Z"),
    deleteMessage: async () => {
      throw new Error("Telegram deleteMessage failed for 21: Bad Request: not enough rights to delete message");
    },
  });

  assert.deepEqual(result.deleted, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].messageId, 21);
  assert.equal(result.remaining[0].attempts, 1);
  assert.match(result.remaining[0].lastError, /not enough rights/);
});

test("processDeletionQueue drops messages Telegram says are already gone", async () => {
  const queue = [
    {
      chatId: "-1001",
      messageId: 22,
      deleteAt: "2026-01-01T05:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      attempts: 0,
    },
  ];

  const result = await processDeletionQueue(queue, {
    now: new Date("2026-01-01T05:01:00.000Z"),
    deleteMessage: async () => {
      const error = new Error("Telegram deleteMessage failed for 22: Bad Request: message to delete not found");
      error.treatAsDeleted = true;
      throw error;
    },
  });

  assert.deepEqual(result.deleted, []);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(result.remaining, []);
});
