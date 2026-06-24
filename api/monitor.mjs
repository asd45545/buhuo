export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const authHeader = req.headers.authorization || "";
  const requestUrl = new URL(req.url || "/api/monitor", "https://ldxp-monitor.local");
  const querySecret = requestUrl.searchParams.get("secret") || "";
  const isAuthorized =
    !process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}` ||
    querySecret === process.env.CRON_SECRET;

  if (!isAuthorized) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  const repo = process.env.LDXP_STATE_REPO || "asd45545/buhuo";
  const workflow = process.env.LDXP_WORKFLOW_ID || "ldxp-stock-monitor.yml";
  const ref = process.env.LDXP_STATE_BRANCH || "main";
  const token = process.env.LDXP_GITHUB_TOKEN;

  if (!token) {
    return sendJson(res, 500, { ok: false, error: "missing env LDXP_GITHUB_TOKEN" });
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "ldxp-vercel-workflow-trigger",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref }),
  });

  if (!response.ok) {
    return sendJson(res, response.status, {
      ok: false,
      error: `github_dispatch_failed_${response.status}`,
      detail: await response.text(),
    });
  }

  return sendJson(res, 200, {
    ok: true,
    dispatched: true,
    repo,
    workflow,
    ref,
    checkedAt: new Date().toISOString(),
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
