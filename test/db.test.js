import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";

test("legacy databases gain user quotas and history without data loss", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gatekeeper-db-migration-"));
  const filename = join(directory, "legacy.db");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users (name, key_hash, key_prefix)
    VALUES ('legacy-user', 'hash', 'awl_old');
    CREATE TABLE whitelist_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip TEXT NOT NULL,
      family INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'api',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(user_id, ip)
    );
    INSERT INTO whitelist_ips (user_id, ip, family, source)
    VALUES (1, '8.8.8.8', 4, 'legacy');
  `);
  legacy.close();

  const migrated = openDatabase(filename);
  const user = migrated
    .prepare("SELECT name, ip_limit FROM users WHERE name = 'legacy-user'")
    .get();
  assert.equal(user.ip_limit, 3);
  assert.equal(
    migrated
      .prepare("SELECT device_limit FROM users WHERE name = 'legacy-user'")
      .get().device_limit,
    20,
  );
  assert.equal(
    migrated
      .prepare("SELECT surge_version FROM users WHERE name = 'legacy-user'")
      .get().surge_version,
    1,
  );
  assert.equal(
    migrated.prepare("SELECT ip FROM whitelist_ips WHERE user_id = 1").get().ip,
    "8.8.8.0/24",
  );
  assert.doesNotThrow(() =>
    migrated.prepare("SELECT count(*) FROM ip_history").get(),
  );
  assert.doesNotThrow(() =>
    migrated.prepare("SELECT count(*) FROM user_devices").get(),
  );
  assert.doesNotThrow(() =>
    migrated.prepare("SELECT count(*) FROM api_device_rate_limits").get(),
  );
  assert.doesNotThrow(() =>
    migrated.prepare("SELECT count(*) FROM global_whitelist_networks").get(),
  );
  assert.doesNotThrow(() =>
    migrated.prepare("SELECT count(*) FROM firewall_status").get(),
  );
  assert.equal(
    migrated
      .prepare("SELECT value FROM settings WHERE key = 'firewall_revision'")
      .get().value,
    "0",
  );
  migrated.close();
});
