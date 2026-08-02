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

  router.post("/firewall-status", authenticate, (req, res) => {
    const body = req.body || {};
    const revision = Number(body.revision);
    const counts = [
      body.ipv4Count,
      body.ipv6Count,
      body.tcpPortCount,
      body.udpPortCount,
    ].map(Number);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof body.success !== "boolean" ||
      counts.some((value) => !Number.isSafeInteger(value) || value < 0)
    ) {
      return res.status(400).json({ error: "invalid_firewall_status" });
    }
    const status = repository.reportFirewallStatus({
      revision,
      success: body.success,
      ipv4Count: counts[0],
      ipv6Count: counts[1],
      tcpPortCount: counts[2],
      udpPortCount: counts[3],
      error: body.error,
    });
    return res.json({ ok: true, status });
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
