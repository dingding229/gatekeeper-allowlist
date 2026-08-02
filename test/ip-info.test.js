import test from "node:test";
import assert from "node:assert/strict";
import {
  createIpInfoService,
  parseIpCheckText,
  sanitizeReportedIpInfo,
} from "../src/ip-info.js";

test("IPCheck text is parsed and reported metadata is sanitized", () => {
  const parsed = parseIpCheckText(
    "IP: 8.8.8.8\nCity: Mountain View\nRegion: California\nCountry: US\nOrg: Example ISP\nASN: AS15169\n",
  );
  assert.equal(parsed.ip, "8.8.8.8");
  assert.equal(parsed.countryCode, "US");
  assert.equal(parsed.city, "Mountain View");
  assert.equal(parsed.source, "ipcheck.ing");
  assert.equal(parseIpCheckText("IP: invalid"), null);
  assert.equal(sanitizeReportedIpInfo({ source: "other", city: "x" }), null);
  assert.equal(
    sanitizeReportedIpInfo({ source: "ipcheck.ing", city: "Macau" }).city,
    "Macau",
  );
});

test("IP information service uses IPCheck and caches server IPs", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const ip = url.includes("6.ipcheck") ? "2606:4700::1" : "8.8.8.8";
    return {
      ok: true,
      text: async () => `IP: ${ip}\nCity: Test\nCountry: US\nOrg: ISP\n`,
    };
  };
  const service = createIpInfoService({ config: {}, fetchImpl });
  const first = await service.getServerInfo();
  const second = await service.getServerInfo();
  assert.deepEqual(first.ips, ["8.8.8.8", "2606:4700::1"]);
  assert.equal(first.source, "ipcheck.ing");
  assert.deepEqual(second.ips, first.ips);
  assert.equal(calls.length, 2);
});

test("IPCheck requests use a CLI user agent to avoid browser challenges", async () => {
  let headers;
  const service = createIpInfoService({
    config: { serverIpLookupUrls: ["https://4.ipcheck.ing/geo"] },
    fetchImpl: async (_url, options) => {
      headers = options.headers;
      return { ok: true, text: async () => "IP: 8.8.8.8\nCountry: US\n" };
    },
  });
  await service.getServerInfo();
  assert.match(headers["User-Agent"], /^curl\//);
});
