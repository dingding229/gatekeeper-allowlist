import { resolve } from "node:path";

const DEFAULT_PASSWORD = "please-change-this-password";

const booleanValue = (value) => value === "1" || value === "true";

const integerValue = (value, fallback, name) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
};

export function loadConfig(env = process.env) {
  const config = {
    host: env.HOST || "127.0.0.1",
    port: integerValue(env.PORT, 8787, "PORT"),
    databasePath: resolve(env.DATABASE_PATH || "./data/allowlist.db"),
    adminUsername: env.ADMIN_USERNAME || "admin",
    adminPassword: env.ADMIN_PASSWORD || DEFAULT_PASSWORD,
    firewallSyncToken: env.FIREWALL_SYNC_TOKEN || "",
    trustProxy: booleanValue(env.TRUST_PROXY),
    cookieSecure: booleanValue(env.COOKIE_SECURE),
    production: env.NODE_ENV === "production",
  };

  if (config.production && config.adminPassword === DEFAULT_PASSWORD) {
    throw new Error("ADMIN_PASSWORD must be changed in production");
  }
  if (config.production && config.adminPassword.length < 12) {
    throw new Error(
      "ADMIN_PASSWORD must contain at least 12 characters in production",
    );
  }
  if (config.firewallSyncToken && config.firewallSyncToken.length < 24) {
    throw new Error("FIREWALL_SYNC_TOKEN must contain at least 24 characters");
  }

  return config;
}
