import { API_RATE_LIMIT_WINDOW_MS, DEFAULT_IP_LIMIT } from "./constants.js";
import { createApiKey, sha256 } from "./security.js";

const activeIpQuery = `
  SELECT w.id, w.ip, w.family, w.source, w.created_at, w.last_seen_at,
         h.observed_ip, h.country, h.region, h.city, h.isp
  FROM whitelist_ips w
  LEFT JOIN ip_history h ON h.id = (
    SELECT latest.id FROM ip_history latest
    WHERE latest.user_id = w.user_id AND latest.network = w.ip
    ORDER BY latest.id DESC LIMIT 1
  )
`;

export function createRepository(db, { onFirewallChange = () => {} } = {}) {
  const insertAudit = db.prepare(
    "INSERT INTO audit_log (user_id, action, ip, detail) VALUES (?, ?, ?, ?)",
  );
  const bumpFirewallRevision = () => {
    db.prepare(
      `UPDATE settings SET value = CAST(value AS INTEGER) + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE key = 'firewall_revision'`,
    ).run();
    return Number(
      db
        .prepare("SELECT value FROM settings WHERE key = 'firewall_revision'")
        .get().value,
    );
  };
  const notifyFirewallChange = (revision) => {
    if (revision !== null) queueMicrotask(() => onFirewallChange(revision));
  };

  return {
    checkHealth() {
      return db.prepare("SELECT 1 AS ok").get().ok === 1;
    },

    findEnabledUserByApiKey(apiKey) {
      return db
        .prepare(
          "SELECT id, name, enabled, ip_limit FROM users WHERE key_hash = ? AND enabled = 1",
        )
        .get(sha256(apiKey));
    },

    findUserById(userId, enabledOnly = false) {
      return db
        .prepare(
          `SELECT id, name, enabled, ip_limit FROM users WHERE id = ?${enabledOnly ? " AND enabled = 1" : ""}`,
        )
        .get(userId);
    },

    createUser(name) {
      const apiKey = createApiKey();
      const result = db
        .prepare(
          "INSERT INTO users (name, key_hash, key_prefix, ip_limit) VALUES (?, ?, ?, ?)",
        )
        .run(
          name.trim(),
          sha256(apiKey),
          apiKey.slice(0, 10),
          DEFAULT_IP_LIMIT,
        );
      const id = Number(result.lastInsertRowid);
      insertAudit.run(id, "user.created", null, name.trim());
      return { id, apiKey };
    },

    listUserIps(userId) {
      return db
        .prepare(
          `${activeIpQuery}
           WHERE w.user_id = ?
           ORDER BY w.created_at ASC, w.id ASC`,
        )
        .all(userId);
    },

    listUserHistory(userId, limit = 100, offset = 0) {
      return db
        .prepare(
          `SELECT id, observed_ip, network, family, source, status,
                  country, region, city, isp, created_at
           FROM ip_history WHERE user_id = ?
           ORDER BY id DESC LIMIT ? OFFSET ?`,
        )
        .all(userId, limit, offset);
    },

    addIp(userId, observedIp, network, family, source = "api") {
      let revision = null;
      db.exec("BEGIN IMMEDIATE");
      try {
        const user = db
          .prepare("SELECT ip_limit FROM users WHERE id = ? AND enabled = 1")
          .get(userId);
        if (!user) throw new Error("Enabled user not found");

        const existing = db
          .prepare("SELECT id FROM whitelist_ips WHERE user_id = ? AND ip = ?")
          .get(userId, network);
        if (existing) {
          db.prepare(
            `UPDATE whitelist_ips
             SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), source = ?
             WHERE id = ?`,
          ).run(source, existing.id);
          const history = db
            .prepare(
              `INSERT INTO ip_history
               (user_id, observed_ip, network, family, source, status)
               VALUES (?, ?, ?, ?, ?, 'existing')`,
            )
            .run(userId, observedIp, network, family, source);
          insertAudit.run(userId, "ip.seen", network, observedIp);
          db.exec("COMMIT");
          return {
            status: "existing",
            evicted: null,
            historyId: Number(history.lastInsertRowid),
            limit: user.ip_limit,
          };
        }

        const current = db
          .prepare(
            `SELECT id, ip FROM whitelist_ips WHERE user_id = ?
             ORDER BY created_at ASC, id ASC`,
          )
          .all(userId);
        let evicted = null;
        if (current.length >= user.ip_limit) {
          evicted = current[0].ip;
          db.prepare("DELETE FROM whitelist_ips WHERE id = ?").run(
            current[0].id,
          );
          insertAudit.run(
            userId,
            "ip.evicted",
            evicted,
            `replaced by ${network}`,
          );
        }

        db.prepare(
          "INSERT INTO whitelist_ips (user_id, ip, family, source) VALUES (?, ?, ?, ?)",
        ).run(userId, network, family, source);
        const history = db
          .prepare(
            `INSERT INTO ip_history
             (user_id, observed_ip, network, family, source, status)
             VALUES (?, ?, ?, ?, ?, 'added')`,
          )
          .run(userId, observedIp, network, family, source);
        insertAudit.run(
          userId,
          "ip.added",
          network,
          evicted ? `evicted ${evicted}; observed ${observedIp}` : observedIp,
        );
        revision = bumpFirewallRevision();
        db.exec("COMMIT");
        notifyFirewallChange(revision);
        return {
          status: "added",
          evicted,
          historyId: Number(history.lastInsertRowid),
          limit: user.ip_limit,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    updateHistoryLocation(historyId, location) {
      return Boolean(
        db
          .prepare(
            `UPDATE ip_history SET country = ?, region = ?, city = ?, isp = ?
             WHERE id = ?`,
          )
          .run(
            location.country || null,
            location.region || null,
            location.city || null,
            location.isp || null,
            historyId,
          ).changes,
      );
    },

    getCachedIpLocation(ip, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
      return db
        .prepare(
          `SELECT country, region, city, isp FROM ip_locations
           WHERE ip = ? AND updated_at >= ?`,
        )
        .get(ip, Date.now() - maxAgeMs);
    },

    saveIpLocation(ip, location) {
      db.prepare(
        `INSERT INTO ip_locations
         (ip, country, region, city, isp, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET country = excluded.country,
         region = excluded.region, city = excluded.city, isp = excluded.isp,
         updated_at = excluded.updated_at`,
      ).run(
        ip,
        location.country || null,
        location.region || null,
        location.city || null,
        location.isp || null,
        Date.now(),
      );
    },

    consumeApiRequest(
      userId,
      now = Date.now(),
      windowMs = API_RATE_LIMIT_WINDOW_MS,
    ) {
      if (windowMs <= 0) return { allowed: true, retryAfter: 0 };
      const result = db
        .prepare(
          `INSERT INTO api_rate_limits (user_id, last_request_at) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET last_request_at = excluded.last_request_at
           WHERE api_rate_limits.last_request_at <= excluded.last_request_at - ?`,
        )
        .run(userId, now, windowMs);
      if (result.changes) return { allowed: true, retryAfter: 0 };
      const last = db
        .prepare(
          "SELECT last_request_at FROM api_rate_limits WHERE user_id = ?",
        )
        .get(userId).last_request_at;
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((last + windowMs - now) / 1000)),
      };
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
          `SELECT u.id, u.name, u.key_prefix, u.enabled, u.ip_limit, u.created_at,
                  count(w.id) AS ip_count, max(w.last_seen_at) AS last_seen_at
           FROM users u LEFT JOIN whitelist_ips w ON w.user_id = u.id
           GROUP BY u.id ORDER BY u.id DESC`,
        )
        .all();
      const ownedIps = db
        .prepare(
          `${activeIpQuery.replace("SELECT w.id,", "SELECT w.user_id, w.id,")}
           ORDER BY w.created_at DESC, w.id DESC`,
        )
        .all();
      const audit = db
        .prepare(
          `SELECT a.action, a.ip, a.detail, a.created_at, u.name AS user_name
           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
           ORDER BY a.id DESC LIMIT 100`,
        )
        .all();

      return {
        users,
        ips: ownedIps,
        audit,
        settings: this.getFirewallSettings(),
        stats: {
          users: users.length,
          activeUsers: users.filter((user) => user.enabled).length,
          ips: ownedIps.length,
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
      const update = db.prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE
         SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      let revision;
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
        revision = bumpFirewallRevision();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      notifyFirewallChange(revision);
      return this.getFirewallSettings();
    },

    setUserEnabled(userId, enabled) {
      let revision = null;
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db
          .prepare("UPDATE users SET enabled = ? WHERE id = ? AND enabled != ?")
          .run(enabled ? 1 : 0, userId, enabled ? 1 : 0);
        if (result.changes) {
          insertAudit.run(
            userId,
            "user.status",
            null,
            enabled ? "enabled" : "disabled",
          );
          revision = bumpFirewallRevision();
        }
        db.exec("COMMIT");
        notifyFirewallChange(revision);
        return result.changes
          ? true
          : Boolean(db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId));
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    setUserLimit(userId, ipLimit) {
      let revision = null;
      let evicted = [];
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db
          .prepare("UPDATE users SET ip_limit = ? WHERE id = ?")
          .run(ipLimit, userId);
        if (!result.changes) {
          db.exec("ROLLBACK");
          return null;
        }
        const excess = db
          .prepare(
            `SELECT id, ip FROM whitelist_ips WHERE user_id = ?
             ORDER BY created_at ASC, id ASC
             LIMIT MAX(0, (SELECT count(*) FROM whitelist_ips WHERE user_id = ?) - ?)`,
          )
          .all(userId, userId, ipLimit);
        for (const row of excess) {
          db.prepare("DELETE FROM whitelist_ips WHERE id = ?").run(row.id);
          insertAudit.run(userId, "ip.evicted", row.ip, "limit reduced");
        }
        evicted = excess.map((row) => row.ip);
        insertAudit.run(userId, "user.limit", null, String(ipLimit));
        if (evicted.length) revision = bumpFirewallRevision();
        db.exec("COMMIT");
        notifyFirewallChange(revision);
        return { ipLimit, evicted };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    rotateUserKey(userId) {
      const apiKey = createApiKey();
      const result = db
        .prepare("UPDATE users SET key_hash = ?, key_prefix = ? WHERE id = ?")
        .run(sha256(apiKey), apiKey.slice(0, 10), userId);
      if (!result.changes) return null;
      db.prepare("DELETE FROM api_rate_limits WHERE user_id = ?").run(userId);
      insertAudit.run(userId, "key.rotated", null, null);
      return apiKey;
    },

    removeIp(ipId) {
      let revision = null;
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare("SELECT user_id, ip FROM whitelist_ips WHERE id = ?")
          .get(ipId);
        if (!row) {
          db.exec("ROLLBACK");
          return false;
        }
        db.prepare("DELETE FROM whitelist_ips WHERE id = ?").run(ipId);
        insertAudit.run(row.user_id, "ip.removed", row.ip, null);
        revision = bumpFirewallRevision();
        db.exec("COMMIT");
        notifyFirewallChange(revision);
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    clearUserIps(userId) {
      let revision = null;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) {
          db.exec("ROLLBACK");
          return null;
        }
        const result = db
          .prepare("DELETE FROM whitelist_ips WHERE user_id = ?")
          .run(userId);
        insertAudit.run(userId, "ip.cleared", null, String(result.changes));
        if (result.changes) revision = bumpFirewallRevision();
        db.exec("COMMIT");
        notifyFirewallChange(revision);
        return result.changes;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    getFirewallRevision() {
      return Number(
        db
          .prepare("SELECT value FROM settings WHERE key = 'firewall_revision'")
          .get().value,
      );
    },

    getFirewallSnapshot() {
      const rows = db
        .prepare(
          `SELECT DISTINCT w.ip, w.family FROM whitelist_ips w
           JOIN users u ON u.id = w.user_id WHERE u.enabled = 1
           ORDER BY w.family, w.ip`,
        )
        .all();
      const settings = this.getFirewallSettings();
      return {
        generatedAt: new Date().toISOString(),
        revision: this.getFirewallRevision(),
        ipv4: rows.filter((row) => row.family === 4).map((row) => row.ip),
        ipv6: rows.filter((row) => row.family === 6).map((row) => row.ip),
        tcpPorts: settings.tcpPorts,
        udpPorts: settings.udpPorts,
      };
    },
  };
}
