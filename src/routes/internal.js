import { Router } from "express";
import { safeEqual } from "../security.js";

export function createInternalRouter({ repository, config, firewallEvents }) {
  const router = Router();

  const authenticate = (req, res, next) => {
    const token = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (
      !config.firewallSyncToken ||
      !token ||
      !safeEqual(token, config.firewallSyncToken)
    ) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  };

  router.get("/firewall-snapshot", authenticate, (_req, res) => {
    return res.json(repository.getFirewallSnapshot());
  });

  router.get("/firewall-revision", authenticate, (req, res) => {
    const since = Number(req.query.since);
    const current = repository.getFirewallRevision();
    if (!Number.isSafeInteger(since) || since !== current) {
      return res.json({ revision: current });
    }

    let finished = false;
    const finish = (revision) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      firewallEvents.off("change", onChange);
      if (!res.headersSent) res.json({ revision });
    };
    const onChange = (revision) => finish(revision);
    const timer = setTimeout(
      () => finish(repository.getFirewallRevision()),
      25_000,
    );
    firewallEvents.once("change", onChange);
    const latest = repository.getFirewallRevision();
    if (latest !== since) finish(latest);
    req.once("close", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      firewallEvents.off("change", onChange);
    });
  });

  return router;
}
