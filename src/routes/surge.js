import { Router } from "express";
import { readFileSync } from "node:fs";
import { renderSurgeModule } from "../surge.js";
import { verifySurgeToken } from "../security.js";
import {
  SERVER_VERSION,
  SURGE_MODULE_VERSION,
  SURGE_SCRIPT_VERSION,
} from "../version.js";

const surgeClientScript = readFileSync(
  new URL("../../surge/gatekeeper.js", import.meta.url),
  "utf8",
);

export function createSurgeRouter({ repository, config }) {
  const router = Router();

  router.get("/client/:version/gatekeeper.js", (req, res) => {
    if (req.params.version !== SURGE_SCRIPT_VERSION) {
      return res.status(404).type("text/plain").send("Script not found");
    }
    res.set("Cache-Control", "no-store");
    res.set("X-Gatekeeper-Server-Version", SERVER_VERSION);
    res.set("X-Gatekeeper-Surge-Script-Version", SURGE_SCRIPT_VERSION);
    return res.type("application/javascript").send(surgeClientScript);
  });

  router.get("/:token/module.sgmodule", (req, res) => {
    const decoded = verifySurgeToken(
      req.params.token,
      config.firewallSyncToken,
    );
    const user = decoded ? repository.findUserById(decoded.userId, true) : null;
    if (!user || !config.publicBaseUrl) {
      return res.status(404).type("text/plain").send("Module not found");
    }
    if (user.surge_version !== decoded.version) {
      return res.status(404).type("text/plain").send("Module not found");
    }
    res.set("Cache-Control", "no-store");
    res.set("X-Gatekeeper-Server-Version", SERVER_VERSION);
    res.set("X-Gatekeeper-Surge-Module-Version", SURGE_MODULE_VERSION);
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
