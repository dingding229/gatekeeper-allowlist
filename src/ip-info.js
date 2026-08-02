import { isIP } from "node:net";

const clean = (value, max = 120) => {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : null;
};

function isPublicIpv4(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function isPublicIp(ip) {
  const family = isIP(ip);
  if (family === 4) return isPublicIpv4(ip);
  if (family !== 6) return false;
  const normalized = ip.toLowerCase();
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("2001:db8:")
  );
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "Gatekeeper/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`IP information HTTP ${response.status}`);
  return response.json();
}

export function createIpInfoService({ config, fetchImpl = fetch } = {}) {
  const timeoutMs = config?.ipLookupTimeoutMs || 4_000;
  const geoEnabled = config?.ipGeolocationEnabled !== false;
  const geoUrl =
    config?.ipGeolocationUrl ||
    "https://ipwho.is/{ip}?fields=success,country,region,city,connection.isp&lang=zh-CN";
  const serverUrls = config?.serverIpLookupUrls || [
    "https://api.ipify.org?format=json",
    "https://api6.ipify.org?format=json",
  ];
  let serverCache = null;
  let serverPromise = null;

  return {
    async lookup(ip) {
      if (!geoEnabled || !isPublicIp(ip)) return null;
      try {
        const data = await fetchJson(
          fetchImpl,
          geoUrl.replace("{ip}", encodeURIComponent(ip)),
          timeoutMs,
        );
        if (data.success === false) return null;
        return {
          country: clean(data.country),
          region: clean(data.region),
          city: clean(data.city),
          isp: clean(data.connection?.isp || data.isp),
        };
      } catch {
        return null;
      }
    },

    async getServerInfo() {
      if (serverCache && Date.now() - serverCache.cachedAt < 10 * 60 * 1000) {
        return serverCache.value;
      }
      if (serverPromise) return serverPromise;
      serverPromise = Promise.allSettled(
        serverUrls.map((url) => fetchJson(fetchImpl, url, timeoutMs)),
      )
        .then((results) => {
          const ips = [
            ...new Set(
              results
                .filter((result) => result.status === "fulfilled")
                .map((result) => clean(result.value.ip, 64))
                .filter((ip) => isIP(ip)),
            ),
          ];
          const value = {
            ips,
            updatedAt: new Date().toISOString(),
            available: ips.length > 0,
          };
          serverCache = { cachedAt: Date.now(), value };
          return value;
        })
        .finally(() => {
          serverPromise = null;
        });
      return serverPromise;
    },
  };
}
