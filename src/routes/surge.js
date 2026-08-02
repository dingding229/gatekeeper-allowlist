import { Router } from "express";
import { renderSurgeModule } from "../surge.js";
import { verifySurgeToken } from "../security.js";

export function createSurgeRouter({ repository, config }) {
  const router = Router();

  router.get("/:token/module.sgmodule", (req, res) => {
    const userId = verifySurgeToken(req.params.token, config.firewallSyncToken);
    const user = userId ? repository.findUserById(userId, true) : null;
    if (!user || !config.publicBaseUrl) {
      return res.status(404).type("text/plain").send("Module not found");
    }
    res.set("Cache-Control", "no-store");
    return res.type("text/plain").send(
      renderSurgeModule({
        user,
        publicBaseUrl: config.publicBaseUrl,
        token: req.params.token,
        cooldownSeconds: Math.max(
          1,
          repository.getApiRateLimitWindowMs() / 1000,
        ),
      }),
    );
  });

  return router;
}
