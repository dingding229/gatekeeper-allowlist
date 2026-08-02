import { Router } from "express";
import { normalizeIp, normalizeNetwork } from "../security.js";
import { sanitizeReportedIpInfo } from "../ip-info.js";

export function createAllowlistRouter({ repository, apiAuth }) {
  const router = Router();

  router.post("/whitelist", apiAuth, (req, res, next) => {
    try {
      const rawIp = req.body?.ip || req.ip || req.socket.remoteAddress;
      const normalized = normalizeNetwork(rawIp);
      if (!normalized) {
        return res.status(400).json({
          error: "invalid_ip",
          message: "ip must be a valid IPv4 or IPv6 address",
        });
      }
      if (repository.isNetworkBlocked(normalized.network)) {
        return res
          .status(403)
          .json({ error: "network_blacklisted", network: normalized.network });
      }

      const source =
        String(req.body?.source || "api")
          .trim()
          .slice(0, 32) || "api";
      const observedIp = normalizeIp(String(rawIp).split("/")[0]);
      const result = repository.addIp(
        req.user.id,
        observedIp,
        normalized.network,
        normalized.family,
        source,
      );
      const location = sanitizeReportedIpInfo(req.body?.ipInfo);
      if (location)
        repository.updateHistoryLocation(result.historyId, location);
      const ips = repository.listUserIps(req.user.id);
      return res.status(result.status === "added" ? 201 : 200).json({
        ok: true,
        status: result.status,
        ip: normalized.network,
        evicted: result.evicted,
        slots: ips.length,
        limit: result.limit,
        ipInfoRecorded: Boolean(location),
        ips,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/whitelist", apiAuth, (req, res) => {
    const ips = repository.listUserIps(req.user.id);
    res.json({
      user: req.user.name,
      limit: req.user.ip_limit,
      slots: ips.length,
      ips,
    });
  });

  return router;
}
