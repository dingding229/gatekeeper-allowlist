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

const adminPathValue = (value) => {
  const path = `/${String(value || "manage").replace(/^\/+|\/+$/g, "")}`;
  if (!/^\/[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(path)) {
    throw new Error(
      "ADMIN_PATH must contain 3-64 letters, numbers, underscores, or hyphens",
    );
  }
  if (["/api", "/health"].includes(path))
    throw new Error("ADMIN_PATH is reserved");
  return path;
};

const publicBaseUrlValue = (env) => {
  const raw =
    env.PUBLIC_BASE_URL || (env.DOMAIN ? `https://${env.DOMAIN}` : "");
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("PUBLIC_BASE_URL must be an HTTP(S) origin without a path");
  }
  return url.origin;
};

const httpsUrlValue = (value, name) => {
  let url;
  try {
    url = new URL(String(value).replace("{ip}", "1.1.1.1"));
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return String(value);
};

export function loadConfig(env = process.env) {
  const config = {
    host: env.HOST || "127.0.0.1",
    port: integerValue(env.PORT, 8787, "PORT"),
    databasePath: resolve(env.DATABASE_PATH || "./data/allowlist.db"),
    adminPath: adminPathValue(env.ADMIN_PATH),
    adminUsername: env.ADMIN_USERNAME || "admin",
    adminPassword: env.ADMIN_PASSWORD || DEFAULT_PASSWORD,
    firewallSyncToken: env.FIREWALL_SYNC_TOKEN || "",
    publicBaseUrl: publicBaseUrlValue(env),
    ipGeolocationEnabled: env.IP_GEOLOCATION_ENABLED !== "0",
    ipGeolocationUrl: httpsUrlValue(
      env.IP_GEOLOCATION_URL ||
        "https://ipwho.is/{ip}?fields=success,country,region,city,connection.isp&lang=zh-CN",
      "IP_GEOLOCATION_URL",
    ),
    serverIpLookupUrls: [
      httpsUrlValue(
        env.SERVER_IPV4_LOOKUP_URL || "https://api.ipify.org?format=json",
        "SERVER_IPV4_LOOKUP_URL",
      ),
      httpsUrlValue(
        env.SERVER_IPV6_LOOKUP_URL || "https://api6.ipify.org?format=json",
        "SERVER_IPV6_LOOKUP_URL",
      ),
    ],
    ipLookupTimeoutMs: integerValue(
      env.IP_LOOKUP_TIMEOUT_MS,
      4_000,
      "IP_LOOKUP_TIMEOUT_MS",
    ),
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
  if (config.ipLookupTimeoutMs < 500 || config.ipLookupTimeoutMs > 15_000) {
    throw new Error("IP_LOOKUP_TIMEOUT_MS must be between 500 and 15000");
  }
  if (config.production && !config.publicBaseUrl) {
    throw new Error("DOMAIN or PUBLIC_BASE_URL is required in production");
  }
  if (config.production && !config.publicBaseUrl.startsWith("https://")) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production");
  }

  return config;
}
