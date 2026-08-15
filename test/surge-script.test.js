import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  SERVER_VERSION,
  SURGE_MODULE_VERSION,
  SURGE_SCRIPT_VERSION,
} from "../src/version.js";

const script = readFileSync(
  new URL("../surge/gatekeeper.js", import.meta.url),
  "utf8",
);
const publicModule = readFileSync(
  new URL("../surge/gatekeeper.sgmodule", import.meta.url),
  "utf8",
);

function runSurge({
  initialStore = {},
  postResponse,
  lookupIp = "8.8.8.8",
  lookupError = null,
  environment = { system: "iOS", "device-model": "iPhone17,1" },
  trigger = { type: "cron", name: "gatekeeper_1_cron" },
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
  const notifications = [];
  const context = {
    $argument: `url=https%3A%2F%2Fallowlist.example.com&key=sg_test&cooldown=30&moduleVersion=${SURGE_MODULE_VERSION}`,
    $environment: environment,
    $script: trigger,
    $persistentStore: {
      read: (key) => store.get(key) || null,
      write: (value, key) => {
        store.set(key, value);
        return true;
      },
    },
    $notification: {
      post: (...items) => notifications.push(items),
    },
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
              serverVersion: SERVER_VERSION,
              rateLimitSeconds: 30,
              ips: [{ ip: "8.8.8.0/24" }],
            },
          ),
        );
      },
    },
  };
  vm.runInNewContext(script, context);
  return { result, requests, posts, store, postOptions, notifications };
}

test("Surge panel exposes module, script, and server versions", () => {
  const { result } = runSurge();
  assert.match(result.content, /新网段已加入白名单/);
  assert.doesNotMatch(result.content, /检查确认：当前网段已在白名单/);
  assert.match(
    result.content,
    new RegExp(`版本：模块 v${SURGE_MODULE_VERSION}`),
  );
  assert.match(
    result.content,
    new RegExp(`\u811a\u672c v${SURGE_SCRIPT_VERSION}`),
  );
  assert.match(result.content, new RegExp(`服务端 v${SERVER_VERSION}`));
  assert.match(
    script,
    new RegExp(`var SCRIPT_VERSION = "${SURGE_SCRIPT_VERSION}"`),
  );
  assert.match(publicModule, new RegExp(`#!version=${SURGE_MODULE_VERSION}`));
  assert.match(
    publicModule,
    new RegExp(`moduleVersion=${SURGE_MODULE_VERSION}`),
  );
});

test("Surge distinguishes existing networks from newly added networks", () => {
  const { result } = runSurge({
    initialStore: {
      gatekeeper_last_change_device_test_01: JSON.stringify({
        network: "8.8.8.0/24",
        evicted: "1.1.1.0/24",
        at: Date.now() - 60_000,
      }),
    },
    postResponse: {
      status: 200,
      body: {
        ok: true,
        status: "existing",
        slots: 2,
        limit: 3,
        ip: "8.8.8.0/24",
        rateLimitSeconds: 30,
        ips: [{ ip: "8.8.8.0/24" }],
      },
    },
  });
  assert.match(result.content, /检查确认：当前网段已在白名单/);
  assert.match(result.content, /最近新增：/);
  assert.match(result.content, /淘汰 1\.1\.1\.0\/24/);
});

test("Surge rejects unknown success statuses instead of claiming allowlist membership", () => {
  const { result, notifications } = runSurge({
    postResponse: {
      status: 200,
      body: {
        ok: true,
        status: "unknown",
        slots: 1,
        limit: 3,
        ip: "8.8.8.0/24",
        ips: [{ ip: "8.8.8.0/24" }],
      },
    },
  });
  assert.equal(result.style, "error");
  assert.match(result.title, /服务端响应异常/);
  assert.match(result.content, /实际为 unknown/);
  assert.ok(notifications.some((items) => items[1] === "上报失败"));
});

test("Surge provides a one-tap module update when versions are rejected", () => {
  const { result, notifications } = runSurge({
    postResponse: {
      status: 426,
      body: {
        error: "module_update_required",
        requiredModuleVersion: SURGE_MODULE_VERSION,
        requiredScriptVersion: SURGE_SCRIPT_VERSION,
        receivedModuleVersion: "1.2.4",
        receivedScriptVersion: "1.2.3",
      },
    },
  });
  assert.match(result.title, /必须更新/);
  assert.match(result.content, /版本不兼容/);
  assert.match(result.content, /当前模块 v1\.2\.4、脚本 v1\.2\.3/);
  assert.match(
    result.content,
    new RegExp(
      `需要模块 v${SURGE_MODULE_VERSION.replaceAll(".", "\\.")}、脚本 v${SURGE_SCRIPT_VERSION.replaceAll(".", "\\.")}`,
    ),
  );
  const updateNotification = notifications.find(
    (items) => items[0] === "Gatekeeper 必须更新",
  );
  assert.ok(updateNotification);
  assert.equal(updateNotification[3].action, "open-url");
  assert.match(updateNotification[3].url, /^surge:\/\/\/install-module\?url=/);
});

test("Surge translates rate limiting into a clear reason without status codes", () => {
  const { result } = runSurge({
    trigger: { type: "generic", name: "gatekeeper_1_panel" },
    postResponse: {
      status: 429,
      body: { error: "rate_limit_exceeded", retryAfter: 18 },
    },
  });
  assert.match(result.content, /请求过于频繁，请在 18 秒后重试/);
  assert.doesNotMatch(result.content, /429|HTTP/);
});

test("Surge quietly merges automatic triggers rejected by server cooldown", () => {
  const { result, notifications } = runSurge({
    postResponse: {
      status: 429,
      body: { error: "rate_limit_exceeded", retryAfter: 18 },
    },
  });
  assert.equal(result.style, "good");
  assert.match(result.title, /请求已合并/);
  assert.doesNotMatch(result.content, /请求过于频繁|429/);
  assert.equal(notifications.length, 0);
});

test("Surge suppresses overlapping triggers during the local cooldown", () => {
  const future = Date.now() + 20_000;
  const { result, requests } = runSurge({
    initialStore: { gatekeeper_next_report_device_test_01: String(future) },
  });
  assert.equal(requests, 0);
  assert.match(result.content, /刚刚已经触发过上报/);
});

test("Surge suppresses concurrent IP checks across all trigger types", () => {
  const future = Date.now() + 20_000;
  const { result, requests, posts } = runSurge({
    initialStore: { gatekeeper_in_flight_device_test_01: String(future) },
    trigger: { type: "event", name: "gatekeeper_1_event" },
  });
  assert.equal(requests, 0);
  assert.equal(posts, 0);
  assert.match(result.title, /请求已合并/);
});

test("Surge network change events bypass the local cooldown", () => {
  const before = Date.now();
  const future = Date.now() + 20_000;
  const { requests, posts, store } = runSurge({
    initialStore: { gatekeeper_next_report_device_test_01: String(future) },
    trigger: { type: "event", name: "gatekeeper_1_event" },
  });
  assert.equal(requests, 2);
  assert.equal(posts, 1);
  assert.ok(
    Number(store.get("gatekeeper_next_periodic_check_device_test_01")) >=
      before + 599_000,
  );
});

test("Surge does not retry the same attempted IP during server cooldown", () => {
  const future = Date.now() + 20_000;
  const { result, requests, posts } = runSurge({
    initialStore: {
      gatekeeper_next_report_device_test_01: String(future),
      gatekeeper_last_attempted_ip_device_test_01: "8.8.8.8",
    },
    trigger: { type: "event", name: "gatekeeper_1_event" },
  });
  assert.equal(requests, 1);
  assert.equal(posts, 0);
  assert.match(result.title, /等待服务端冷却/);
});

test("Surge postpones periodic self-healing after a network change", () => {
  const future = Date.now() + 9 * 60_000;
  const { result, requests, posts } = runSurge({
    initialStore: {
      gatekeeper_next_periodic_check_device_test_01: String(future),
    },
    trigger: { type: "cron", name: "gatekeeper_1_cron" },
  });
  assert.equal(requests, 0);
  assert.equal(posts, 0);
  assert.match(result.title, /定时自愈已延后/);
  assert.match(result.content, /9 分钟后再检查/);
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
  assert.equal(payload.moduleVersion, SURGE_MODULE_VERSION);
  assert.equal(payload.scriptVersion, SURGE_SCRIPT_VERSION);
});

test("Surge displays its platform when the device model is unavailable", () => {
  const { postOptions } = runSurge({ environment: { system: "macOS" } });
  const payload = JSON.parse(postOptions.body);
  assert.equal(payload.deviceName, "Surge · macOS");
});

test("Surge skips automatic submission when the public IP is unchanged", () => {
  const { result, requests, posts } = runSurge({
    initialStore: {
      gatekeeper_last_reported_ip_device_test_01: "8.8.8.8",
    },
  });
  assert.equal(requests, 1);
  assert.equal(posts, 0);
  assert.match(result.title, /出口 IP 未变化/);
  assert.match(result.content, /无需重复提交白名单/);
});

test("Surge records the public IP only after a successful submission", () => {
  const { store } = runSurge({ lookupIp: "8.8.4.4" });
  assert.equal(
    store.get("gatekeeper_last_reported_ip_device_test_01"),
    "8.8.4.4",
  );
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
