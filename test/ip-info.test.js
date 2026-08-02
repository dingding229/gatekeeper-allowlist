import test from "node:test";
import assert from "node:assert/strict";
import { createIpInfoService, isPublicIp } from "../src/ip-info.js";

test("public IP detection excludes private and documentation ranges", () => {
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("10.0.0.1"), false);
  assert.equal(isPublicIp("203.0.113.8"), false);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
  assert.equal(isPublicIp("2001:db8::1"), false);
});

test("IP information service sanitizes location and caches server IPs", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = url.includes("ipwho")
      ? {
          success: true,
          country: "United States",
          region: "California",
          city: "Mountain View",
          connection: { isp: "Example ISP" },
        }
      : { ip: url.includes("api6") ? "2606:4700::1" : "8.8.8.8" };
    return { ok: true, json: async () => body };
  };
  const service = createIpInfoService({ config: {}, fetchImpl });
  const location = await service.lookup("8.8.8.8");
  assert.equal(location.city, "Mountain View");
  assert.equal(location.isp, "Example ISP");

  const first = await service.getServerInfo();
  const second = await service.getServerInfo();
  assert.deepEqual(first.ips, ["8.8.8.8", "2606:4700::1"]);
  assert.deepEqual(second.ips, first.ips);
  assert.equal(calls.length, 3);
});
