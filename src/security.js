import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const sha256 = (value) =>
  createHash("sha256").update(String(value)).digest("hex");

export const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

export const createApiKey = () =>
  `awl_${randomBytes(24).toString("base64url")}`;
export const createSessionToken = () => randomBytes(32).toString("base64url");

export function normalizeIp(value) {
  let ip = String(value || "").trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);

  const zoneIndex = ip.indexOf("%");
  if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);
  if (isIP(ip) === 6) ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  return ip;
}

function ipv6Network64(ip) {
  const parts = ip.split("::");
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  const expanded =
    parts.length === 2
      ? [...left, ...Array(missing).fill("0"), ...right]
      : left;
  const network = [...expanded.slice(0, 4), "0", "0", "0", "0"].join(":");
  return `${new URL(`http://[${network}]/`).hostname.slice(1, -1)}/64`;
}

export function normalizeNetwork(value) {
  const address = String(value || "").split("/")[0];
  const ip = normalizeIp(address);
  const family = isIP(ip);
  if (family === 4) {
    const octets = ip.split(".");
    return {
      network: `${octets[0]}.${octets[1]}.${octets[2]}.0/24`,
      family,
      prefixLength: 24,
    };
  }
  if (family === 6) {
    return { network: ipv6Network64(ip), family, prefixLength: 64 };
  }
  return null;
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return [];
      try {
        return [
          [
            part.slice(0, separator).trim(),
            decodeURIComponent(part.slice(separator + 1).trim()),
          ],
        ];
      } catch {
        return [];
      }
    }),
  );
}
