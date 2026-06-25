# Vercel-Triggered Telegram Cleanup Design

## Goal

Delete Telegram restock notifications approximately five hours after they are
sent, without depending on GitHub scheduled workflow timing.

## Architecture

The Vercel monitor already receives an external request every five minutes. On
each request it reads `data/telegram-delete-queue.json` from GitHub and checks
whether any entry is due. If so, it dispatches a dedicated GitHub Actions
workflow. The workflow uses the existing Telegram bot secret, deletes all due
messages, updates the queue, and commits the result.

The existing scheduled monitor keeps its deletion step as a fallback. GitHub
Actions concurrency serializes queue writers so notification enqueue and delete
operations do not modify the queue simultaneously.

## Behavior

- No due entries: no cleanup workflow is dispatched.
- At least one due entry: dispatch one cleanup workflow.
- The monitor response reports whether cleanup was requested.
- Telegram API failures remain in the queue unless they are permanent.
- No new Vercel environment variable or GitHub secret is required.

## Verification

- API tests cover due and not-due queue entries.
- Existing stock monitoring and Telegram queue tests continue to pass.
- Workflow YAML is inspected for the existing bot secret, queue processing, and
  queue commit steps.
