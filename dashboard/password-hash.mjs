#!/usr/bin/env node

import { hashDashboardPassword } from "./auth.mjs";

const password = process.env.LDXP_DASHBOARD_PASSWORD || "";
if (!password) {
  console.error("LDXP_DASHBOARD_PASSWORD is required");
  process.exitCode = 1;
} else {
  console.log(await hashDashboardPassword(password));
}
