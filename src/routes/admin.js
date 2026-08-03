import { Router } from "express";
import {
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_WINDOW_MS,
  MAX_IP_LIMIT,
  MIN_IP_LIMIT,
  MAX_DEVICE_LIMIT,
  MIN_DEVICE_LIMIT,
  SESSION_TTL_MS,
} from "../constants.js";
import {
  createSessionToken,
  createSurgeToken,
  normalizeIp,
  normalizeNetwork,
  sha256,
} from "../security.js";
import { parsePortRanges } from "../ports.js";

const SESSION_COOKIE = "allowlist_session";

const validId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export function createAdminRouter({ repository, adminAuth, config, ipInfo }) {
  const router = Router();
  const loginAttempts = new Map();
  const surgeModuleLinks = (user) => {
    const token = createSurgeToken(
      user.id,
      config.firewallSyncToken,
      user.surge_version,
    );
    const moduleUrl = `${config.publicBaseUrl}/api/v1/surge/${encodeURIComponent(token)}/module.sgmodule`;
    return {
      ok: true,
      user: user.name,
      moduleUrl,
      installUrl: `surge:///install-module?url=${encodeURIComponent(moduleUrl)}`,
    };
  };

  router.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (!origin || !config.publicBaseUrl) return next();
    try {
      if (new URL(origin).origin !== new URL(config.publicBaseUrl).origin) {
        return res.status(403).json({ error: "invalid_request_origin" });
      }
    } catch {
      return res.status(403).json({ error: "invalid_request_origin" });
    }
    return next();
  });

  router.post("/login", (req, res) => {
    const now = Date.now();
    if (loginAttempts.size > 1_000) {
      for (const [address, attempts] of loginAttempts) {
        if (!attempts.some((time) => time > now - LOGIN_WINDOW_MS)) {
          loginAttempts.delete(address);
        }
      }
    }
    const recent = (loginAttempts.get(req.ip) || []).filter(
      (time) => time > now - LOGIN_WINDOW_MS,
    );

    if (recent.length >= LOGIN_ATTEMPT_LIMIT) {
      return res.status(429).json({ error: "too_many_attempts" });
    }

    const authenticated = repository.verifyAdminCredentials(
      req.body?.username,
      req.body?.password,
    );
    if (!authenticated) {
      loginAttempts.set(req.ip, [...recent, now]);
      return res.status(401).json({ error: "invalid_credentials" });
    }

    loginAttempts.delete(req.ip);
    const token = createSessionToken();
    repository.createSession(sha256(token), now + SESSION_TTL_MS);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.cookieSecure,
      maxAge: SESSION_TTL_MS,
      path: "/",
    });
    return res.json({ ok: true });
  });

  router.post("/logout", adminAuth, (req, res) => {
    repository.deleteSession(sha256(req.sessionToken));
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.cookieSecure,
      path: "/",
    });
    res.json({ ok: true });
  });

  router.get("/overview", adminAuth, async (_req, res) => {
    const overview = repository.getOverview();
    overview.server = await ipInfo.getServerInfo();
    res.json(overview);
  });

  router.get("/firewall-config", adminAuth, (_req, res) => {
    return res.json({
      ok: true,
      firewallConfig: repository.getFirewallConfig(),
    });
  });

  router.patch("/settings/firewall", adminAuth, (req, res) => {
    try {
      const tcpPorts = parsePortRanges(req.body?.tcpPorts);
      const udpPorts = parsePortRanges(req.body?.udpPorts);
      return res.json({
        ok: true,
        settings: repository.setFirewallSettings({ tcpPorts, udpPorts }),
      });
    } catch (error) {
      return res.status(400).json({
        error: "invalid_port_ranges",
        message: error.message,
      });
    }
  });

  router.patch("/settings/api-rate", adminAuth, (req, res) => {
    const seconds = Number(req.body?.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 65_535) {
      return res.status(400).json({
        error: "invalid_api_rate_limit",
        message: "seconds must be an integer between 1 and 65535",
      });
    }
    return res.json({
      ok: true,
      apiRateLimitSeconds: repository.setApiRateLimitSeconds(seconds),
    });
  });

  router.patch("/settings/retention", adminAuth, (req, res) => {
    const values = {
      historyDays: Number(req.body?.historyDays),
      auditDays: Number(req.body?.auditDays),
      deviceDays: Number(req.body?.deviceDays),
    };
    if (
      Object.values(values).some(
        (value) => !Number.isInteger(value) || value < 7 || value > 3650,
      )
    ) {
      return res.status(400).json({ error: "invalid_retention_days" });
    }
    return res.json({
      ok: true,
      retentionSettings: repository.setRetentionSettings(values),
    });
  });

  router.patch("/settings/admin-credentials", adminAuth, (req, res) => {
    const username = String(req.body?.username || "").trim();
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    if (
      username.length < 3 ||
      username.length > 64 ||
      /[\x00-\x1f\x7f]/.test(username)
    ) {
      return res.status(400).json({ error: "invalid_admin_username" });
    }
    if (newPassword.length > 256) {
      return res.status(400).json({ error: "invalid_admin_password" });
    }
    if (
      !repository.verifyAdminCredentials(
        repository.getAdminUsername(),
        currentPassword,
      )
    ) {
      return res.status(403).json({ error: "current_password_incorrect" });
    }
    repository.updateAdminCredentials({
      username,
      password: newPassword || null,
    });
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.cookieSecure,
      path: "/",
    });
    return res.json({ ok: true, requiresLogin: true });
  });

  router.post("/users", adminAuth, (req, res, next) => {
    try {
      const name = String(req.body?.name || "").trim();
      if (!name || name.length > 64) {
        return res.status(400).json({ error: "invalid_name" });
      }
      const created = repository.createUser(name);
      return res.status(201).json({
        ok: true,
        id: created.id,
        name,
        apiKey: created.apiKey,
        warning: "This key is shown only once.",
      });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "duplicate_user" });
      }
      return next(error);
    }
  });

  router.patch("/users/:id", adminAuth, (req, res) => {
    const userId = validId(req.params.id);
    if (!userId) return res.status(400).json({ error: "invalid_user_id" });
    const hasEnabled = Object.hasOwn(req.body || {}, "enabled");
    const hasIpLimit = Object.hasOwn(req.body || {}, "ipLimit");
    const hasDeviceLimit = Object.hasOwn(req.body || {}, "deviceLimit");
    if (!hasEnabled && !hasIpLimit && !hasDeviceLimit) {
      return res.status(400).json({ error: "missing_user_update" });
    }
    if (hasEnabled && typeof req.body.enabled !== "boolean") {
      return res.status(400).json({ error: "invalid_enabled_value" });
    }
    if (
      hasIpLimit &&
      (!Number.isInteger(req.body.ipLimit) ||
        req.body.ipLimit < MIN_IP_LIMIT ||
        req.body.ipLimit > MAX_IP_LIMIT)
    ) {
      return res.status(400).json({
        error: "invalid_ip_limit",
        min: MIN_IP_LIMIT,
        max: MAX_IP_LIMIT,
      });
    }
    if (
      hasDeviceLimit &&
      (!Number.isInteger(req.body.deviceLimit) ||
        req.body.deviceLimit < MIN_DEVICE_LIMIT ||
        req.body.deviceLimit > MAX_DEVICE_LIMIT)
    ) {
      return res.status(400).json({
        error: "invalid_device_limit",
        min: MIN_DEVICE_LIMIT,
        max: MAX_DEVICE_LIMIT,
      });
    }
    const existing = repository.findUserById(userId);
    if (!existing) {
      return res.status(404).json({ error: "user_not_found" });
    }
    if (hasEnabled) repository.setUserEnabled(userId, req.body.enabled);
    const limitResult = hasIpLimit
      ? repository.setUserLimit(userId, req.body.ipLimit)
      : null;
    const deviceLimitResult = hasDeviceLimit
      ? repository.setUserDeviceLimit(userId, req.body.deviceLimit)
      : null;
    return res.json({
      ok: true,
      evicted: limitResult?.evicted || [],
      evictedDevices: deviceLimitResult?.evicted || [],
    });
  });

  router.delete("/users/:id", adminAuth, (req, res) => {
    const userId = validId(req.params.id);
    if (!userId) return res.status(400).json({ error: "invalid_user_id" });
    if (!repository.deleteUser(userId))
      return res.status(404).json({ error: "user_not_found" });
    return res.json({ ok: true });
  });

  router.post("/network-rules/blacklist", adminAuth, (req, res, next) => {
    const normalized = normalizeNetwork(req.body?.ip);
    if (!normalized) return res.status(400).json({ error: "invalid_ip" });
    const reason = String(req.body?.reason || "")
      .trim()
      .slice(0, 160);
    try {
      const result = repository.addBlockedNetwork(
        normalized.network,
        normalized.family,
        reason,
      );
      return res
        .status(201)
        .json({ ok: true, network: normalized.network, ...result });
    } catch (error) {
      if (String(error.message).includes("UNIQUE"))
        return res.status(409).json({ error: "network_already_blacklisted" });
      return next(error);
    }
  });

  router.post("/network-rules/whitelist", adminAuth, (req, res, next) => {
    const raw = String(req.body?.ip || "").trim();
    const normalized = normalizeNetwork(raw);
    if (!normalized) return res.status(400).json({ error: "invalid_ip" });
    if (repository.isNetworkBlocked(normalized.network)) {
      return res.status(409).json({
        error: "network_blacklisted",
        network: normalized.network,
      });
    }
    const scope = req.body?.scope === "user" ? "user" : "global";
    const label = String(req.body?.label || "")
      .trim()
      .slice(0, 80);
    try {
      if (scope === "global") {
        const id = repository.addGlobalNetwork(
          normalized.network,
          normalized.family,
          label,
        );
        return res.status(201).json({
          ok: true,
          id,
          scope,
          network: normalized.network,
        });
      }
      const userId = validId(req.body?.userId);
      if (!userId) return res.status(400).json({ error: "invalid_user_id" });
      const user = repository.findUserById(userId, true);
      if (!user) return res.status(404).json({ error: "user_not_found" });
      const observedIp = normalizeIp(raw.split("/")[0]);
      const result = repository.addIp(
        userId,
        observedIp,
        normalized.network,
        normalized.family,
        "admin",
      );
      return res.status(result.status === "added" ? 201 : 200).json({
        ok: true,
        scope,
        network: normalized.network,
        status: result.status,
        evicted: result.evicted,
      });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "network_already_whitelisted" });
      }
      return next(error);
    }
  });

  router.delete(
    "/network-rules/whitelist/global/:id",
    adminAuth,
    (req, res) => {
      const id = validId(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid_rule_id" });
      if (!repository.removeGlobalNetwork(id)) {
        return res.status(404).json({ error: "rule_not_found" });
      }
      return res.json({ ok: true });
    },
  );

  router.delete("/network-rules/blacklist/:id", adminAuth, (req, res) => {
    const id = validId(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid_rule_id" });
    if (!repository.removeBlockedNetwork(id))
      return res.status(404).json({ error: "rule_not_found" });
    return res.json({ ok: true });
  });

  router.post("/network-rules/permanent", adminAuth, (req, res, next) => {
    const raw = String(req.body?.ip || "").trim();
    const ip = raw.includes("/") ? null : normalizeIp(raw);
    if (!ip)
      return res.status(400).json({
        error: "invalid_ip",
        message: "必须填写单个 IPv4 或 IPv6 地址",
      });
    const network = normalizeNetwork(ip);
    if (repository.isNetworkBlocked(network.network))
      return res
        .status(409)
        .json({ error: "network_blacklisted", network: network.network });
    const label = String(req.body?.label || "")
      .trim()
      .slice(0, 80);
    try {
      const id = repository.addPermanentIp(ip, network.family, label);
      return res.status(201).json({ ok: true, id, ip });
    } catch (error) {
      if (String(error.message).includes("UNIQUE"))
        return res.status(409).json({ error: "ip_already_permanent" });
      return next(error);
    }
  });

  router.delete("/network-rules/permanent/:id", adminAuth, (req, res) => {
    const id = validId(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid_rule_id" });
    if (!repository.removePermanentIp(id))
      return res.status(404).json({ error: "rule_not_found" });
    return res.json({ ok: true });
  });

  router.get("/users/:id/history", adminAuth, (req, res) => {
    const userId = validId(req.params.id);
    if (!userId) return res.status(400).json({ error: "invalid_user_id" });
    if (!repository.findUserById(userId)) {
      return res.status(404).json({ error: "user_not_found" });
    }
    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 100),
    );
    const offset = Math.min(
      1_000_000,
      Math.max(0, Number.parseInt(req.query.offset, 10) || 0),
    );
    const search = String(req.query.q || "")
      .trim()
      .slice(0, 80);
    const event = String(req.query.event || "");
    return res.json({
      ok: true,
      history: repository.listUserHistory(userId, limit, offset, search, event),
      search,
      event: ["reported", "added", "removed", "evicted"].includes(event)
        ? event
        : "",
    });
  });

  router.delete("/users/:id/ips", adminAuth, (req, res) => {
    const userId = validId(req.params.id);
    if (!userId) return res.status(400).json({ error: "invalid_user_id" });
    const removed = repository.clearUserIps(userId);
    if (removed === null) {
      return res.status(404).json({ error: "user_not_found" });
    }
    return res.json({ ok: true, removed });
  });

  router.post("/users/:id/rotate-key", adminAuth, (req, res) => {
    const userId = validId(req.params.id);
    if (!userId) return res.status(400).json({ error: "invalid_user_id" });
    const apiKey = repository.rotateUserKey(userId);
    if (!apiKey) return res.status(404).json({ error: "user_not_found" });
    return res.json({
      ok: true,
      apiKey,
      warning: "This key is shown only once.",
    });
  });

  router.get("/users/:id/surge-module", adminAuth, (req, res) => {
    const userId = validId(req.params.id);
    if (!userId) return res.status(400).json({ error: "invalid_user_id" });
    const user = repository.findUserById(userId);
    if (!user) return res.status(404).json({ error: "user_not_found" });
    if (!config.publicBaseUrl || !config.firewallSyncToken) {
      return res.status(503).json({ error: "surge_module_unavailable" });
    }
    return res.json(surgeModuleLinks(user));
  });

  router.post("/users/:id/rotate-surge-token", adminAuth, (req, res) => {
    const userId = validId(req.params.id);
    if (!userId) return res.status(400).json({ error: "invalid_user_id" });
    if (!config.publicBaseUrl || !config.firewallSyncToken) {
      return res.status(503).json({ error: "surge_module_unavailable" });
    }
    if (!repository.rotateSurgeToken(userId)) {
      return res.status(404).json({ error: "user_not_found" });
    }
    const user = repository.findUserById(userId);
    return res.json(surgeModuleLinks(user));
  });

  router.delete("/users/:userId/devices/:deviceId", adminAuth, (req, res) => {
    const userId = validId(req.params.userId);
    const deviceId = validId(req.params.deviceId);
    if (!userId || !deviceId) {
      return res.status(400).json({ error: "invalid_device_id" });
    }
    if (!repository.removeUserDevice(userId, deviceId)) {
      return res.status(404).json({ error: "device_not_found" });
    }
    return res.json({ ok: true });
  });

  router.delete("/ips/:id", adminAuth, (req, res) => {
    const ipId = validId(req.params.id);
    if (!ipId) return res.status(400).json({ error: "invalid_ip_id" });
    if (!repository.removeIp(ipId)) {
      return res.status(404).json({ error: "ip_not_found" });
    }
    return res.json({ ok: true });
  });

  return router;
}
