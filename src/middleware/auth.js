import { parseCookies, sha256, verifySurgeToken } from "../security.js";
import {
  SERVER_VERSION,
  SURGE_MODULE_VERSION,
  SURGE_SCRIPT_VERSION,
} from "../version.js";

export function createAuthMiddleware({ repository, config }) {
  return {
    api(req, res, next) {
      const bearer = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      const rawKey = bearer || req.get("x-api-key");
      const apiKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      if (!apiKey) return res.status(401).json({ error: "missing_api_key" });

      const surgeToken = verifySurgeToken(apiKey, config.firewallSyncToken);
      const surgeUser = surgeToken
        ? repository.findUserById(surgeToken.userId, true)
        : null;
      const user =
        surgeUser && surgeUser.surge_version === surgeToken.version
          ? surgeUser
          : repository.findEnabledUserByApiKey(apiKey);
      if (!user) return res.status(401).json({ error: "invalid_api_key" });
      const suppliedDeviceKey =
        req.get("x-gatekeeper-device-id") || req.body?.deviceId;
      const deviceKey = String(suppliedDeviceKey || "legacy").trim();
      if (!/^[A-Za-z0-9_-]{3,64}$/.test(deviceKey)) {
        return res.status(400).json({ error: "invalid_device_id" });
      }
      const deviceName =
        String(
          req.get("x-gatekeeper-device-name") ||
            req.body?.deviceName ||
            (deviceKey === "legacy" ? "默认 API 客户端" : "未命名设备"),
        )
          .trim()
          .slice(0, 64) || "未命名设备";
      const source =
        String(req.body?.source || "api")
          .trim()
          .slice(0, 32) || "api";
      if (source === "surge") {
        const moduleVersion = String(req.body?.moduleVersion || "");
        const scriptVersion = String(req.body?.scriptVersion || "");
        if (
          moduleVersion !== SURGE_MODULE_VERSION ||
          scriptVersion !== SURGE_SCRIPT_VERSION
        ) {
          res.set("Cache-Control", "no-store");
          return res.status(426).json({
            error: "module_update_required",
            serverVersion: SERVER_VERSION,
            requiredModuleVersion: SURGE_MODULE_VERSION,
            requiredScriptVersion: SURGE_SCRIPT_VERSION,
            receivedModuleVersion: moduleVersion || null,
            receivedScriptVersion: scriptVersion || null,
          });
        }
      }
      let deviceStatus;
      try {
        deviceStatus = repository.touchUserDevice(
          user.id,
          deviceKey,
          deviceName,
          req.ip,
          source,
        );
      } catch (error) {
        if (error.code === "DEVICE_LIMIT_EXCEEDED") {
          return res.status(409).json({
            error: "device_limit_exceeded",
            limit: error.limit,
          });
        }
        throw error;
      }
      const rate = repository.consumeApiRequest(
        user.id,
        Date.now(),
        repository.getApiRateLimitWindowMs(),
        deviceKey,
        { allowImmediate: Boolean(deviceStatus?.ipChanged) },
      );
      res.set("RateLimit-Limit", "1");
      if (!rate.allowed) {
        res.set({
          "Retry-After": String(rate.retryAfter),
          "RateLimit-Remaining": "0",
        });
        return res.status(429).json({
          error: "rate_limit_exceeded",
          retryAfter: rate.retryAfter,
        });
      }
      res.set("RateLimit-Remaining", "0");
      req.user = user;
      req.device = { key: deviceKey, name: deviceName };
      next();
    },

    admin(req, res, next) {
      const token = parseCookies(req.get("cookie")).allowlist_session;
      if (!token || !repository.sessionIsValid(sha256(token))) {
        return res.status(401).json({ error: "admin_auth_required" });
      }
      req.sessionToken = token;
      next();
    },
  };
}
