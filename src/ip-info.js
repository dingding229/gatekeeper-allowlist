import { isIP } from "node:net";

const clean = (value, max = 120) => {
  const text = String(value || "").trim();
  return text && text !== "N/A" ? text.slice(0, max) : null;
};

const countryNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });

export function parseIpCheckText(text) {
  const fields = Object.fromEntries(
    String(text || "")
      .split(/\r?\n/)
      .flatMap((line) => {
        const separator = line.indexOf(":");
        return separator > 0
          ? [
              [
                line.slice(0, separator).trim(),
                line.slice(separator + 1).trim(),
              ],
            ]
          : [];
      }),
  );
  const ip = clean(fields.IP, 64);
  if (!ip || !isIP(ip)) return null;
  const countryCode = clean(fields.Country, 2)?.toUpperCase() || null;
  let country = countryCode;
  if (countryCode) {
    try {
      country = countryNames.of(countryCode) || countryCode;
    } catch {
      country = countryCode;
    }
  }
  return {
    ip,
    country,
    countryCode,
    region: clean(fields.Region),
    city: clean(fields.City),
    isp: clean(fields.Org),
    asn: clean(fields.ASN, 32),
    source: "ipcheck.ing",
  };
}

export function sanitizeReportedIpInfo(value) {
  if (!value || value.source !== "ipcheck.ing") return null;
  return {
    country: clean(value.country),
    region: clean(value.region),
    city: clean(value.city),
    isp: clean(value.isp),
    source: "ipcheck.ing",
  };
}

async function fetchText(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {
    headers: { Accept: "text/plain", "User-Agent": "curl/8.0 Gatekeeper/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`IPCheck.ing HTTP ${response.status}`);
  return response.text();
}

export function createIpInfoService({ config, fetchImpl = fetch } = {}) {
  const timeoutMs = config?.ipLookupTimeoutMs || 5_000;
  const serverUrls = config?.serverIpLookupUrls || [
    "https://4.ipcheck.ing/geo",
    "https://6.ipcheck.ing/geo",
  ];
  let serverCache = null;
  let serverPromise = null;

  return {
    async getServerInfo() {
      if (
        serverCache &&
        Date.now() - serverCache.cachedAt < serverCache.maxAge
      ) {
        return serverCache.value;
      }
      if (serverPromise) return serverPromise;
      serverPromise = Promise.allSettled(
        serverUrls.map(async (url) =>
          parseIpCheckText(await fetchText(fetchImpl, url, timeoutMs)),
        ),
      )
        .then((results) => {
          const details = results
            .filter(
              (result) => result.status === "fulfilled" && result.value?.ip,
            )
            .map((result) => result.value)
            .filter(
              (item, index, all) =>
                all.findIndex((candidate) => candidate.ip === item.ip) ===
                index,
            );
          const value = {
            ips: details.map((item) => item.ip),
            details,
            updatedAt: new Date().toISOString(),
            available: details.length > 0,
            source: "ipcheck.ing",
            errors: results
              .filter((result) => result.status === "rejected")
              .map((result) => clean(result.reason?.message, 160))
              .filter(Boolean),
          };
          serverCache = {
            cachedAt: Date.now(),
            maxAge: details.length ? 10 * 60 * 1000 : 30 * 1000,
            value,
          };
          return value;
        })
        .finally(() => {
          serverPromise = null;
        });
      return serverPromise;
    },
  };
}
