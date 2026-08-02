import { Router } from "express";
import { safeEqual } from "../security.js";

export function createInternalRouter({ repository, config }) {
  const router = Router();

  router.get("/firewall-snapshot", (req, res) => {
    const token = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (
      !config.firewallSyncToken ||
      !token ||
      !safeEqual(token, config.firewallSyncToken)
    ) {
      return res.status(401).json({ error: "unauthorized" });
    }
    return res.json(repository.getFirewallSnapshot());
  });

  return router;
}
