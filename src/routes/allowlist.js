import { Router } from "express";
import { isIP } from "node:net";
import { IP_LIMIT } from "../constants.js";
import { normalizeIp } from "../security.js";

export function createAllowlistRouter({ repository, apiAuth }) {
  const router = Router();

  router.post("/whitelist", apiAuth, (req, res, next) => {
    try {
      const ip = normalizeIp(
        req.body?.ip || req.ip || req.socket.remoteAddress,
      );
      const family = isIP(ip);
      if (!family) {
        return res.status(400).json({
          error: "invalid_ip",
          message: "ip must be a valid IPv4 or IPv6 address",
        });
      }

      const source =
        String(req.body?.source || "api")
          .trim()
          .slice(0, 32) || "api";
      const result = repository.addIp(req.user.id, ip, family, source);
      const ips = repository.listUserIps(req.user.id);
      return res.status(result.status === "added" ? 201 : 200).json({
        ok: true,
        status: result.status,
        ip,
        evicted: result.evicted,
        slots: ips.length,
        limit: IP_LIMIT,
        ips,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/whitelist", apiAuth, (req, res) => {
    const ips = repository.listUserIps(req.user.id);
    res.json({ user: req.user.name, limit: IP_LIMIT, slots: ips.length, ips });
  });

  return router;
}
