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
