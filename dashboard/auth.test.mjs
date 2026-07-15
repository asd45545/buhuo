import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  LoginSecurityStore,
  hashDashboardPassword,
  passwordHashVersion,
  parseCookies,
  parsePasswordHash,
  requestClientIp,
  sessionCookie,
  verifyDashboardPassword,
} from "./auth.mjs";

const PASSWORD = "dashboard-password-安全-123";
const execFileAsync = promisify(execFile);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("password hashing uses a strong parameterized scrypt digest", async () => {
  const encoded = await hashDashboardPassword(PASSWORD, { salt: Buffer.alloc(16, 7) });

  assert.match(encoded, /^scrypt\$v1\$32768\$8\$1\$/);
  assert.doesNotMatch(encoded, /dashboard-password|安全/);
  assert.equal((await verifyDashboardPassword(PASSWORD, encoded)), true);
  assert.equal((await verifyDashboardPassword(` ${PASSWORD}`, encoded)), false);
  assert.equal((await verifyDashboardPassword(`${PASSWORD} `, encoded)), false);
  assert.equal((await verifyDashboardPassword("wrong-password-value", encoded)), false);
  assert.throws(() => parsePasswordHash(encoded.replace("$32768$", "$16384$")), /invalid/);
});

test("opaque sessions persist only a SHA-256 digest and can be revoked", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "auth-state.json");
  let now = Date.parse("2026-07-16T00:00:00.000Z");
  const passwordHash = await hashDashboardPassword(PASSWORD, { salt: Buffer.alloc(16, 8) });
  const version = passwordHashVersion(passwordHash);
  const store = new LoginSecurityStore(file, { now: () => now });
  const session = await store.createSession(60_000, version);

  assert.match(session.value, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(session.value, "base64url").length, 32);
  const serialized = await readFile(file, "utf8");
  const digest = createHash("sha256").update(session.value, "utf8").digest("hex");
  assert.equal(serialized.includes(session.value), false);
  assert.equal(JSON.parse(serialized).sessions[digest].version, version);

  const restarted = new LoginSecurityStore(file, { now: () => now });
  assert.deepEqual(await restarted.sessionStatus(session.value, version), {
    valid: true,
    expiresAt: session.expiresAt,
  });
  assert.equal(await restarted.deleteSession(session.value), true);
  assert.equal((await store.sessionStatus(session.value, version)).valid, false);
  assert.equal(await restarted.deleteSession(session.value), false);

  assert.equal(parseCookies(`a=1; session=first; session=second`).get("session"), null);
  assert.match(
    sessionCookie("__Host-ldxp_session", session.value, {
      maxAgeMs: 60_000,
      path: "/",
      secure: true,
    }),
    /Path=\/; HttpOnly; SameSite=Strict; Max-Age=60; Secure/,
  );

  const replacement = await store.createSession(60_000, version);
  now += 60_000;
  assert.equal((await restarted.sessionStatus(replacement.value, version)).valid, false);
});

test("changing the password hash invalidates and removes old sessions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-session-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "auth-state.json");
  const firstHash = await hashDashboardPassword(PASSWORD, { salt: Buffer.alloc(16, 1) });
  const secondHash = await hashDashboardPassword(PASSWORD, { salt: Buffer.alloc(16, 2) });
  const firstVersion = passwordHashVersion(firstHash);
  const secondVersion = passwordHashVersion(secondHash);
  const store = new LoginSecurityStore(file);
  const session = await store.createSession(60_000, firstVersion);

  assert.notEqual(firstVersion, secondVersion);
  assert.equal((await store.sessionStatus(session.value, secondVersion)).valid, false);
  assert.equal(Object.keys(JSON.parse(await readFile(file, "utf8")).sessions).length, 0);
});

test("trusted proxy IP handling accepts only a single loopback-supplied X-Real-IP", () => {
  const proxied = {
    socket: { remoteAddress: "::ffff:127.0.0.1" },
    headers: { "x-real-ip": "203.0.113.42", "x-forwarded-for": "198.51.100.8" },
  };
  const spoofedDirect = {
    socket: { remoteAddress: "198.51.100.9" },
    headers: { "x-real-ip": "203.0.113.99" },
  };

  assert.equal(requestClientIp(proxied, true), "203.0.113.42");
  assert.equal(
    requestClientIp({ ...proxied, headers: { "x-real-ip": "203.0.113.42, 198.51.100.8" } }, true),
    "127.0.0.1",
  );
  assert.equal(requestClientIp(spoofedDirect, true), "198.51.100.9");
  assert.equal(requestClientIp(proxied, false), "127.0.0.1");
});

test("three concurrent failures ban one IP and persist across restarts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "auth-state.json");
  let now = Date.parse("2026-07-16T00:00:00.000Z");
  const store = new LoginSecurityStore(file, { now: () => now, banMs: 60_000 });

  const attempts = await Promise.all(
    Array.from({ length: 3 }, () => store.authenticate("203.0.113.10", async () => false)),
  );
  assert.deepEqual(attempts.map((attempt) => attempt.remainingAttempts), [2, 1, 0]);
  assert.equal(attempts[2].banned, true);

  let verifierCalls = 0;
  const restarted = new LoginSecurityStore(file, { now: () => now, banMs: 60_000 });
  const blocked = await restarted.authenticate("203.0.113.10", async () => {
    verifierCalls += 1;
    return true;
  });
  assert.equal(blocked.banned, true);
  assert.equal(verifierCalls, 0);

  now += 60_001;
  const recovered = await restarted.authenticate("203.0.113.10", async () => true);
  assert.equal(recovered.ok, true);
});

test("password verification is serialized per IP", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-auth-ip-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "auth-state.json");
  const stores = [new LoginSecurityStore(file), new LoginSecurityStore(file)];
  let active = 0;
  let maxActive = 0;
  const verify = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return false;
  };

  const attempts = await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      stores[index % stores.length].authenticate("203.0.113.11", verify),
    ),
  );

  assert.equal(maxActive, 1);
  assert.deepEqual(attempts.map((attempt) => attempt.remainingAttempts), [2, 1, 0]);
});

test("password verification admits two global KDF jobs and rejects a full queue", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-auth-kdf-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "auth-state.json");
  const stores = [0, 1].map(() => new LoginSecurityStore(file, {
    maxKdfConcurrency: 2,
    maxKdfQueue: 1,
  }));
  const release = deferred();
  let active = 0;
  let maxActive = 0;
  let verifierCalls = 0;
  const verify = async () => {
    verifierCalls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await release.promise;
    active -= 1;
    return false;
  };

  const attempts = [40, 41, 42, 43].map((suffix) =>
    stores[suffix % stores.length].authenticate(`203.0.113.${suffix}`, verify),
  );
  await waitFor(() => verifierCalls === 2);
  const rejected = await attempts[3];

  assert.equal(rejected.busy, true);
  assert.equal(rejected.remainingAttempts, null);
  assert.equal(maxActive, 2);
  release.resolve();
  const accepted = await Promise.all(attempts.slice(0, 3));
  assert.equal(accepted.every((attempt) => attempt.busy === false), true);
  assert.equal(verifierCalls, 3);
  assert.equal(maxActive, 2);
});

test("a correct password clears earlier failures without affecting another IP", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-auth-reset-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "auth-state.json");
  const store = new LoginSecurityStore(file);

  await store.authenticate("203.0.113.20", async () => false);
  await store.authenticate("203.0.113.20", async () => false);
  await store.authenticate("203.0.113.21", async () => false);
  assert.equal((await store.authenticate("203.0.113.20", async () => true)).ok, true);
  assert.equal(
    (await store.authenticate("203.0.113.20", async () => false)).remainingAttempts,
    2,
  );
  assert.equal(
    (await store.authenticate("203.0.113.21", async () => false)).remainingAttempts,
    1,
  );
});

test("the failure window expires before a later bad password", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-auth-window-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse("2026-07-16T00:00:00.000Z");
  const store = new LoginSecurityStore(path.join(directory, "auth-state.json"), {
    now: () => now,
    failureWindowMs: 60_000,
  });

  assert.equal(
    (await store.authenticate("203.0.113.22", async () => false)).remainingAttempts,
    2,
  );
  now += 60_001;
  assert.equal(
    (await store.authenticate("203.0.113.22", async () => false)).remainingAttempts,
    2,
  );
});

test("a corrupted security state fails closed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-auth-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "auth-state.json");
  await writeFile(file, "not-json", "utf8");
  const store = new LoginSecurityStore(file);

  await assert.rejects(
    store.authenticate("203.0.113.30", async () => true),
    /Unexpected token|JSON/,
  );

  await writeFile(file, JSON.stringify({ version: 99, failures: {}, bans: {} }), "utf8");
  const wrongVersion = new LoginSecurityStore(file);
  await assert.rejects(
    wrongVersion.authenticate("203.0.113.30", async () => true),
    /invalid dashboard authentication state/,
  );

  await writeFile(
    file,
    JSON.stringify({ version: 2, failures: [], bans: {}, sessions: {} }),
    "utf8",
  );
  await assert.rejects(
    new LoginSecurityStore(file).banStatus("203.0.113.30"),
    /invalid dashboard authentication state/,
  );

  await writeFile(
    file,
    JSON.stringify({
      version: 2,
      failures: {},
      bans: {},
      sessions: { plaintext_session_token: { createdAt: 1, expiresAt: 2, version: "x" } },
    }),
    "utf8",
  );
  await assert.rejects(
    new LoginSecurityStore(file).banStatus("203.0.113.30"),
    /invalid dashboard authentication state/,
  );
});

test("an external unban is visible to a running store and is not resurrected", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-auth-unban-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "auth-state.json");
  const running = new LoginSecurityStore(file, { banMs: 60_000 });
  const ip = "203.0.113.70";

  await running.authenticate(ip, async () => false);
  await running.authenticate(ip, async () => false);
  await running.authenticate(ip, async () => false);
  assert.equal((await running.banStatus(ip)).banned, true);

  const cli = await execFileAsync(
    process.execPath,
    [path.join(import.meta.dirname, "security-cli.mjs"), "unban", ip, "--file", file],
  );
  assert.match(cli.stdout, /UNBANNED/);
  assert.equal((await running.banStatus(ip)).banned, false);

  await running.authenticate("203.0.113.71", async () => false);
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(ip in persisted.bans, false);
});

test("independent stores do not lose concurrent failure updates", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ldxp-auth-multi-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "auth-state.json");
  const first = new LoginSecurityStore(file);
  const second = new LoginSecurityStore(file);

  await Promise.all([
    first.authenticate("203.0.113.80", async () => false),
    second.authenticate("203.0.113.81", async () => false),
  ]);
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(state.failures["203.0.113.80"].count, 1);
  assert.equal(state.failures["203.0.113.81"].count, 1);
});
