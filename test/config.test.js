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
