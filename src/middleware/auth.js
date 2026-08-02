import { parseCookies, sha256 } from "../security.js";

export function createAuthMiddleware({ repository }) {
  return {
    api(req, res, next) {
      const bearer = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      const rawKey = bearer || req.get("x-api-key") || req.query.key;
      const apiKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      if (!apiKey) return res.status(401).json({ error: "missing_api_key" });

      const user = repository.findEnabledUserByApiKey(apiKey);
      if (!user) return res.status(401).json({ error: "invalid_api_key" });
      req.user = user;
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
