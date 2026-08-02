import { isIP } from "node:net";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createRepository } from "./repository.js";
import { normalizeIp } from "./security.js";

const [, , command, ...args] = process.argv;
const config = loadConfig();
const db = openDatabase(config.databasePath);
const repository = createRepository(db);

try {
  if (command !== "bootstrap" || args.length !== 2) {
    throw new Error("Usage: node src/cli.js bootstrap <user-name> <ip>");
  }

  const [name, rawIp] = args;
  const ip = normalizeIp(rawIp);
  const family = isIP(ip);
  if (!name.trim() || name.length > 64) throw new Error("Invalid user name");
  if (!family) throw new Error("Invalid IP address");

  const user = repository.createUser(name.trim());
  repository.addIp(user.id, ip, family, "installer");
  process.stdout.write(`${JSON.stringify({ ...user, ip })}\n`);
} finally {
  db.close();
}
