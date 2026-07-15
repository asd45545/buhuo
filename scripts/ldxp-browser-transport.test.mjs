import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createBrowserTransport,
  isHtmlResponse,
} from "./ldxp-browser-transport.mjs";

function fakeChromium(responses, events) {
  const page = {
    _url: "about:blank",
    async goto(url) {
      events.push(["goto", url]);
      this._url = url;
    },
    async waitForTimeout(ms) {
      events.push(["wait", ms]);
    },
    async waitForLoadState() {},
    url() {
      return this._url;
    },
    async setContent(html) {
      events.push(["challenge", html]);
    },
    async evaluate() {
      events.push(["post"]);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
  const context = {
    pages: () => [page],
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    async close() {
      events.push(["close"]);
    },
  };

  return {
    async launchPersistentContext(profileDir, options) {
      events.push(["launch", profileDir, options]);
      return context;
    },
  };
}

async function withProfile(t) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "ldxp-browser-test-"));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  return profileDir;
}

test("HTML challenge detection uses both content type and response prefix", () => {
  assert.equal(isHtmlResponse("text/html; charset=utf-8", "challenge"), true);
  assert.equal(isHtmlResponse("application/octet-stream", "  <!doctype html>"), true);
  assert.equal(isHtmlResponse("application/json", '{"code":1}'), false);
});

test("browser transport posts from a persistent same-origin page", async (t) => {
  const profileDir = await withProfile(t);
  const events = [];
  const transport = await createBrowserTransport(
    {
      baseUrl: "https://pay.ldxp.cn",
      shopToken: "jisuai",
      profileDir,
      challengeWaitMs: 1,
      proxyServer: "direct",
    },
    {
      chromium: fakeChromium(
        [
          {
            ok: true,
            status: 200,
            contentType: "application/json; charset=utf-8",
            raw: '{"code":1,"data":{"total":129}}',
          },
        ],
        events,
      ),
    },
  );

  const response = await transport.post("/shopApi/Shop/goodsList", { current: 1 }, "visitor");
  await transport.close();

  assert.equal(response.status, 200);
  assert.match(response.raw, /"total":129/);
  assert.equal(events.filter(([name]) => name === "launch").length, 1);
  const launchOptions = events.find(([name]) => name === "launch")[2];
  assert.ok(launchOptions.args.includes("--no-proxy-server"));
  assert.doesNotMatch(launchOptions.userAgent, /HeadlessChrome/);
  assert.equal(events.filter(([name]) => name === "goto").length, 1);
  assert.equal(events.filter(([name]) => name === "post").length, 1);
});

test("browser transport passes authenticated proxy credentials separately", async (t) => {
  const profileDir = await withProfile(t);
  const events = [];
  const transport = await createBrowserTransport(
    {
      baseUrl: "https://pay.ldxp.cn",
      shopToken: "jisuai",
      profileDir,
      challengeWaitMs: 1,
      proxyServer: "http://proxy.example:3128",
      proxyUsername: "proxy-user",
      proxyPassword: "proxy-password",
    },
    {
      chromium: fakeChromium(
        [
          {
            ok: true,
            status: 200,
            contentType: "application/json",
            raw: '{"code":1,"data":{"total":129}}',
          },
        ],
        events,
      ),
    },
  );

  await transport.post("/shopApi/Shop/goodsList", { current: 1 }, "visitor");
  await transport.close();

  const launchOptions = events.find(([name]) => name === "launch")[2];
  assert.deepEqual(launchOptions.proxy, {
    server: "http://proxy.example:3128",
    username: "proxy-user",
    password: "proxy-password",
  });
});

test("browser transport rejects incomplete proxy credentials", async (t) => {
  const profileDir = await withProfile(t);

  await assert.rejects(
    createBrowserTransport(
      {
        baseUrl: "https://pay.ldxp.cn",
        shopToken: "jisuai",
        profileDir,
        proxyServer: "http://proxy.example:3128",
        proxyUsername: "proxy-user",
      },
      { chromium: fakeChromium([], []) },
    ),
    (error) => error.code === "BROWSER_CONFIG_INVALID",
  );
});

test("browser transport executes an HTML challenge and retries once", async (t) => {
  const profileDir = await withProfile(t);
  const events = [];
  const challenge = {
    ok: true,
    status: 200,
    contentType: "text/html; charset=utf-8",
    raw: "<!doctype html><script>document.cookie='acw_sc__v2=test'</script>",
  };
  const transport = await createBrowserTransport(
    {
      baseUrl: "https://pay.ldxp.cn",
      shopToken: "jisuai",
      profileDir,
      challengeWaitMs: 1,
      maxChallengeAttempts: 2,
    },
    {
      chromium: fakeChromium(
        [
          challenge,
          {
            ok: true,
            status: 200,
            contentType: "application/json",
            raw: '{"code":1,"data":{"total":129}}',
          },
        ],
        events,
      ),
    },
  );

  const response = await transport.post("/shopApi/Shop/goodsList", { current: 1 }, "visitor");
  await transport.close();

  assert.equal(response.status, 200);
  assert.equal(events.filter(([name]) => name === "challenge").length, 1);
  assert.equal(events.filter(([name]) => name === "post").length, 2);
});

test("browser transport reports an interactive challenge instead of retrying forever", async (t) => {
  const profileDir = await withProfile(t);
  const events = [];
  const challenge = {
    ok: true,
    status: 200,
    contentType: "text/html; charset=utf-8",
    raw: "<!doctype html><title>Verification</title>",
  };
  const transport = await createBrowserTransport(
    {
      baseUrl: "https://pay.ldxp.cn",
      shopToken: "jisuai",
      profileDir,
      challengeWaitMs: 1,
      maxChallengeAttempts: 2,
    },
    { chromium: fakeChromium([challenge, challenge], events) },
  );

  await assert.rejects(
    transport.post("/shopApi/Shop/goodsList", { current: 1 }, "visitor"),
    (error) => error.code === "WAF_INTERACTIVE_CHALLENGE",
  );
  await transport.close();
});

test("browser transport distinguishes a browser fingerprint block", async (t) => {
  const profileDir = await withProfile(t);
  const events = [];
  const blocked = {
    ok: false,
    status: 403,
    contentType: "text/html; charset=utf-8",
    raw: "<!doctype html><title>403 Forbidden</title>",
  };
  const transport = await createBrowserTransport(
    {
      baseUrl: "https://pay.ldxp.cn",
      shopToken: "jisuai",
      profileDir,
      challengeWaitMs: 1,
      maxChallengeAttempts: 2,
    },
    { chromium: fakeChromium([blocked, blocked], events) },
  );

  await assert.rejects(
    transport.post("/shopApi/Shop/goodsList", { current: 1 }, "visitor"),
    (error) => error.code === "WAF_BROWSER_BLOCKED" && error.details.status === 403,
  );
  await transport.close();
});
