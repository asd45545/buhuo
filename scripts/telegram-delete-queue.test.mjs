import assert from "node:assert/strict";
import test from "node:test";

import { processDeletionQueue } from "./telegram-delete-queue.mjs";

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
