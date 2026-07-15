import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CHALLENGE_WAIT_MS = 2_000;
const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

class BrowserTransportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BrowserTransportError";
    this.code = code;
    this.details = details;
  }
}

function isHtmlResponse(contentType, raw) {
  return String(contentType || "").toLowerCase().includes("text/html") || /^\s*</.test(raw || "");
}

function responsePreview(raw) {
  return String(raw || "").replace(/\s+/g, " ").slice(0, 160);
}

async function firstExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known browser location.
    }
  }
  return "";
}

async function resolveBrowserExecutable(explicitPath = "") {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    try {
      await access(resolved);
      return resolved;
    } catch {
      throw new BrowserTransportError(
        "BROWSER_EXECUTABLE_NOT_FOUND",
        `Chromium executable does not exist: ${resolved}`,
      );
    }
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates =
    process.platform === "win32"
      ? [
          process.env.PROGRAMFILES &&
            path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
          process.env["PROGRAMFILES(X86)"] &&
            path.join(
              process.env["PROGRAMFILES(X86)"],
              "Google",
              "Chrome",
              "Application",
              "chrome.exe",
            ),
          process.env.LOCALAPPDATA &&
            path.join(
              process.env.LOCALAPPDATA,
              "Google",
              "Chrome",
              "Application",
              "chrome.exe",
            ),
          process.env.PROGRAMFILES &&
            path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            home && path.join(home, ".local", "bin", "chromium"),
          ];

  const executable = await firstExecutable(candidates);
  if (!executable) {
    throw new BrowserTransportError(
      "BROWSER_EXECUTABLE_NOT_FOUND",
      "No Chrome/Chromium executable was found. Set LDXP_BROWSER_EXECUTABLE_PATH.",
    );
  }
  return executable;
}

async function loadChromium(chromiumOverride) {
  if (chromiumOverride) return chromiumOverride;
  try {
    const { chromium } = await import("playwright-core");
    return chromium;
  } catch (error) {
    throw new BrowserTransportError(
      "BROWSER_RUNTIME_MISSING",
      "playwright-core is not installed. Run npm install before enabling browser transport.",
      { cause: error.message },
    );
  }
}

async function createBrowserTransport(options, dependencies = {}) {
  const baseUrl = String(options.baseUrl || "").replace(/\/+$/, "");
  const shopToken = String(options.shopToken || "");
  if (!baseUrl || !shopToken) {
    throw new BrowserTransportError(
      "BROWSER_CONFIG_INVALID",
      "Browser transport requires baseUrl and shopToken.",
    );
  }

  const profileDir = path.resolve(options.profileDir || path.join(".runtime", "browser-profile"));
  const requestTimeoutMs = Math.max(
    1_000,
    Number(options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS),
  );
  const navigationTimeoutMs = Math.max(
    1_000,
    Number(options.navigationTimeoutMs || DEFAULT_NAVIGATION_TIMEOUT_MS),
  );
  const challengeWaitMs = Math.max(
    250,
    Number(options.challengeWaitMs || DEFAULT_CHALLENGE_WAIT_MS),
  );
  const maxChallengeAttempts = Math.max(1, Number(options.maxChallengeAttempts || 2));

  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const chromium = await loadChromium(dependencies.chromium);
  const executablePath = dependencies.chromium
    ? options.executablePath || ""
    : await resolveBrowserExecutable(options.executablePath);
  const launchArgs = ["--disable-dev-shm-usage"];
  const proxyServer = String(options.proxyServer || "").trim();
  if (proxyServer.toLowerCase() === "direct") {
    launchArgs.push("--no-proxy-server");
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    launchArgs.push("--no-sandbox");
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: executablePath || undefined,
      headless: options.headless !== false,
      locale: "zh-CN",
      userAgent: options.userAgent || DEFAULT_BROWSER_USER_AGENT,
      args: launchArgs,
      ...(proxyServer && proxyServer.toLowerCase() !== "direct"
        ? { proxy: { server: proxyServer } }
        : {}),
    });
  } catch (error) {
    throw new BrowserTransportError("BROWSER_LAUNCH_FAILED", `Unable to launch Chromium: ${error.message}`);
  }

  context.setDefaultTimeout?.(requestTimeoutMs);
  context.setDefaultNavigationTimeout?.(navigationTimeoutMs);
  const page = context.pages()[0] || (await context.newPage());
  const shopUrl = `${baseUrl}/shop/${encodeURIComponent(shopToken)}`;
  let sessionReady = false;

  async function warmSession(force = false) {
    if (sessionReady && !force) return;
    try {
      await page.goto(shopUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
      await page.waitForTimeout(challengeWaitMs);
      await page.waitForLoadState("networkidle", { timeout: challengeWaitMs }).catch(() => {});
      sessionReady = true;
    } catch (error) {
      sessionReady = false;
      throw new BrowserTransportError(
        "BROWSER_WARMUP_FAILED",
        `Unable to open the shop page: ${error.message}`,
      );
    }
  }

  async function browserPost(endpoint, payload, visitorId) {
    return page.evaluate(
      async ({ url, body, visitor, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {
              accept: "application/json, text/plain, */*",
              "content-type": "application/json;charset=UTF-8",
              visitorid: visitor,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          return {
            ok: response.ok,
            status: response.status,
            contentType: response.headers.get("content-type") || "unknown",
            raw: await response.text(),
          };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        url: `${baseUrl}${endpoint}`,
        body: payload,
        visitor: visitorId,
        timeoutMs: requestTimeoutMs,
      },
    );
  }

  async function executeChallenge(raw) {
    try {
      if (!page.url().startsWith(baseUrl)) {
        await warmSession(true);
      }
      await page.setContent(raw, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    } catch {
      // Challenge scripts often trigger a navigation while setContent is still waiting.
    }
    await page.waitForTimeout(challengeWaitMs);
    await warmSession(true);
  }

  return {
    profileDir,
    async post(endpoint, payload, visitorId) {
      await warmSession();

      let lastResponse;
      for (let challengeAttempt = 1; challengeAttempt <= maxChallengeAttempts; challengeAttempt += 1) {
        try {
          lastResponse = await browserPost(endpoint, payload, visitorId);
        } catch (error) {
          throw new BrowserTransportError(
            "BROWSER_REQUEST_FAILED",
            `Browser API request failed: ${error.message}`,
          );
        }

        if (!isHtmlResponse(lastResponse.contentType, lastResponse.raw)) {
          return lastResponse;
        }

        if (challengeAttempt < maxChallengeAttempts) {
          await executeChallenge(lastResponse.raw);
        }
      }

      const browserBlocked =
        lastResponse?.status === 403 && /403\s+Forbidden|Forbidden/i.test(lastResponse?.raw || "");
      throw new BrowserTransportError(
        browserBlocked ? "WAF_BROWSER_BLOCKED" : "WAF_INTERACTIVE_CHALLENGE",
        browserBlocked
          ? "ESA rejected this automated browser with HTTP 403. Run headed Chromium under Xvfb or request IP allowlisting."
          : "The shop still returned an HTML challenge after Chromium executed it. The IP may require manual verification or allowlisting.",
        {
          status: lastResponse?.status,
          contentType: lastResponse?.contentType,
          preview: responsePreview(lastResponse?.raw),
        },
      );
    },
    async close() {
      await context.close();
    },
  };
}

export {
  BrowserTransportError,
  DEFAULT_BROWSER_USER_AGENT,
  createBrowserTransport,
  isHtmlResponse,
  resolveBrowserExecutable,
};
