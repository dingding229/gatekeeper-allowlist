import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
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

export function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(String(password), salt, 32).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, encoded) {
  const match = String(encoded || "").match(
    /^scrypt\$([A-Za-z0-9_-]{16,32})\$([A-Za-z0-9_-]{40,48})$/,
  );
  if (!match) return false;
  const actual = scryptSync(String(password), match[1], 32).toString(
    "base64url",
  );
  return safeEqual(actual, match[2]);
}

export function createSurgeToken(userId, secret, version = 1) {
  const value = version === 1 ? String(userId) : `${userId}:${version}`;
  const payload = Buffer.from(value).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`gatekeeper-surge:${payload}`)
    .digest("base64url");
  return `sg_${payload}.${signature}`;
}

export function verifySurgeToken(token, secret) {
  const match = String(token || "").match(
    /^sg_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/,
  );
  if (!match || !secret) return null;
  let userId;
  let version;
  try {
    const decoded = Buffer.from(match[1], "base64url").toString("utf8");
    const parts = decoded.split(":");
    userId = Number(parts[0]);
    version = parts.length === 1 ? 1 : Number(parts[1]);
  } catch {
    return null;
  }
  if (
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    return null;
  const expected = createSurgeToken(userId, secret, version);
  return safeEqual(token, expected) ? { userId, version } : null;
}

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
