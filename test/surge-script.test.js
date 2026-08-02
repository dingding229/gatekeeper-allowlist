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
              ips: [],
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
        ips: [],
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
  assert.equal(payload.deviceName, "Surge");
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

test("Surge submits the IPCheck address and metadata", () => {
  const { posts, postOptions } = runSurge({ lookupIp: "8.8.8.8" });
  assert.equal(posts, 1);
  const payload = JSON.parse(postOptions.body);
  assert.equal(payload.ip, "8.8.8.8");
  assert.equal(payload.ipInfo.city, "Test");
});

test("Surge still submits when public IP lookup fails", () => {
  const { posts, postOptions } = runSurge({ lookupError: "timeout" });
  assert.equal(posts, 1);
  const payload = JSON.parse(postOptions.body);
  assert.equal(payload.ip, undefined);
  assert.equal(payload.ipInfo, undefined);
});
