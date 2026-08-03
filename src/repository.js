import { API_RATE_LIMIT_WINDOW_MS, DEFAULT_IP_LIMIT } from "./constants.js";
import { parsePortRanges } from "./ports.js";
import {
  createApiKey,
  hashPassword,
  normalizeNetwork,
  safeEqual,
  sha256,
  verifyPassword,
} from "./security.js";
import { SERVER_VERSION } from "./version.js";

const activeIpQuery = `
  SELECT w.id, w.ip, w.family, w.source, w.created_at, w.last_seen_at,
         h.observed_ip, g.country, g.region, g.city, g.isp, g.geo_source
  FROM whitelist_ips w
  LEFT JOIN ip_history h ON h.id = (
    SELECT latest.id FROM ip_history latest
    WHERE latest.user_id = w.user_id AND latest.network = w.ip
    ORDER BY latest.id DESC LIMIT 1
  )
  LEFT JOIN ip_history g ON g.id = (
    SELECT geo.id FROM ip_history geo
    WHERE geo.user_id = w.user_id AND geo.network = w.ip
      AND (geo.country IS NOT NULL OR geo.region IS NOT NULL
           OR geo.city IS NOT NULL OR geo.isp IS NOT NULL)
    ORDER BY geo.id DESC LIMIT 1
  )
`;

function normalizeStoredPortRanges(value) {
  try {
    return parsePortRanges(value);
  } catch {
    const repaired = String(value || "")
      .split(/[\s,，]+/)
      .filter(Boolean)
      .map((token) => {
        const match = token.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
        if (!match) return null;
        const start = Math.max(1, Number(match[1]));
        const end = Math.min(65535, Number(match[2] || match[1]));
        return start <= end
          ? start === end
            ? String(start)
            : `${start}-${end}`
          : null;
      })
      .filter(Boolean);
    try {
      return parsePortRanges(repaired);
    } catch {
      return [];
    }
  }
}

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
    initializeApplicationSettings(config) {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
      );
      insert.run("admin_username", config.adminUsername);
      insert.run("admin_password_hash", hashPassword(config.adminPassword));
      const configuredWindow = Object.hasOwn(config, "apiRateLimitWindowMs")
        ? Math.max(0, Math.ceil(config.apiRateLimitWindowMs / 1000))
        : config.apiRateLimitSeconds || 60;
      insert.run("api_rate_limit_seconds", String(configuredWindow));
    },

    verifyAdminCredentials(username, password) {
      const rows = db
        .prepare(
          "SELECT key, value FROM settings WHERE key IN ('admin_username', 'admin_password_hash')",
        )
        .all();
      const values = Object.fromEntries(
        rows.map((row) => [row.key, row.value]),
      );
      const usernameMatches = safeEqual(
        values.admin_username,
        String(username || ""),
      );
      const passwordMatches = verifyPassword(
        password,
        values.admin_password_hash,
      );
      return usernameMatches && passwordMatches;
    },

    getAdminUsername() {
      return db
        .prepare("SELECT value FROM settings WHERE key = 'admin_username'")
        .get()?.value;
    },

    updateAdminCredentials({ username, password }) {
      const update = db.prepare(
        `UPDATE settings SET value = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = ?`,
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        update.run(username, "admin_username");
        if (password) update.run(hashPassword(password), "admin_password_hash");
        db.prepare("DELETE FROM sessions").run();
        insertAudit.run(null, "admin.credentials", null, username);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    getApiRateLimitWindowMs() {
      const seconds = Number(
        db
          .prepare(
            "SELECT value FROM settings WHERE key = 'api_rate_limit_seconds'",
          )
          .get()?.value ?? 60,
      );
      return seconds * 1000;
    },

    setApiRateLimitSeconds(seconds) {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ('api_rate_limit_seconds', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at`,
      ).run(String(seconds));
      db.prepare("DELETE FROM api_rate_limits").run();
      db.prepare("DELETE FROM api_device_rate_limits").run();
      insertAudit.run(null, "settings.api_rate", null, `${seconds}s`);
      return seconds;
    },

    checkHealth() {
      return db.prepare("SELECT 1 AS ok").get().ok === 1;
    },

    findEnabledUserByApiKey(apiKey) {
      return db
        .prepare(
          `SELECT id, name, enabled, ip_limit, device_limit, surge_version
           FROM users WHERE key_hash = ? AND enabled = 1`,
        )
        .get(sha256(apiKey));
    },

    findUserById(userId, enabledOnly = false) {
      return db
        .prepare(
          `SELECT id, name, enabled, ip_limit, device_limit, surge_version
           FROM users WHERE id = ?${enabledOnly ? " AND enabled = 1" : ""}`,
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

    listUserHistory(userId, limit = 100, offset = 0, search = "", event = "") {
      const query = String(search || "")
        .trim()
        .slice(0, 80);
      const eventFilter = ["reported", "added", "removed", "evicted"].includes(
        event,
      )
        ? event
        : "";
      const pattern = `%${query}%`;
      return db
        .prepare(
          `SELECT id, observed_ip, network, family, source, status,
                  event, country, region, city, isp, geo_source, created_at
           FROM ip_history WHERE user_id = ? AND (? = '' OR event = ?)
             AND (? = '' OR observed_ip LIKE ? OR network LIKE ?
                  OR source LIKE ? OR status LIKE ? OR event LIKE ?
                  OR country LIKE ? OR region LIKE ? OR city LIKE ? OR isp LIKE ?)
           ORDER BY id DESC LIMIT ? OFFSET ?`,
        )
        .all(
          userId,
          eventFilter,
          eventFilter,
          query,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          limit,
          offset,
        );
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
               (user_id, observed_ip, network, family, source, status, event)
               VALUES (?, ?, ?, ?, ?, 'existing', 'reported')`,
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
            `SELECT id, ip, family FROM whitelist_ips WHERE user_id = ?
             ORDER BY created_at ASC, id ASC`,
          )
          .all(userId);
        let evicted = null;
        if (current.length >= user.ip_limit) {
          evicted = current[0].ip;
          db.prepare(
            `INSERT INTO ip_history
             (user_id, observed_ip, network, family, source, status, event)
             VALUES (?, ?, ?, ?, 'system', 'existing', 'evicted')`,
          ).run(userId, evicted, evicted, current[0].family || family);
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
           (user_id, observed_ip, network, family, source, status, event)
           VALUES (?, ?, ?, ?, ?, 'added', 'added')`,
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
            `UPDATE ip_history SET country = ?, region = ?, city = ?, isp = ?, geo_source = ?
             WHERE id = ?`,
          )
          .run(
            location.country || null,
            location.region || null,
            location.city || null,
            location.isp || null,
            location.source || null,
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

    touchUserDevice(userId, deviceKey, name, ip, source = "api") {
      const existing = db
        .prepare(
          "SELECT id, last_ip FROM user_devices WHERE user_id = ? AND device_key = ?",
        )
        .get(userId, deviceKey);
      if (!existing) {
        const capacity = db
          .prepare(
            `SELECT u.device_limit AS device_limit, count(d.id) AS device_count
             FROM users u LEFT JOIN user_devices d ON d.user_id = u.id
             WHERE u.id = ? GROUP BY u.id`,
          )
          .get(userId);
        if (!capacity || capacity.device_count >= capacity.device_limit) {
          const error = new Error("Device limit exceeded");
          error.code = "DEVICE_LIMIT_EXCEEDED";
          error.limit = capacity?.device_limit || 0;
          throw error;
        }
      }
      db.prepare(
        `INSERT INTO user_devices
         (user_id, device_key, name, source, last_ip)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, device_key) DO UPDATE SET
           name = excluded.name, source = excluded.source,
           last_ip = excluded.last_ip,
           last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).run(userId, deviceKey, name, source, ip || null);
      return {
        created: !existing,
        ipChanged: Boolean(existing && ip && existing.last_ip !== ip),
        previousIp: existing?.last_ip || null,
      };
    },

    listUserDevices(userId) {
      return db
        .prepare(
          `SELECT id, device_key, name, source, last_ip,
                  first_seen_at, last_seen_at
           FROM user_devices WHERE user_id = ?
           ORDER BY last_seen_at DESC, id DESC`,
        )
        .all(userId);
    },

    removeUserDevice(userId, deviceId) {
      const device = db
        .prepare(
          "SELECT device_key FROM user_devices WHERE id = ? AND user_id = ?",
        )
        .get(deviceId, userId);
      if (!device) return false;
      db.prepare(
        "DELETE FROM api_device_rate_limits WHERE user_id = ? AND device_key = ?",
      ).run(userId, device.device_key);
      db.prepare("DELETE FROM user_devices WHERE id = ?").run(deviceId);
      insertAudit.run(userId, "device.removed", null, device.device_key);
      return true;
    },

    consumeApiRequest(
      userId,
      now = Date.now(),
      windowMs = API_RATE_LIMIT_WINDOW_MS,
      deviceKey = "legacy",
      { allowImmediate = false } = {},
    ) {
      if (windowMs <= 0) return { allowed: true, retryAfter: 0 };
      if (allowImmediate) {
        db.prepare(
          `INSERT INTO api_device_rate_limits
           (user_id, device_key, last_request_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id, device_key) DO UPDATE
           SET last_request_at = excluded.last_request_at`,
        ).run(userId, deviceKey, now);
        return { allowed: true, retryAfter: 0 };
      }
      const result = db
        .prepare(
          `INSERT INTO api_device_rate_limits
           (user_id, device_key, last_request_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id, device_key) DO UPDATE
           SET last_request_at = excluded.last_request_at
           WHERE api_device_rate_limits.last_request_at <= excluded.last_request_at - ?`,
        )
        .run(userId, deviceKey, now, windowMs);
      if (result.changes) return { allowed: true, retryAfter: 0 };
      const last = db
        .prepare(
          `SELECT last_request_at FROM api_device_rate_limits
           WHERE user_id = ? AND device_key = ?`,
        )
        .get(userId, deviceKey).last_request_at;
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
          `SELECT u.id, u.name, u.key_prefix, u.enabled, u.ip_limit,
                  u.device_limit, u.surge_version, u.created_at,
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
      const devices = db
        .prepare(
          `SELECT d.id, d.user_id, d.device_key, d.name, d.source, d.last_ip,
                  d.first_seen_at, d.last_seen_at
           FROM user_devices d ORDER BY d.last_seen_at DESC, d.id DESC`,
        )
        .all();

      return {
        users,
        ips: ownedIps,
        audit,
        blockedNetworks: this.listBlockedNetworks(),
        permanentWhitelist: this.listPermanentWhitelist(),
        globalWhitelist: this.listGlobalWhitelist(),
        devices,
        firewallStatus: this.getFirewallStatus(),
        firewallRevision: this.getFirewallRevision(),
        firewallConfig: this.getFirewallConfig(),
        settings: this.getFirewallSettings(),
        retentionSettings: this.getRetentionSettings(),
        applicationSettings: {
          serverVersion: SERVER_VERSION,
          apiRateLimitSeconds: this.getApiRateLimitWindowMs() / 1000,
          adminUsername: this.getAdminUsername(),
        },
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
        tcpPorts: normalizeStoredPortRanges(values.protected_tcp_ports),
        udpPorts: normalizeStoredPortRanges(values.protected_udp_ports),
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
          const network = db
            .prepare("SELECT family FROM whitelist_ips WHERE id = ?")
            .get(row.id);
          db.prepare(
            `INSERT INTO ip_history
             (user_id, observed_ip, network, family, source, status, event)
             VALUES (?, ?, ?, ?, 'system', 'existing', 'evicted')`,
          ).run(userId, row.ip, row.ip, network?.family || 4);
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

    setUserDeviceLimit(userId, deviceLimit) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db
          .prepare("UPDATE users SET device_limit = ? WHERE id = ?")
          .run(deviceLimit, userId);
        if (!result.changes) {
          db.exec("ROLLBACK");
          return null;
        }
        const excess = db
          .prepare(
            `SELECT id, device_key FROM user_devices WHERE user_id = ?
             ORDER BY last_seen_at ASC, id ASC
             LIMIT MAX(0, (SELECT count(*) FROM user_devices WHERE user_id = ?) - ?)`,
          )
          .all(userId, userId, deviceLimit);
        for (const device of excess) {
          db.prepare(
            "DELETE FROM api_device_rate_limits WHERE user_id = ? AND device_key = ?",
          ).run(userId, device.device_key);
          db.prepare("DELETE FROM user_devices WHERE id = ?").run(device.id);
          insertAudit.run(userId, "device.evicted", null, device.device_key);
        }
        insertAudit.run(userId, "user.device_limit", null, String(deviceLimit));
        db.exec("COMMIT");
        return {
          deviceLimit,
          evicted: excess.map((device) => device.device_key),
        };
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
      db.prepare("DELETE FROM api_device_rate_limits WHERE user_id = ?").run(
        userId,
      );
      insertAudit.run(userId, "key.rotated", null, null);
      return apiKey;
    },

    rotateSurgeToken(userId) {
      const result = db
        .prepare(
          "UPDATE users SET surge_version = surge_version + 1 WHERE id = ?",
        )
        .run(userId);
      if (!result.changes) return null;
      const version = db
        .prepare("SELECT surge_version FROM users WHERE id = ?")
        .get(userId).surge_version;
      insertAudit.run(userId, "surge.rotated", null, String(version));
      return version;
    },

    getFirewallStatus() {
      const status = db
        .prepare("SELECT * FROM firewall_status WHERE id = 1")
        .get();
      const updatedAt = Date.parse(status?.updated_at || "");
      return {
        ...status,
        success: Boolean(status?.success),
        stale: !Number.isFinite(updatedAt) || Date.now() - updatedAt > 150_000,
      };
    },

    getFirewallConfig() {
      const snapshot = this.getFirewallSnapshot();
      const status = this.getFirewallStatus();
      return {
        revision: snapshot.revision,
        generatedAt: snapshot.generatedAt,
        tcpPorts: snapshot.tcpPorts,
        udpPorts: snapshot.udpPorts,
        ipv4: snapshot.ipv4,
        ipv6: snapshot.ipv6,
        status: {
          appliedRevision: status.applied_revision ?? 0,
          success: status.success,
          stale: status.stale,
          updatedAt: status.updated_at || null,
          appliedAt: status.applied_at || null,
          ipv4Count: status.ipv4_count ?? 0,
          ipv6Count: status.ipv6_count ?? 0,
          tcpPortCount: status.tcp_port_count ?? 0,
          udpPortCount: status.udp_port_count ?? 0,
          error: status.error || null,
        },
      };
    },

    reportFirewallStatus({
      revision,
      success,
      ipv4Count = 0,
      ipv6Count = 0,
      tcpPortCount = 0,
      udpPortCount = 0,
      error = null,
    }) {
      db.prepare(
        `UPDATE firewall_status SET applied_revision = ?, success = ?,
         ipv4_count = ?, ipv6_count = ?, tcp_port_count = ?, udp_port_count = ?,
         error = ?, applied_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE applied_at END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`,
      ).run(
        revision,
        success ? 1 : 0,
        ipv4Count,
        ipv6Count,
        tcpPortCount,
        udpPortCount,
        error ? String(error).slice(0, 500) : null,
        success ? 1 : 0,
      );
      return this.getFirewallStatus();
    },

    getRetentionSettings() {
      const rows = db
        .prepare(
          `SELECT key, value FROM settings WHERE key IN
           ('history_retention_days','audit_retention_days','device_retention_days')`,
        )
        .all();
      const values = Object.fromEntries(
        rows.map((row) => [row.key, Number(row.value)]),
      );
      return {
        historyDays: values.history_retention_days || 7,
        auditDays: values.audit_retention_days || 365,
        deviceDays: values.device_retention_days || 90,
      };
    },

    setRetentionSettings({ historyDays, auditDays, deviceDays }) {
      const update = db.prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at`,
      );
      update.run("history_retention_days", String(historyDays));
      update.run("audit_retention_days", String(auditDays));
      update.run("device_retention_days", String(deviceDays));
      insertAudit.run(
        null,
        "settings.retention",
        null,
        `${historyDays}/${auditDays}/${deviceDays}`,
      );
      return this.getRetentionSettings();
    },

    cleanupRetainedData() {
      const settings = this.getRetentionSettings();
      const cutoff = (days) =>
        new Date(Date.now() - days * 86_400_000).toISOString();
      const oldDevices = db
        .prepare(
          "SELECT user_id, device_key FROM user_devices WHERE last_seen_at < ?",
        )
        .all(cutoff(settings.deviceDays));
      for (const device of oldDevices) {
        db.prepare(
          "DELETE FROM api_device_rate_limits WHERE user_id = ? AND device_key = ?",
        ).run(device.user_id, device.device_key);
      }
      const devices = db
        .prepare("DELETE FROM user_devices WHERE last_seen_at < ?")
        .run(cutoff(settings.deviceDays)).changes;
      const history = db
        .prepare("DELETE FROM ip_history WHERE created_at < ?")
        .run(cutoff(settings.historyDays)).changes;
      const audit = db
        .prepare("DELETE FROM audit_log WHERE created_at < ?")
        .run(cutoff(settings.auditDays)).changes;
      db.exec("PRAGMA optimize");
      return { history, audit, devices };
    },

    removeIp(ipId) {
      let revision = null;
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare("SELECT user_id, ip, family FROM whitelist_ips WHERE id = ?")
          .get(ipId);
        if (!row) {
          db.exec("ROLLBACK");
          return false;
        }
        db.prepare(
          `INSERT INTO ip_history
           (user_id, observed_ip, network, family, source, status, event)
           VALUES (?, ?, ?, ?, 'admin', 'existing', 'removed')`,
        ).run(row.user_id, row.ip, row.ip, row.family);
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
        const active = db
          .prepare("SELECT ip, family FROM whitelist_ips WHERE user_id = ?")
          .all(userId);
        for (const row of active) {
          db.prepare(
            `INSERT INTO ip_history
             (user_id, observed_ip, network, family, source, status, event)
             VALUES (?, ?, ?, ?, 'admin', 'existing', 'removed')`,
          ).run(userId, row.ip, row.ip, row.family);
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

    deleteUser(userId) {
      let revision = null;
      db.exec("BEGIN IMMEDIATE");
      try {
        const user = db
          .prepare("SELECT name FROM users WHERE id = ?")
          .get(userId);
        if (!user) {
          db.exec("ROLLBACK");
          return false;
        }
        const count = db
          .prepare(
            "SELECT count(*) AS count FROM whitelist_ips WHERE user_id = ?",
          )
          .get(userId).count;
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
        insertAudit.run(
          null,
          "user.deleted",
          null,
          `${user.name}; removed=${count}`,
        );
        revision = bumpFirewallRevision();
        db.exec("COMMIT");
        notifyFirewallChange(revision);
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    listBlockedNetworks() {
      return db
        .prepare(
          "SELECT id, network, family, reason, created_at FROM blocked_networks ORDER BY id DESC",
        )
        .all();
    },

    isNetworkBlocked(network) {
      return Boolean(
        db
          .prepare("SELECT 1 FROM blocked_networks WHERE network = ?")
          .get(network),
      );
    },

    addBlockedNetwork(network, family, reason = "") {
      let revision;
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db
          .prepare(
            "INSERT INTO blocked_networks (network, family, reason) VALUES (?, ?, ?)",
          )
          .run(network, family, reason || null);
        const removedUsers = db
          .prepare("DELETE FROM whitelist_ips WHERE ip = ?")
          .run(network).changes;
        const removedGlobal = db
          .prepare("DELETE FROM global_whitelist_networks WHERE network = ?")
          .run(network).changes;
        const permanent = db
          .prepare("SELECT id, ip FROM permanent_whitelist")
          .all();
        let removedPermanent = 0;
        for (const row of permanent) {
          if (normalizeNetwork(row.ip)?.network === network) {
            removedPermanent += db
              .prepare("DELETE FROM permanent_whitelist WHERE id = ?")
              .run(row.id).changes;
          }
        }
        insertAudit.run(
          null,
          "network.blocked",
          network,
          `${reason || ""}; removed=${removedUsers + removedPermanent + removedGlobal}`,
        );
        revision = bumpFirewallRevision();
        db.exec("COMMIT");
        notifyFirewallChange(revision);
        return {
          id: Number(result.lastInsertRowid),
          removed: removedUsers + removedPermanent + removedGlobal,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    removeBlockedNetwork(id) {
      const row = db
        .prepare("SELECT network FROM blocked_networks WHERE id = ?")
        .get(id);
      if (!row) return false;
      db.prepare("DELETE FROM blocked_networks WHERE id = ?").run(id);
      insertAudit.run(null, "network.unblocked", row.network, null);
      notifyFirewallChange(bumpFirewallRevision());
      return true;
    },

    listPermanentWhitelist() {
      return db
        .prepare(
          "SELECT id, ip, family, label, created_at FROM permanent_whitelist ORDER BY id DESC",
        )
        .all();
    },

    addPermanentIp(ip, family, label = "") {
      const result = db
        .prepare(
          "INSERT INTO permanent_whitelist (ip, family, label) VALUES (?, ?, ?)",
        )
        .run(ip, family, label || null);
      insertAudit.run(null, "permanent.added", ip, label || null);
      notifyFirewallChange(bumpFirewallRevision());
      return Number(result.lastInsertRowid);
    },

    removePermanentIp(id) {
      const row = db
        .prepare("SELECT ip FROM permanent_whitelist WHERE id = ?")
        .get(id);
      if (!row) return false;
      db.prepare("DELETE FROM permanent_whitelist WHERE id = ?").run(id);
      insertAudit.run(null, "permanent.removed", row.ip, null);
      notifyFirewallChange(bumpFirewallRevision());
      return true;
    },

    listGlobalWhitelist() {
      return db
        .prepare(
          `SELECT id, network, family, label, created_at
           FROM global_whitelist_networks ORDER BY id DESC`,
        )
        .all();
    },

    addGlobalNetwork(network, family, label = "") {
      const result = db
        .prepare(
          `INSERT INTO global_whitelist_networks (network, family, label)
           VALUES (?, ?, ?)`,
        )
        .run(network, family, label || null);
      insertAudit.run(null, "global_network.added", network, label || null);
      notifyFirewallChange(bumpFirewallRevision());
      return Number(result.lastInsertRowid);
    },

    removeGlobalNetwork(id) {
      const row = db
        .prepare("SELECT network FROM global_whitelist_networks WHERE id = ?")
        .get(id);
      if (!row) return false;
      db.prepare("DELETE FROM global_whitelist_networks WHERE id = ?").run(id);
      insertAudit.run(null, "global_network.removed", row.network, null);
      notifyFirewallChange(bumpFirewallRevision());
      return true;
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
           AND NOT EXISTS (SELECT 1 FROM blocked_networks b WHERE b.network = w.ip)
           ORDER BY w.family, w.ip`,
        )
        .all();
      const permanent = this.listPermanentWhitelist().filter(
        (row) => !this.isNetworkBlocked(normalizeNetwork(row.ip)?.network),
      );
      const global = this.listGlobalWhitelist()
        .filter((row) => !this.isNetworkBlocked(row.network))
        .map((row) => ({ ...row, ip: row.network }));
      const allRows = [...rows, ...permanent, ...global];
      const settings = this.getFirewallSettings();
      return {
        generatedAt: new Date().toISOString(),
        revision: this.getFirewallRevision(),
        ipv4: [
          ...new Set(
            allRows.filter((row) => row.family === 4).map((row) => row.ip),
          ),
        ],
        ipv6: [
          ...new Set(
            allRows.filter((row) => row.family === 6).map((row) => row.ip),
          ),
        ],
        tcpPorts: settings.tcpPorts,
        udpPorts: settings.udpPorts,
      };
    },
  };
}
