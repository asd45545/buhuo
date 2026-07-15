import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PASSWORD_ALGORITHM = "scrypt";
const DEFAULT_SCRYPT = Object.freeze({ N: 32_768, r: 8, p: 1, keyLength: 64 });
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_BAN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FAILURE_WINDOW_MS = 30 * 60 * 1000;
const MAX_SECURITY_ENTRIES = 10_000;
const MAX_SESSIONS = 1_000;
const DEFAULT_MAX_KDF_CONCURRENCY = 2;
const DEFAULT_MAX_KDF_QUEUE = 64;
const DEFAULT_MAX_IP_QUEUE = 8;
const stateQueues = new Map();
const ipQueueMaps = new Map();
const kdfGates = new Map();

function positiveInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function passwordParameters(options = {}) {
  return {
    N: positiveInteger(options.N, DEFAULT_SCRYPT.N, 2 ** 15, 2 ** 18),
    r: positiveInteger(options.r, DEFAULT_SCRYPT.r, 1, 32),
    p: positiveInteger(options.p, DEFAULT_SCRYPT.p, 1, 16),
    keyLength: positiveInteger(options.keyLength, DEFAULT_SCRYPT.keyLength, 64, 64),
  };
}

function parsePasswordHash(encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 7 || parts[0] !== PASSWORD_ALGORITHM) {
    throw new Error("invalid dashboard password hash");
  }
  const [, version, nValue, rValue, pValue, saltValue, digestValue] = parts;
  if (version !== "v1" || !/^[A-Za-z0-9_-]+$/.test(saltValue) || !/^[A-Za-z0-9_-]+$/.test(digestValue)) {
    throw new Error("invalid dashboard password hash");
  }
  const options = passwordParameters({
    N: Number(nValue),
    r: Number(rValue),
    p: Number(pValue),
    keyLength: Buffer.from(digestValue, "base64url").length,
  });
  if (options.N !== Number(nValue) || options.r !== Number(rValue) || options.p !== Number(pValue)) {
    throw new Error("invalid dashboard password hash parameters");
  }
  if ((options.N & (options.N - 1)) !== 0) {
    throw new Error("invalid dashboard password hash work factor");
  }
  const salt = Buffer.from(saltValue, "base64url");
  const digest = Buffer.from(digestValue, "base64url");
  if (salt.length < 16 || salt.length > 64 || digest.length !== options.keyLength) {
    throw new Error("invalid dashboard password hash payload");
  }
  return { ...options, salt, digest };
}

async function hashDashboardPassword(password, options = {}) {
  const value = String(password || "");
  const passwordBytes = Buffer.byteLength(value, "utf8");
  if (passwordBytes < 16 || passwordBytes > 256) {
    throw new Error("dashboard password must contain 16 to 256 UTF-8 bytes");
  }
  const parameters = passwordParameters(options);
  const salt = options.salt ? Buffer.from(options.salt) : randomBytes(16);
  if (salt.length < 16 || salt.length > 64) throw new Error("invalid password salt");
  const digest = await scrypt(value, salt, parameters.keyLength, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: 128 * 1024 * 1024,
  });
  return [
    PASSWORD_ALGORITHM,
    "v1",
    parameters.N,
    parameters.r,
    parameters.p,
    salt.toString("base64url"),
    Buffer.from(digest).toString("base64url"),
  ].join("$");
}

async function verifyDashboardPassword(password, encoded) {
  const value = String(password || "");
  if (Buffer.byteLength(value, "utf8") > 256) return false;
  const parsed = parsePasswordHash(encoded);
  const actual = await scrypt(value, parsed.salt, parsed.keyLength, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: 128 * 1024 * 1024,
  });
  const candidate = Buffer.from(actual);
  return candidate.length === parsed.digest.length && timingSafeEqual(candidate, parsed.digest);
}

function passwordHashVersion(encoded) {
  parsePasswordHash(encoded);
  return createHash("sha256").update(String(encoded), "utf8").digest("hex");
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    if (cookies.has(name)) cookies.set(name, null);
    else cookies.set(name, value);
  }
  return cookies;
}

function sessionCookie(name, value, options = {}) {
  const maxAgeSeconds = Math.max(0, Math.floor(Number(options.maxAgeMs || 0) / 1000));
  const cookiePath = String(options.path || "/");
  if (!cookiePath.startsWith("/") || /[;\r\n]/.test(cookiePath)) {
    throw new Error("invalid dashboard cookie path");
  }
  const parts = [
    `${name}=${value}`,
    `Path=${cookiePath}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (options.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

function normalizeIp(value) {
  const raw = String(value || "").trim();
  const normalized = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  return isIP(normalized) ? normalized.toLowerCase() : "";
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1";
}

function requestClientIp(req, trustProxy = false) {
  const remote = normalizeIp(req.socket?.remoteAddress) || "unknown";
  if (!trustProxy || !isLoopback(remote)) return remote;
  const header = req.headers?.["x-real-ip"];
  if (Array.isArray(header) || String(header || "").includes(",")) return remote;
  return normalizeIp(header) || remote;
}

function emptySecurityState() {
  return { version: 2, failures: {}, bans: {}, sessions: {} };
}

function plainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!plainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => key === actual[index]);
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validStateIp(value) {
  return value === "unknown" || normalizeIp(value) === value;
}

function normalizeSecurityState(value) {
  if (!exactKeys(value, ["bans", "failures", "sessions", "version"]) || value.version !== 2) {
    throw new Error("invalid dashboard authentication state");
  }

  if (
    !plainRecord(value.failures) ||
    !plainRecord(value.bans) ||
    !plainRecord(value.sessions) ||
    Object.keys(value.failures).length > MAX_SECURITY_ENTRIES ||
    Object.keys(value.bans).length > MAX_SECURITY_ENTRIES ||
    Object.keys(value.sessions).length > MAX_SESSIONS
  ) {
    throw new Error("invalid dashboard authentication state");
  }

  for (const [ip, failure] of Object.entries(value.failures)) {
    if (
      !validStateIp(ip) ||
      !exactKeys(failure, ["count", "updatedAt"]) ||
      !Number.isSafeInteger(failure.count) ||
      failure.count < 1 ||
      failure.count > 9 ||
      !validTimestamp(failure.updatedAt)
    ) {
      throw new Error("invalid dashboard authentication state");
    }
  }

  for (const [ip, ban] of Object.entries(value.bans)) {
    if (
      !validStateIp(ip) ||
      !exactKeys(ban, ["bannedAt", "expiresAt"]) ||
      !validTimestamp(ban.bannedAt) ||
      !validTimestamp(ban.expiresAt) ||
      ban.expiresAt <= ban.bannedAt
    ) {
      throw new Error("invalid dashboard authentication state");
    }
  }

  for (const [digest, session] of Object.entries(value.sessions)) {
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      !exactKeys(session, ["createdAt", "expiresAt", "version"]) ||
      !validTimestamp(session.createdAt) ||
      !validTimestamp(session.expiresAt) ||
      session.expiresAt <= session.createdAt ||
      !/^[a-f0-9]{64}$/.test(session.version)
    ) {
      throw new Error("invalid dashboard authentication state");
    }
  }

  return {
    version: 2,
    failures: { ...value.failures },
    bans: { ...value.bans },
    sessions: { ...value.sessions },
  };
}

async function saveSecurityState(file, state) {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

class KdfGate {
  constructor(limit = DEFAULT_MAX_KDF_CONCURRENCY, maxQueue = DEFAULT_MAX_KDF_QUEUE) {
    this.limit = positiveInteger(limit, DEFAULT_MAX_KDF_CONCURRENCY, 1, 8);
    this.maxQueue = positiveInteger(maxQueue, DEFAULT_MAX_KDF_QUEUE, 1, 1_000);
    this.active = 0;
    this.waiters = [];
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(true);
    }
    if (this.waiters.length >= this.maxQueue) return Promise.resolve(false);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) next(true);
    else this.active -= 1;
  }

  async run(operation) {
    if (!(await this.acquire())) return { admitted: false, value: null };
    try {
      return { admitted: true, value: await operation() };
    } finally {
      this.release();
    }
  }
}

class LoginSecurityStore {
  constructor(file, options = {}) {
    this.file = path.resolve(file);
    this.maxFailures = positiveInteger(options.maxFailures, DEFAULT_MAX_FAILURES, 2, 10);
    this.banMs = positiveInteger(options.banMs, DEFAULT_BAN_MS, 60_000, 365 * 24 * 60 * 60 * 1000);
    this.failureWindowMs = positiveInteger(
      options.failureWindowMs,
      DEFAULT_FAILURE_WINDOW_MS,
      60_000,
      30 * 24 * 60 * 60 * 1000,
    );
    this.now = options.now || Date.now;
    if (!ipQueueMaps.has(this.file)) ipQueueMaps.set(this.file, new Map());
    this.ipQueues = ipQueueMaps.get(this.file);
    this.maxIpQueue = positiveInteger(
      options.maxIpQueue,
      DEFAULT_MAX_IP_QUEUE,
      this.maxFailures,
      100,
    );
    if (!kdfGates.has(this.file)) {
      kdfGates.set(
        this.file,
        new KdfGate(options.maxKdfConcurrency, options.maxKdfQueue),
      );
    }
    this.kdfGate = kdfGates.get(this.file);
  }

  async load() {
    try {
      return normalizeSecurityState(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return emptySecurityState();
    }
  }

  prune(state, now) {
    let changed = false;
    for (const [ip, failure] of Object.entries(state.failures)) {
      if (!failure || Number(failure.updatedAt || 0) + this.failureWindowMs <= now) {
        delete state.failures[ip];
        changed = true;
      }
    }
    for (const [ip, ban] of Object.entries(state.bans)) {
      if (!ban || Number(ban.expiresAt || 0) <= now) {
        delete state.bans[ip];
        changed = true;
      }
    }
    for (const [digest, session] of Object.entries(state.sessions)) {
      if (!session || Number(session.expiresAt || 0) <= now) {
        delete state.sessions[digest];
        changed = true;
      }
    }
    return changed;
  }

  runState(operation) {
    const previous = stateQueues.get(this.file) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    stateQueues.set(this.file, result);
    const cleanup = () => {
      if (stateQueues.get(this.file) === result) stateQueues.delete(this.file);
    };
    result.then(cleanup, cleanup);
    return result;
  }

  runForIp(ip, operation) {
    const entry = this.ipQueues.get(ip) || { tail: Promise.resolve(), pending: 0 };
    if (entry.pending >= this.maxIpQueue) return null;
    entry.pending += 1;
    const result = entry.tail.catch(() => {}).then(operation);
    entry.tail = result;
    this.ipQueues.set(ip, entry);
    const cleanup = () => {
      entry.pending -= 1;
      if (entry.pending === 0 && this.ipQueues.get(ip) === entry) this.ipQueues.delete(ip);
    };
    result.then(cleanup, cleanup);
    return result;
  }

  async readBan(clientIp) {
    return this.runState(async () => {
      const state = await this.load();
      const now = Number(this.now());
      if (this.prune(state, now)) await saveSecurityState(this.file, state);
      const ban = state.bans[clientIp];
      return ban
        ? { banned: true, bannedUntil: new Date(ban.expiresAt).toISOString() }
        : { banned: false, bannedUntil: null };
    });
  }

  authenticate(ip, verifyPassword) {
    const clientIp = normalizeIp(ip) || "unknown";
    const result = this.runForIp(clientIp, async () => {
      const existingBan = await this.readBan(clientIp);
      if (existingBan.banned) {
        return { ok: false, ...existingBan, busy: false, remainingAttempts: 0 };
      }

      const verification = await this.kdfGate.run(verifyPassword);
      if (!verification.admitted) {
        return {
          ok: false,
          banned: false,
          busy: true,
          remainingAttempts: null,
          bannedUntil: null,
        };
      }

      return this.runState(async () => {
        const state = await this.load();
        const now = Number(this.now());
        const pruned = this.prune(state, now);
        const activeBan = state.bans[clientIp];
        if (activeBan) {
          if (pruned) await saveSecurityState(this.file, state);
          return {
            ok: false,
            banned: true,
            busy: false,
            remainingAttempts: 0,
            bannedUntil: new Date(activeBan.expiresAt).toISOString(),
          };
        }

        if (verification.value) {
          const changed = Boolean(state.failures[clientIp]);
          delete state.failures[clientIp];
          if (changed || pruned) await saveSecurityState(this.file, state);
          return {
            ok: true,
            banned: false,
            busy: false,
            remainingAttempts: this.maxFailures,
          };
        }

        const previous = state.failures[clientIp];
        const count = Number(previous?.count || 0) + 1;
        if (count >= this.maxFailures) {
          if (!state.bans[clientIp] && Object.keys(state.bans).length >= MAX_SECURITY_ENTRIES) {
            return {
              ok: false,
              banned: false,
              busy: true,
              remainingAttempts: null,
              bannedUntil: null,
            };
          }
          const expiresAt = now + this.banMs;
          delete state.failures[clientIp];
          state.bans[clientIp] = { bannedAt: now, expiresAt };
          await saveSecurityState(this.file, state);
          return {
            ok: false,
            banned: true,
            busy: false,
            remainingAttempts: 0,
            bannedUntil: new Date(expiresAt).toISOString(),
          };
        }

        if (!previous && Object.keys(state.failures).length >= MAX_SECURITY_ENTRIES) {
          return {
            ok: false,
            banned: false,
            busy: true,
            remainingAttempts: null,
            bannedUntil: null,
          };
        }
        state.failures[clientIp] = { count, updatedAt: now };
        await saveSecurityState(this.file, state);
        return {
          ok: false,
          banned: false,
          busy: false,
          remainingAttempts: this.maxFailures - count,
          bannedUntil: null,
        };
      });
    });
    return result || Promise.resolve({
      ok: false,
      banned: false,
      busy: true,
      remainingAttempts: null,
      bannedUntil: null,
    });
  }

  banStatus(ip) {
    const clientIp = normalizeIp(ip) || "unknown";
    return this.readBan(clientIp);
  }

  createSession(ttlMs, version) {
    const lifetime = positiveInteger(ttlMs, 30 * 24 * 60 * 60 * 1000, 60_000, 90 * 24 * 60 * 60 * 1000);
    const passwordVersion = String(version || "");
    if (!/^[a-f0-9]{64}$/.test(passwordVersion)) {
      throw new Error("invalid dashboard password version");
    }
    return this.runState(async () => {
      const state = await this.load();
      const now = Number(this.now());
      let changed = this.prune(state, now);
      for (const [digest, session] of Object.entries(state.sessions)) {
        if (session.version !== passwordVersion) {
          delete state.sessions[digest];
          changed = true;
        }
      }
      if (Object.keys(state.sessions).length >= MAX_SESSIONS) return null;
      let token;
      let digest;
      do {
        token = randomBytes(32).toString("base64url");
        digest = createHash("sha256").update(token, "utf8").digest("hex");
      } while (state.sessions[digest]);
      const expiresAt = now + lifetime;
      state.sessions[digest] = { createdAt: now, expiresAt, version: passwordVersion };
      await saveSecurityState(this.file, state);
      return { value: token, expiresAt };
    });
  }

  sessionStatus(token, version) {
    const value = String(token || "");
    const passwordVersion = String(version || "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(value) || !/^[a-f0-9]{64}$/.test(passwordVersion)) {
      return Promise.resolve({ valid: false, expiresAt: null });
    }
    const digest = createHash("sha256").update(value, "utf8").digest("hex");
    return this.runState(async () => {
      const state = await this.load();
      const now = Number(this.now());
      let changed = this.prune(state, now);
      const session = state.sessions[digest];
      if (session && session.version !== passwordVersion) {
        delete state.sessions[digest];
        changed = true;
      }
      if (changed) await saveSecurityState(this.file, state);
      return session && session.version === passwordVersion
        ? { valid: true, expiresAt: Number(session.expiresAt) }
        : { valid: false, expiresAt: null };
    });
  }

  deleteSession(token) {
    const value = String(token || "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return Promise.resolve(false);
    const digest = createHash("sha256").update(value, "utf8").digest("hex");
    return this.runState(async () => {
      const state = await this.load();
      const changed = Boolean(state.sessions[digest]);
      delete state.sessions[digest];
      if (changed) await saveSecurityState(this.file, state);
      return changed;
    });
  }

  clearBan(ip) {
    const clientIp = normalizeIp(ip) || "unknown";
    return this.runState(async () => {
      const state = await this.load();
      const changed = Boolean(state.bans[clientIp] || state.failures[clientIp]);
      delete state.bans[clientIp];
      delete state.failures[clientIp];
      if (changed) await saveSecurityState(this.file, state);
      return changed;
    });
  }
}

export {
  DEFAULT_BAN_MS,
  DEFAULT_MAX_FAILURES,
  LoginSecurityStore,
  hashDashboardPassword,
  passwordHashVersion,
  parseCookies,
  parsePasswordHash,
  requestClientIp,
  sessionCookie,
  verifyDashboardPassword,
};
