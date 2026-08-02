import { IP_LIMIT } from "./constants.js";
import { createApiKey, sha256 } from "./security.js";

export function createRepository(db) {
  const insertAudit = db.prepare(
    "INSERT INTO audit_log (user_id, action, ip, detail) VALUES (?, ?, ?, ?)",
  );

  return {
    checkHealth() {
      return db.prepare("SELECT 1 AS ok").get().ok === 1;
    },

    findEnabledUserByApiKey(apiKey) {
      return db
        .prepare(
          "SELECT id, name, enabled FROM users WHERE key_hash = ? AND enabled = 1",
        )
        .get(sha256(apiKey));
    },

    findUserById(userId, enabledOnly = false) {
      return db
        .prepare(
          `SELECT id, name, enabled FROM users WHERE id = ?${enabledOnly ? " AND enabled = 1" : ""}`,
        )
        .get(userId);
    },

    createUser(name) {
      const apiKey = createApiKey();
      const result = db
        .prepare(
          "INSERT INTO users (name, key_hash, key_prefix) VALUES (?, ?, ?)",
        )
        .run(name.trim(), sha256(apiKey), apiKey.slice(0, 10));
      const id = Number(result.lastInsertRowid);
      insertAudit.run(id, "user.created", null, name.trim());
      return { id, apiKey };
    },

    listUserIps(userId) {
      return db
        .prepare(
          `
        SELECT ip, family, source, created_at, last_seen_at
        FROM whitelist_ips
        WHERE user_id = ?
        ORDER BY created_at ASC, id ASC
      `,
        )
        .all(userId);
    },

    addIp(userId, ip, family, source = "api") {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare("SELECT id FROM whitelist_ips WHERE user_id = ? AND ip = ?")
          .get(userId, ip);

        if (existing) {
          db.prepare(
            `
            UPDATE whitelist_ips
            SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), source = ?
            WHERE id = ?
          `,
          ).run(source, existing.id);
          insertAudit.run(userId, "ip.seen", ip, "existing");
          db.exec("COMMIT");
          return { status: "existing", evicted: null };
        }

        const current = db
          .prepare(
            `
          SELECT id, ip FROM whitelist_ips
          WHERE user_id = ?
          ORDER BY created_at ASC, id ASC
        `,
          )
          .all(userId);
        let evicted = null;

        if (current.length >= IP_LIMIT) {
          evicted = current[0].ip;
          db.prepare("DELETE FROM whitelist_ips WHERE id = ?").run(
            current[0].id,
          );
          insertAudit.run(userId, "ip.evicted", evicted, `replaced by ${ip}`);
        }

        db.prepare(
          "INSERT INTO whitelist_ips (user_id, ip, family, source) VALUES (?, ?, ?, ?)",
        ).run(userId, ip, family, source);
        insertAudit.run(
          userId,
          "ip.added",
          ip,
          evicted ? `evicted ${evicted}` : null,
        );
        db.exec("COMMIT");
        return { status: "added", evicted };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    createSession(tokenHash, expiresAt) {
      db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
      db.prepare(
        "INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)",
      ).run(tokenHash, expiresAt);
    },

    sessionIsValid(tokenHash) {
      const session = db
        .prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
        .get(tokenHash);
      return Boolean(session && session.expires_at >= Date.now());
    },

    deleteSession(tokenHash) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    },

    getOverview() {
      const users = db
        .prepare(
          `
        SELECT u.id, u.name, u.key_prefix, u.enabled, u.created_at,
               count(w.id) AS ip_count, max(w.last_seen_at) AS last_seen_at
        FROM users u
        LEFT JOIN whitelist_ips w ON w.user_id = u.id
        GROUP BY u.id
        ORDER BY u.id DESC
      `,
        )
        .all();
      const ips = db
        .prepare(
          `
        SELECT w.id, w.ip, w.family, w.source, w.created_at, w.last_seen_at,
               u.id AS user_id, u.name AS user_name
        FROM whitelist_ips w
        JOIN users u ON u.id = w.user_id
        ORDER BY w.created_at DESC, w.id DESC
      `,
        )
        .all();
      const audit = db
        .prepare(
          `
        SELECT a.action, a.ip, a.detail, a.created_at, u.name AS user_name
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC
        LIMIT 50
      `,
        )
        .all();

      return {
        users,
        ips,
        audit,
        settings: this.getFirewallSettings(),
        stats: {
          users: users.length,
          activeUsers: users.filter((user) => user.enabled).length,
          ips: ips.length,
        },
      };
    },

    getFirewallSettings() {
      const rows = db
        .prepare(
          "SELECT key, value FROM settings WHERE key IN ('protected_tcp_ports', 'protected_udp_ports')",
        )
        .all();
      const values = Object.fromEntries(
        rows.map((row) => [row.key, JSON.parse(row.value)]),
      );
      return {
        tcpPorts: values.protected_tcp_ports || [],
        udpPorts: values.protected_udp_ports || [],
      };
    },

    setFirewallSettings({ tcpPorts, udpPorts }) {
      const update = db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(key) DO UPDATE
        SET value = excluded.value, updated_at = excluded.updated_at
      `);
      db.exec("BEGIN IMMEDIATE");
      try {
        update.run("protected_tcp_ports", JSON.stringify(tcpPorts));
        update.run("protected_udp_ports", JSON.stringify(udpPorts));
        insertAudit.run(
          null,
          "settings.updated",
          null,
          `tcp=${tcpPorts.join(",")}; udp=${udpPorts.join(",")}`,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return this.getFirewallSettings();
    },

    setUserEnabled(userId, enabled) {
      const result = db
        .prepare("UPDATE users SET enabled = ? WHERE id = ?")
        .run(enabled ? 1 : 0, userId);
      if (result.changes) {
        insertAudit.run(
          userId,
          "user.status",
          null,
          enabled ? "enabled" : "disabled",
        );
      }
      return Boolean(result.changes);
    },

    rotateUserKey(userId) {
      const apiKey = createApiKey();
      const result = db
        .prepare("UPDATE users SET key_hash = ?, key_prefix = ? WHERE id = ?")
        .run(sha256(apiKey), apiKey.slice(0, 10), userId);
      if (!result.changes) return null;
      insertAudit.run(userId, "key.rotated", null, null);
      return apiKey;
    },

    removeIp(ipId) {
      const row = db
        .prepare("SELECT user_id, ip FROM whitelist_ips WHERE id = ?")
        .get(ipId);
      if (!row) return false;
      db.prepare("DELETE FROM whitelist_ips WHERE id = ?").run(ipId);
      insertAudit.run(row.user_id, "ip.removed", row.ip, null);
      return true;
    },

    getFirewallSnapshot() {
      const rows = db
        .prepare(
          `
        SELECT DISTINCT w.ip, w.family
        FROM whitelist_ips w
        JOIN users u ON u.id = w.user_id
        WHERE u.enabled = 1
        ORDER BY w.family, w.ip
      `,
        )
        .all();
      const settings = this.getFirewallSettings();
      return {
        generatedAt: new Date().toISOString(),
        ipv4: rows.filter((row) => row.family === 4).map((row) => row.ip),
        ipv6: rows.filter((row) => row.family === 6).map((row) => row.ip),
        tcpPorts: settings.tcpPorts,
        udpPorts: settings.udpPorts,
      };
    },
  };
}
