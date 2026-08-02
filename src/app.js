import express from "express";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createIpInfoService } from "./ip-info.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createSecurityHeaders } from "./middleware/security-headers.js";
import { createRepository } from "./repository.js";
import { createAdminRouter } from "./routes/admin.js";
import { createAllowlistRouter } from "./routes/allowlist.js";
import { createInternalRouter } from "./routes/internal.js";
import { createSurgeRouter } from "./routes/surge.js";

const publicDirectory = fileURLToPath(new URL("../public", import.meta.url));

export function createApp({ db, config, services = {} }) {
  const app = express();
  const firewallEvents = new EventEmitter();
  firewallEvents.setMaxListeners(100);
  const repository = createRepository(db, {
    onFirewallChange: (revision) => firewallEvents.emit("change", revision),
  });
  const ipInfo = services.ipInfo || createIpInfoService({ config });
  const auth = createAuthMiddleware({ repository, config });

  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use(createSecurityHeaders());

  app.get("/health", (_req, res) => {
    repository.checkHealth();
    res.json({ ok: true });
  });

  app.use("/api/v1/surge", createSurgeRouter({ repository, config }));
  app.use(
    "/api/v1",
    createAllowlistRouter({ repository, apiAuth: auth.api, ipInfo }),
  );
  app.use(
    "/api/admin",
    createAdminRouter({ repository, adminAuth: auth.admin, config, ipInfo }),
  );
  app.use(
    "/api/internal",
    createInternalRouter({ repository, config, firewallEvents }),
  );
  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(
    config.adminPath,
    express.static(publicDirectory, { extensions: ["html"] }),
  );
  app.use((_req, res) => res.status(404).send("Not Found"));

  app.use((error, _req, res, _next) => {
    console.error("[gatekeeper:error]", error);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
