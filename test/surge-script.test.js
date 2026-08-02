import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(
  new URL("../surge/gatekeeper.js", import.meta.url),
  "utf8",
);

function runSurge({ initialStore = {}, postResponse } = {}) {
  const store = new Map(Object.entries(initialStore));
  let result;
  let requests = 0;
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
        callback(
          null,
          { status: 200 },
          "IP: 8.8.8.8\nCity: Test\nCountry: US\nOrg: ISP\n",
        );
      },
      post: (_options, callback) => {
        requests += 1;
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
  return { result, requests, store };
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
    initialStore: { gatekeeper_next_report_sg_test: String(future) },
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
    Number(store.get("gatekeeper_next_report_sg_test")) >= before + 89_000,
  );
});
