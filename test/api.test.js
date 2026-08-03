import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createRepository } from "../src/repository.js";
import {
  SERVER_VERSION,
  SURGE_MODULE_VERSION,
  SURGE_SCRIPT_VERSION,
} from "../src/version.js";

const config = {
  adminUsername: "admin",
  adminPassword: "test-password",
  firewallSyncToken: "test-firewall-token-with-24-chars",
  trustProxy: false,
  cookieSecure: false,
  adminPath: "/manage-test",
  publicBaseUrl: "https://allowlist.example.test",
  apiRateLimitWindowMs: 0,
};

const ipInfo = {
  lookup: async () => null,
  getServerInfo: async () => ({
    ips: ["198.51.100.10"],
    available: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
};

async function startTestApp(t, configOverrides = {}) {
  const db = openDatabase(":memory:");
  const repository = createRepository(db);
  const server = createApp({
    db,
    config: { ...config, ...configOverrides },
    services: { ipInfo },
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.close();
    db.close();
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    repository,
  };
}

test("health endpoint exposes the server version", async (t) => {
  const { baseUrl } = await startTestApp(t);
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    version: SERVER_VERSION,
  });
});

test("empty API body uses the request source IP", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const user = repository.createUser("client");
  const response = await fetch(`${baseUrl}/api/v1/whitelist`, {
    method: "POST",
    headers: { Authorization: `Bearer ${user.apiKey}` },
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.ip, "127.0.0.0/24");
  assert.equal(body.applied, true);
  assert.equal(body.limit, 3);
});

test("server rejects incompatible Surge module and script versions", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const user = repository.createUser("version-bound-surge");
  const request = (moduleVersion, scriptVersion) =>
    fetch(`${baseUrl}/api/v1/whitelist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${user.apiKey}`,
        "Content-Type": "application/json",
        "X-Gatekeeper-Device-ID": "version_test_device",
      },
      body: JSON.stringify({
        source: "surge",
        moduleVersion,
        scriptVersion,
      }),
    });

  const outdated = await request("1.1.0", "1.1.0");
  assert.equal(outdated.status, 426);
  const error = await outdated.json();
  assert.equal(error.error, "module_update_required");
  assert.equal(error.requiredModuleVersion, SURGE_MODULE_VERSION);
  assert.equal(error.requiredScriptVersion, SURGE_SCRIPT_VERSION);
  assert.equal(error.receivedModuleVersion, "1.1.0");
  assert.equal(error.receivedScriptVersion, "1.1.0");
  assert.equal(repository.listUserDevices(user.id).length, 0);

  const compatible = await request(SURGE_MODULE_VERSION, SURGE_SCRIPT_VERSION);
  assert.equal(compatible.status, 201);
});

test("API normalizes equivalent IPv6 addresses", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const user = repository.createUser("ipv6-client");
  const request = (ip) =>
    fetch(`${baseUrl}/api/v1/whitelist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${user.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ip }),
    });

  assert.equal((await request("2001:0db8:0:0:0:0:0:1")).status, 201);
  const duplicate = await request("2001:db8::1");
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).status, "existing");
  assert.equal(repository.listUserIps(user.id).length, 1);
});

test("IPv4 addresses in the same /24 share one slot", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const user = repository.createUser("cidr-client");
  const request = (ip) =>
    fetch(`${baseUrl}/api/v1/whitelist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${user.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ip }),
    });

  assert.equal((await request("203.0.113.8")).status, 201);
  const duplicate = await request("203.0.113.222");
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).ip, "203.0.113.0/24");
  assert.equal(repository.listUserIps(user.id).length, 1);
});

test("admin endpoint rejects non-boolean enabled values", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const user = repository.createUser("managed-user");
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const response = await fetch(`${baseUrl}/api/admin/users/${user.id}`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: "false" }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_enabled_value");
});

test("admin can update normalized TCP and UDP port ranges", async (t) => {
  const { baseUrl } = await startTestApp(t);
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const response = await fetch(`${baseUrl}/api/admin/settings/firewall`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      tcpPorts: "22, 8000-9000, 8500-9500",
      udpPorts: "53,51820",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).settings, {
    tcpPorts: ["22", "8000-9500"],
    udpPorts: ["53", "51820"],
  });
});

test("admin can change API frequency and login credentials", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const user = repository.createUser("settings-client");
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const adminHeaders = { Cookie: cookie, "Content-Type": "application/json" };

  const rate = await fetch(`${baseUrl}/api/admin/settings/api-rate`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ seconds: 120 }),
  });
  assert.equal(rate.status, 200);
  assert.equal((await rate.json()).apiRateLimitSeconds, 120);
  const apiHeaders = { Authorization: `Bearer ${user.apiKey}` };
  assert.equal(
    (await fetch(`${baseUrl}/api/v1/whitelist`, { headers: apiHeaders }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/v1/whitelist`, { headers: apiHeaders }))
      .status,
    429,
  );

  const credentials = await fetch(
    `${baseUrl}/api/admin/settings/admin-credentials`,
    {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        username: "new-admin",
        currentPassword: "test-password",
        newPassword: "x",
      }),
    },
  );
  assert.equal(credentials.status, 200);
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/overview`, {
        headers: { Cookie: cookie },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "test-password" }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "new-admin",
          password: "x",
        }),
      })
    ).status,
    200,
  );
});

test("admin can obtain a user-specific Surge module and token", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const user = repository.createUser("surge-phone");
  const otherUser = repository.createUser("surge-tablet");
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const linkResponse = await fetch(
    `${baseUrl}/api/admin/users/${user.id}/surge-module`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(linkResponse.status, 200);
  const links = await linkResponse.json();
  const moduleUrl = new URL(links.moduleUrl);
  assert.equal(moduleUrl.origin, "https://allowlist.example.test");
  assert.match(links.installUrl, /^surge:\/\/\/install-module\?url=/);

  const otherLinks = await (
    await fetch(`${baseUrl}/api/admin/users/${otherUser.id}/surge-module`, {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.notEqual(otherLinks.moduleUrl, links.moduleUrl);

  const moduleResponse = await fetch(`${baseUrl}${moduleUrl.pathname}`);
  assert.equal(moduleResponse.status, 200);
  assert.equal(
    moduleResponse.headers.get("x-gatekeeper-server-version"),
    SERVER_VERSION,
  );
  assert.equal(
    moduleResponse.headers.get("x-gatekeeper-surge-module-version"),
    SURGE_MODULE_VERSION,
  );
  const moduleText = await moduleResponse.text();
  assert.match(moduleText, new RegExp(`#!version=${SURGE_MODULE_VERSION}`));
  assert.match(moduleText, new RegExp(`moduleVersion=${SURGE_MODULE_VERSION}`));
  assert.match(moduleText, /moduleUrl=https%3A/);
  assert.doesNotMatch(moduleText, /#!arguments=.*interval/);
  assert.doesNotMatch(moduleText, /device=\{\{\{device\}\}\}/);
  assert.match(moduleText, /cronexp="\*\/10 \* \* \* \*"/);
  assert.match(moduleText, /cooldown=1/);
  assert.match(moduleText, /script-update-interval=300/);
  assert.match(
    moduleText,
    new RegExp(
      `/api/v1/surge/client/${SURGE_SCRIPT_VERSION.replaceAll(".", "\\.")}/gatekeeper\\.js`,
    ),
  );
  assert.match(moduleText, /\[Panel\]/);
  assert.match(moduleText, /点击右上角刷新上报当前 IP/);

  const clientResponse = await fetch(
    `${baseUrl}/api/v1/surge/client/${SURGE_SCRIPT_VERSION}/gatekeeper.js`,
  );
  assert.equal(clientResponse.status, 200);
  assert.equal(clientResponse.headers.get("cache-control"), "no-store");
  assert.equal(
    clientResponse.headers.get("x-gatekeeper-surge-script-version"),
    SURGE_SCRIPT_VERSION,
  );
  assert.match(
    await clientResponse.text(),
    new RegExp(`var SCRIPT_VERSION = "${SURGE_SCRIPT_VERSION}"`),
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/v1/surge/client/0.0.0/gatekeeper.js`)).status,
    404,
  );

  const surgeToken = moduleUrl.pathname.split("/").at(-2);
  const tamperedPath = moduleUrl.pathname.replace(
    surgeToken,
    `${surgeToken.slice(0, -1)}x`,
  );
  assert.equal((await fetch(`${baseUrl}${tamperedPath}`)).status, 404);
  const addResponse = await fetch(`${baseUrl}/api/v1/whitelist`, {
    method: "POST",
    headers: { Authorization: `Bearer ${surgeToken}` },
  });
  assert.equal(addResponse.status, 201);

  const rotated = await (
    await fetch(`${baseUrl}/api/admin/users/${user.id}/rotate-surge-token`, {
      method: "POST",
      headers: { Cookie: cookie },
    })
  ).json();
  const rotatedUrl = new URL(rotated.moduleUrl);
  assert.notEqual(rotated.moduleUrl, links.moduleUrl);
  assert.equal((await fetch(`${baseUrl}${moduleUrl.pathname}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}${rotatedUrl.pathname}`)).status, 200);
  assert.equal(
    (
      await fetch(`${baseUrl}/api/v1/whitelist`, {
        method: "POST",
        headers: { Authorization: `Bearer ${surgeToken}` },
      })
    ).status,
    401,
  );

  repository.setUserEnabled(user.id, false);
  assert.equal((await fetch(`${baseUrl}${moduleUrl.pathname}`)).status, 404);
  assert.equal(
    (
      await fetch(`${baseUrl}/api/v1/whitelist`, {
        method: "POST",
        headers: { Authorization: `Bearer ${surgeToken}` },
      })
    ).status,
    401,
  );
});

test("firewall heartbeat and retention settings appear in admin overview", async (t) => {
  const { baseUrl } = await startTestApp(t);
  const heartbeat = await fetch(`${baseUrl}/api/internal/firewall-status`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-firewall-token-with-24-chars",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      revision: 0,
      success: true,
      ipv4Count: 2,
      ipv6Count: 1,
      tcpPortCount: 1,
      udpPortCount: 0,
    }),
  });
  assert.equal(heartbeat.status, 200);

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const retention = await fetch(`${baseUrl}/api/admin/settings/retention`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ historyDays: 30, auditDays: 90, deviceDays: 14 }),
  });
  assert.equal(retention.status, 200);

  const overview = await (
    await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.equal(overview.firewallStatus.success, true);
  assert.equal(overview.firewallStatus.ipv4_count, 2);
  assert.deepEqual(overview.firewallConfig.status, {
    appliedRevision: 0,
    success: true,
    stale: false,
    updatedAt: overview.firewallConfig.status.updatedAt,
    appliedAt: overview.firewallConfig.status.appliedAt,
    ipv4Count: 2,
    ipv6Count: 1,
    tcpPortCount: 1,
    udpPortCount: 0,
    error: null,
  });
  const configResponse = await fetch(`${baseUrl}/api/admin/firewall-config`, {
    headers: { Cookie: cookie },
  });
  assert.equal(configResponse.status, 200);
  assert.equal((await configResponse.json()).firewallConfig.revision, 0);
  assert.deepEqual(overview.retentionSettings, {
    historyDays: 30,
    auditDays: 90,
    deviceDays: 14,
  });
});

test("admin rejects a cross-origin state-changing request", async (t) => {
  const { baseUrl } = await startTestApp(t);
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.example",
    },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "invalid_request_origin");
});

test("client API is limited to one request per user per minute", async (t) => {
  const { baseUrl, repository } = await startTestApp(t, {
    apiRateLimitWindowMs: 60_000,
  });
  const user = repository.createUser("rate-limited-client");
  const headers = { Authorization: `Bearer ${user.apiKey}` };

  assert.equal(
    (await fetch(`${baseUrl}/api/v1/whitelist`, { method: "POST", headers }))
      .status,
    201,
  );
  const blocked = await fetch(`${baseUrl}/api/v1/whitelist`, { headers });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("ratelimit-limit"), "1");
  assert.match(blocked.headers.get("retry-after"), /^\d+$/);
  assert.equal((await blocked.json()).error, "rate_limit_exceeded");
});

test("API frequency is isolated per device and devices appear in overview", async (t) => {
  const { baseUrl, repository } = await startTestApp(t, {
    apiRateLimitWindowMs: 60_000,
  });
  const user = repository.createUser("multi-device-client");
  const request = (deviceId, deviceName) =>
    fetch(`${baseUrl}/api/v1/whitelist`, {
      headers: {
        Authorization: `Bearer ${user.apiKey}`,
        "X-Gatekeeper-Device-ID": deviceId,
        "X-Gatekeeper-Device-Name": deviceName,
      },
    });

  assert.equal((await request("device_phone", "Phone")).status, 200);
  assert.equal((await request("device_tablet", "Tablet")).status, 200);
  assert.equal((await request("device_phone", "Phone")).status, 429);

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const overview = await (
    await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.deepEqual(overview.devices.map((device) => device.name).sort(), [
    "Phone",
    "Tablet",
  ]);
  const limitResponse = await fetch(`${baseUrl}/api/admin/users/${user.id}`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceLimit: 1 }),
  });
  assert.equal(limitResponse.status, 200);
  assert.equal((await limitResponse.json()).evictedDevices.length, 1);
});

test("a device can report immediately when its trusted source IP changes", async (t) => {
  const { baseUrl, repository } = await startTestApp(t, {
    apiRateLimitWindowMs: 60_000,
    trustProxy: true,
  });
  const user = repository.createUser("roaming-device");
  const request = (ip) =>
    fetch(`${baseUrl}/api/v1/whitelist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${user.apiKey}`,
        "X-Gatekeeper-Device-ID": "roaming_phone",
        "X-Forwarded-For": ip,
      },
    });

  assert.equal((await request("203.0.113.10")).status, 201);
  assert.equal((await request("203.0.113.10")).status, 429);
  assert.equal((await request("198.51.100.20")).status, 201);
  assert.deepEqual(
    repository.listUserIps(user.id).map((item) => item.ip),
    ["203.0.113.0/24", "198.51.100.0/24"],
  );
});

test("admin can add global and user-scoped whitelist networks", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const owner = repository.createUser("network-owner");
  const other = repository.createUser("network-other");
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const headers = { Cookie: cookie, "Content-Type": "application/json" };

  const globalResponse = await fetch(
    `${baseUrl}/api/admin/network-rules/whitelist`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        ip: "203.0.113.8",
        scope: "global",
        label: "shared office",
      }),
    },
  );
  assert.equal(globalResponse.status, 201);
  const globalRule = await globalResponse.json();
  assert.equal(globalRule.network, "203.0.113.0/24");

  const ownedResponse = await fetch(
    `${baseUrl}/api/admin/network-rules/whitelist`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        ip: "198.51.100.19",
        scope: "user",
        userId: owner.id,
      }),
    },
  );
  assert.equal(ownedResponse.status, 201);
  assert.deepEqual(
    repository.listUserIps(owner.id).map((row) => row.ip),
    ["198.51.100.0/24"],
  );
  assert.deepEqual(repository.listUserIps(other.id), []);
  assert.deepEqual(repository.getFirewallSnapshot().ipv4, [
    "198.51.100.0/24",
    "203.0.113.0/24",
  ]);

  const overview = await (
    await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.equal(overview.globalWhitelist[0].label, "shared office");

  const deletion = await fetch(
    `${baseUrl}/api/admin/network-rules/whitelist/global/${globalRule.id}`,
    { method: "DELETE", headers },
  );
  assert.equal(deletion.status, 200);
  assert.deepEqual(repository.getFirewallSnapshot().ipv4, ["198.51.100.0/24"]);
});

test("admin manages blacklist, permanent IPs, and user deletion", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const user = repository.createUser("rules-client");
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const adminHeaders = { Cookie: cookie, "Content-Type": "application/json" };

  const permanent = await fetch(
    `${baseUrl}/api/admin/network-rules/permanent`,
    {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ ip: "198.51.100.9", label: "office" }),
    },
  );
  assert.equal(permanent.status, 201);
  assert.deepEqual(repository.getFirewallSnapshot().ipv4, ["198.51.100.9"]);

  const blocked = await fetch(`${baseUrl}/api/admin/network-rules/blacklist`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ ip: "198.51.100.88", reason: "abuse" }),
  });
  assert.equal(blocked.status, 201);
  assert.equal((await blocked.json()).network, "198.51.100.0/24");
  assert.deepEqual(repository.getFirewallSnapshot().ipv4, []);

  const report = await fetch(`${baseUrl}/api/v1/whitelist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${user.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ip: "198.51.100.77" }),
  });
  assert.equal(report.status, 403);
  assert.equal((await report.json()).error, "network_blacklisted");

  const deletion = await fetch(`${baseUrl}/api/admin/users/${user.id}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  assert.equal(deletion.status, 200);
  assert.equal(repository.findUserById(user.id), undefined);
});

test("reported IPCheck metadata is recorded in user history", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const user = repository.createUser("geo-client");
  const response = await fetch(`${baseUrl}/api/v1/whitelist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${user.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ip: "8.8.8.8",
      ipInfo: {
        source: "ipcheck.ing",
        country: "US",
        city: "Mountain View",
        isp: "Example",
      },
    }),
  });
  assert.equal(response.status, 201);
  const [history] = repository.listUserHistory(user.id);
  assert.equal(history.city, "Mountain View");
  assert.equal(history.geo_source, "ipcheck.ing");
});

test("admin can set user quota, inspect history, and clear active networks", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const user = repository.createUser("quota-client");
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const adminHeaders = { Cookie: cookie, "Content-Type": "application/json" };

  const quota = await fetch(`${baseUrl}/api/admin/users/${user.id}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ ipLimit: 2 }),
  });
  assert.equal(quota.status, 200);

  for (const ip of ["8.8.8.8", "1.1.1.1", "9.9.9.9"]) {
    const response = await fetch(`${baseUrl}/api/v1/whitelist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${user.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ip }),
    });
    assert.equal(response.status, 201);
  }
  assert.equal(repository.listUserIps(user.id).length, 2);

  const history = await (
    await fetch(`${baseUrl}/api/admin/users/${user.id}/history`, {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.equal(history.history.length, 4);
  assert.equal(history.history[0].observed_ip, "9.9.9.9");
  const searchedHistory = await (
    await fetch(`${baseUrl}/api/admin/users/${user.id}/history?q=8.8.8.8`, {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.ok(searchedHistory.history.length >= 1);
  assert.ok(
    searchedHistory.history.every((row) =>
      `${row.observed_ip} ${row.network}`.includes("8.8.8.8"),
    ),
  );

  const cleared = await fetch(`${baseUrl}/api/admin/users/${user.id}/ips`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).removed, 2);
  assert.equal(repository.listUserIps(user.id).length, 0);
  assert.equal(repository.listUserHistory(user.id).length, 6);
});

test("firewall revision long poll wakes immediately after an API change", async (t) => {
  const { baseUrl, repository } = await startTestApp(t);
  const user = repository.createUser("firewall-event-client");
  const revisionRequest = fetch(
    `${baseUrl}/api/internal/firewall-revision?since=0`,
    {
      headers: {
        Authorization: `Bearer ${config.firewallSyncToken}`,
      },
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fetch(`${baseUrl}/api/v1/whitelist`, {
    method: "POST",
    headers: { Authorization: `Bearer ${user.apiKey}` },
  });
  const revision = await revisionRequest;
  assert.equal(revision.status, 200);
  assert.equal((await revision.json()).revision, 1);
});

test("malformed cookies and unknown API routes return JSON errors", async (t) => {
  const { baseUrl } = await startTestApp(t);
  const malformedCookie = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { Cookie: "allowlist_session=%E0%A4%A" },
  });
  assert.equal(malformedCookie.status, 401);
  assert.equal((await malformedCookie.json()).error, "admin_auth_required");

  const missingRoute = await fetch(`${baseUrl}/api/does-not-exist`);
  assert.equal(missingRoute.status, 404);
  assert.equal((await missingRoute.json()).error, "not_found");
});

test("dashboard is mounted only at the configured path", async (t) => {
  const { baseUrl } = await startTestApp(t);
  assert.equal((await fetch(`${baseUrl}/`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/manage-test/`)).status, 200);
});
