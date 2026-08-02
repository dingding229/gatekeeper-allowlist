import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createRepository } from "../src/repository.js";

const config = {
  adminUsername: "admin",
  adminPassword: "test-password",
  firewallSyncToken: "test-firewall-token-with-24-chars",
  trustProxy: false,
  cookieSecure: false,
  adminPath: "/manage-test",
  publicBaseUrl: "https://allowlist.example.test",
};

async function startTestApp(t) {
  const db = openDatabase(":memory:");
  const repository = createRepository(db);
  const server = createApp({ db, config }).listen(0, "127.0.0.1");
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
  assert.equal(body.limit, 3);
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
  const moduleText = await moduleResponse.text();
  assert.match(moduleText, /cronexp="\*\/3 \* \* \* \*"/);
  assert.match(moduleText, /\[Panel\]/);
  assert.match(moduleText, /点击右上角刷新按钮手动加白/);

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
