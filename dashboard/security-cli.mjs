#!/usr/bin/env node

import { isIP } from "node:net";
import path from "node:path";

import { LoginSecurityStore } from "./auth.mjs";

const args = process.argv.slice(2);
const command = args[0] || "";
const ip = args[1] || "";
const fileIndex = args.indexOf("--file");
const file = path.resolve(
  fileIndex >= 0 && args[fileIndex + 1]
    ? args[fileIndex + 1]
    : process.env.LDXP_DASHBOARD_SECURITY_FILE || "/var/lib/ldxp-dashboard/auth-state.json",
);

if (command !== "unban" || !isIP(ip)) {
  console.error("Usage: node dashboard/security-cli.mjs unban <IP> [--file PATH]");
  process.exitCode = 1;
} else {
  const store = new LoginSecurityStore(file);
  const changed = await store.clearBan(ip);
  console.log(changed ? `UNBANNED ip=${ip}` : `NO_BAN_FOUND ip=${ip}`);
}
