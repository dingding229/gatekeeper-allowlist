import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("production config rejects the default password", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /ADMIN_PASSWORD must be changed/,
  );
});

test("config validates port and firewall token", () => {
  assert.throws(() => loadConfig({ PORT: "nope" }), /PORT must be an integer/);
  assert.throws(
    () => loadConfig({ FIREWALL_SYNC_TOKEN: "short" }),
    /FIREWALL_SYNC_TOKEN must contain at least 24 characters/,
  );
});

test("config validates and normalizes the admin path", () => {
  assert.equal(
    loadConfig({ ADMIN_PATH: "secret-panel" }).adminPath,
    "/secret-panel",
  );
  assert.throws(() => loadConfig({ ADMIN_PATH: "/api" }), /reserved/);
  assert.throws(() => loadConfig({ ADMIN_PATH: "x" }), /ADMIN_PATH/);
});

test("config derives and validates the public base URL", () => {
  assert.equal(
    loadConfig({ DOMAIN: "allowlist.example.com" }).publicBaseUrl,
    "https://allowlist.example.com",
  );
  assert.equal(
    loadConfig({ PUBLIC_BASE_URL: "https://allowlist.example.com/" })
      .publicBaseUrl,
    "https://allowlist.example.com",
  );
  assert.throws(
    () => loadConfig({ PUBLIC_BASE_URL: "https://example.com/path" }),
    /without a path/,
  );
});

test("IP information endpoints require HTTPS and bounded timeouts", () => {
  assert.throws(
    () => loadConfig({ SERVER_IPV4_LOOKUP_URL: "http://example.com/geo" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => loadConfig({ IP_LOOKUP_TIMEOUT_MS: "100" }),
    /between 500 and 15000/,
  );
  assert.equal(
    loadConfig({}).serverIpLookupUrls[0],
    "https://4.ipcheck.ing/geo",
  );
});
