import { Router } from "express";
import {
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_WINDOW_MS,
  SESSION_TTL_MS,
} from "../constants.js";
import {
  createSessionToken,
  createSurgeToken,
  safeEqual,
  sha256,
} from "../security.js";
import { parsePortRanges } from "../ports.js";

const SESSION_COOKIE = "allowlist_session";

const validId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export function createAdminRouter({ repository, adminAuth, config }) {
  const router = Router();
  const loginAttempts = new Map();

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

    const authenticated =
      safeEqual(req.body?.username, config.adminUsername) &&
      safeEqual(req.body?.password, config.adminPassword);
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

  router.get("/overview", adminAuth, (_req, res) => {
    res.json(repository.getOverview());
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
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "invalid_enabled_value" });
    }
    if (!repository.setUserEnabled(userId, req.body.enabled)) {
      return res.status(404).json({ error: "user_not_found" });
    }
    return res.json({ ok: true });
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
    const token = createSurgeToken(user.id, config.firewallSyncToken);
    const moduleUrl = `${config.publicBaseUrl}/api/v1/surge/${encodeURIComponent(token)}/module.sgmodule`;
    return res.json({
      ok: true,
      user: user.name,
      moduleUrl,
      installUrl: `surge:///install-module?url=${encodeURIComponent(moduleUrl)}`,
    });
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
