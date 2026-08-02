import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeNetwork } from "./security.js";

const schema = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS whitelist_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip TEXT NOT NULL,
    family INTEGER NOT NULL CHECK (family IN (4, 6)),
    source TEXT NOT NULL DEFAULT 'api',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(user_id, ip)
  );

  CREATE INDEX IF NOT EXISTS idx_ips_user_created
    ON whitelist_ips(user_id, created_at, id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    ip TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('protected_tcp_ports', '["22"]'),
    ('protected_udp_ports', '[]');
`;

function migrateNetworks(db) {
  const rows = db
    .prepare(
      `SELECT id, user_id, ip, family, source, created_at, last_seen_at
       FROM whitelist_ips ORDER BY user_id, created_at, id`,
    )
    .all();
  const groups = new Map();
  for (const row of rows) {
    const normalized = normalizeNetwork(row.ip);
    if (!normalized) continue;
    const key = `${row.user_id}:${normalized.network}`;
    const group = groups.get(key) || {
      network: normalized.network,
      family: normalized.family,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const group of groups.values()) {
      const [keeper, ...duplicates] = group.rows;
      for (const duplicate of duplicates) {
        db.prepare("DELETE FROM whitelist_ips WHERE id = ?").run(duplicate.id);
      }
      const latest = group.rows.reduce((best, row) =>
        row.last_seen_at > best.last_seen_at ? row : best,
      );
      db.prepare(
        `UPDATE whitelist_ips
         SET ip = ?, family = ?, source = ?, last_seen_at = ? WHERE id = ?`,
      ).run(
        group.network,
        group.family,
        latest.source,
        latest.last_seen_at,
        keeper.id,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(filename) {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true });

  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(schema);
  migrateNetworks(db);
  return db;
}
