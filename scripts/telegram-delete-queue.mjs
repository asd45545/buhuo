#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const defaultQueueFile = path.join(rootDir, "data", "telegram-delete-queue.json");
const defaultDeleteAfterSeconds = 5 * 60 * 60;

async function loadQueue(file = defaultQueueFile) {
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw || "[]");
  return Array.isArray(parsed) ? parsed : [];
}

async function saveQueue(file = defaultQueueFile, queue) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(sortQueue(queue), null, 2)}\n`, "utf8");
}

function enqueueDeletion(queue, entry, now = new Date()) {
  const deleteAfterSeconds = Number(entry.deleteAfterSeconds ?? defaultDeleteAfterSeconds);
  const deleteAt = new Date(now.getTime() + deleteAfterSeconds * 1000).toISOString();
  return sortQueue([
    ...queue,
    {
      chatId: String(entry.chatId),
      messageId: Number(entry.messageId),
      deleteAt,
      createdAt: now.toISOString(),
      attempts: 0,
    },
  ]);
}

async function processDeletionQueue(queue, options = {}) {
  const now = options.now || new Date();
  const deleteMessage = options.deleteMessage;
  if (typeof deleteMessage !== "function") {
    throw new Error("deleteMessage function is required");
  }

  const remaining = [];
  const deleted = [];
  const failed = [];

  for (const entry of queue) {
    if (!isDue(entry, now)) {
      remaining.push(entry);
      continue;
    }

    try {
      await deleteMessage(entry);
      deleted.push(entry);
    } catch (error) {
      const failedEntry = {
        ...entry,
        attempts: Number(entry.attempts || 0) + 1,
        lastError: error.message,
        lastTriedAt: now.toISOString(),
      };
      failed.push(failedEntry);
      if (!error.permanent) {
        remaining.push(failedEntry);
      }
    }
  }

  return {
    remaining: sortQueue(remaining),
    deleted,
    failed,
  };
}

async function deleteTelegramMessage(botToken, entry) {
  if (!botToken) {
    throw new Error("missing Telegram bot token");
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: entry.chatId,
      message_id: Number(entry.messageId),
    }),
  });

  const result = await response.json().catch(() => ({}));
  if (response.ok && result.ok === true) return result;

  const description = result.description || `HTTP ${response.status}`;
  const error = new Error(`Telegram deleteMessage failed for ${entry.messageId}: ${description}`);
  error.permanent =
    response.status === 400 ||
    /message to delete not found|message can't be deleted|message identifier is not specified/i.test(description);
  throw error;
}

function isDue(entry, now) {
  const dueAt = new Date(entry.deleteAt);
  if (Number.isNaN(dueAt.getTime())) return false;
  return dueAt <= now;
}

function sortQueue(queue) {
  return [...queue].sort((a, b) => String(a.deleteAt || "").localeCompare(String(b.deleteAt || "")));
}

function parseArgs(argv) {
  const args = {
    queueFile: defaultQueueFile,
    enqueue: false,
    chatId: "",
    messageId: "",
    deleteAfterSeconds: defaultDeleteAfterSeconds,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--queue" && next) {
      args.queueFile = path.resolve(next);
      i += 1;
    } else if (arg === "--enqueue") {
      args.enqueue = true;
    } else if (arg === "--chat-id" && next) {
      args.chatId = next;
      i += 1;
    } else if (arg === "--message-id" && next) {
      args.messageId = next;
      i += 1;
    } else if (arg === "--delete-after-seconds" && next) {
      args.deleteAfterSeconds = Number(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/telegram-delete-queue.mjs
  node scripts/telegram-delete-queue.mjs --enqueue --chat-id CHAT --message-id ID

Options:
  --queue PATH                    Queue file path.
  --enqueue                       Add one Telegram message to the delete queue.
  --chat-id CHAT                  Telegram chat id for enqueue.
  --message-id ID                 Telegram message id for enqueue.
  --delete-after-seconds SECONDS  Default: 18000.

Environment:
  LDXP_TELEGRAM_BOT_TOKEN         Telegram bot token for deleting due messages.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const queue = await loadQueue(args.queueFile);

  if (args.enqueue) {
    if (!args.chatId || !args.messageId) {
      throw new Error("--chat-id and --message-id are required with --enqueue");
    }
    const nextQueue = enqueueDeletion(queue, {
      chatId: args.chatId,
      messageId: args.messageId,
      deleteAfterSeconds: args.deleteAfterSeconds,
    });
    await saveQueue(args.queueFile, nextQueue);
    console.log(`Queued Telegram message ${args.messageId} for deletion in ${args.deleteAfterSeconds} seconds.`);
    return;
  }

  const dueCount = queue.filter((entry) => isDue(entry, new Date())).length;
  if (dueCount === 0) {
    console.log(`No Telegram messages due for deletion. Queue size: ${queue.length}.`);
    return;
  }

  const botToken = process.env.LDXP_TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || "";
  const result = await processDeletionQueue(queue, {
    deleteMessage: (entry) => deleteTelegramMessage(botToken, entry),
  });
  await saveQueue(args.queueFile, result.remaining);

  for (const entry of result.failed) {
    console.error(`WARN ${entry.messageId}: ${entry.lastError}`);
  }
  console.log(`Deleted ${result.deleted.length} Telegram message(s). Remaining queue size: ${result.remaining.length}.`);
}

export {
  deleteTelegramMessage,
  enqueueDeletion,
  loadQueue,
  processDeletionQueue,
  saveQueue,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ERROR ${error.message}`);
    process.exitCode = 1;
  });
}
