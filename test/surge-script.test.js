import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(
  new URL("../surge/gatekeeper.js", import.meta.url),
  "utf8",
);

function runSurge({
  initialStore = {},
  postResponse,
  lookupIp = "8.8.8.8",
  lookupError = null,
  environment = { system: "iOS", "device-model": "iPhone17,1" },
} = {}) {
  const store = new Map(
    Object.entries({
      gatekeeper_device_id_sg_test: "device_test_01",
      ...initialStore,
    }),
  );
  let result;
  let requests = 0;
  let posts = 0;
  let postOptions;
  const context = {
    $argument:
      "url=https%3A%2F%2Fallowlist.example.com&key=sg_test&cooldown=30",
    $environment: environment,
    $persistentStore: {
      read: (key) => store.get(key) || null,
      write: (value, key) => {
        store.set(key, value);
        return true;
      },
    },
    $notification: { post: () => {} },
    $done: (value) => {
      result = value;
    },
    $httpClient: {
      get: (_options, callback) => {
        requests += 1;
        if (lookupError) {
          callback(lookupError, null, "");
          return;
        }
        callback(
          null,
          { status: 200 },
          `IP: ${lookupIp}\nCity: Test\nCountry: US\nOrg: ISP\n`,
        );
      },
      post: (_options, callback) => {
        postOptions = _options;
        requests += 1;
        posts += 1;
        callback(
          null,
          { status: postResponse?.status || 201 },
          JSON.stringify(
            postResponse?.body || {
              ok: true,
              status: "added",
              slots: 1,
              limit: 3,
              ip: "8.8.8.0/24",
              rateLimitSeconds: 30,
              ips: [{ ip: "8.8.8.0/24" }],
            },
          ),
        );
      },
    },
  };
  vm.runInNewContext(script, context);
  return { result, requests, posts, store, postOptions };
}

test("Surge translates rate limiting into a clear reason without status codes", () => {
  const { result } = runSurge({
    postResponse: {
      status: 429,
      body: { error: "rate_limit_exceeded", retryAfter: 18 },
    },
  });
  assert.match(result.content, /请求过于频繁，请在 18 秒后重试/);
  assert.doesNotMatch(result.content, /429|HTTP/);
});

test("Surge suppresses overlapping triggers during the local cooldown", () => {
  const future = Date.now() + 20_000;
  const { result, requests } = runSurge({
    initialStore: { gatekeeper_next_report_device_test_01: String(future) },
  });
  assert.equal(requests, 0);
  assert.match(result.content, /刚刚已经触发过上报/);
});

test("Surge learns the current server cooldown after a successful report", () => {
  const before = Date.now();
  const { store } = runSurge({
    postResponse: {
      status: 201,
      body: {
        ok: true,
        status: "added",
        slots: 1,
        limit: 3,
        ip: "8.8.8.0/24",
        rateLimitSeconds: 90,
        ips: [{ ip: "8.8.8.0/24" }],
      },
    },
  });
  assert.ok(
    Number(store.get("gatekeeper_next_report_device_test_01")) >=
      before + 89_000,
  );
});

test("Surge sends a stable per-installation device identity", () => {
  const { postOptions } = runSurge();
  const payload = JSON.parse(postOptions.body);
  assert.equal(postOptions.headers["X-Gatekeeper-Device-ID"], "device_test_01");
  assert.equal(payload.deviceId, "device_test_01");
  assert.equal(payload.deviceName, "iPhone17,1 · iOS");
});

test("Surge displays its platform when the device model is unavailable", () => {
  const { postOptions } = runSurge({ environment: { system: "macOS" } });
  const payload = JSON.parse(postOptions.body);
  assert.equal(payload.deviceName, "Surge · macOS");
});

test("Surge submits on every trigger even when the public IP is unchanged", () => {
  const { requests, posts } = runSurge({
    initialStore: {
      gatekeeper_last_reported_ip_device_test_01: "8.8.8.8",
    },
  });
  assert.equal(requests, 2);
  assert.equal(posts, 1);
});

test("Surge submits IPCheck metadata but trusts the request source IP", () => {
  const { posts, postOptions } = runSurge({ lookupIp: "8.8.8.8" });
  assert.equal(posts, 1);
  const payload = JSON.parse(postOptions.body);
  assert.equal(payload.ip, undefined);
  assert.equal(payload.ipInfo.ip, "8.8.8.8");
  assert.equal(payload.ipInfo.city, "Test");
});

test("Surge still submits when public IP lookup fails", () => {
  const { posts, postOptions } = runSurge({ lookupError: "timeout" });
  assert.equal(posts, 1);
  const payload = JSON.parse(postOptions.body);
  assert.equal(payload.ip, undefined);
  assert.equal(payload.ipInfo, undefined);
});

test("Surge reports failure when the current network is absent from the returned whitelist", () => {
  const { result } = runSurge({
    postResponse: {
      status: 200,
      body: {
        ok: true,
        status: "existing",
        slots: 1,
        limit: 3,
        ip: "8.8.8.0/24",
        rateLimitSeconds: 30,
        ips: [{ ip: "1.1.1.0/24" }],
      },
    },
  });
  assert.match(result.title, /加白未生效/);
  assert.equal(result.style, "error");
});
