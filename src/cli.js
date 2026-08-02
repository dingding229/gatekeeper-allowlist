import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { parsePortRanges } from "./ports.js";
import { createRepository } from "./repository.js";
import { normalizeNetwork } from "./security.js";

const [, , command, ...args] = process.argv;
const config = loadConfig();
const db = openDatabase(config.databasePath);
const repository = createRepository(db);

try {
  if (command === "bootstrap" && args.length === 3) {
    const [name, rawIp, sshPort] = args;
    const normalized = normalizeNetwork(rawIp);
    if (!name.trim() || name.length > 64) throw new Error("Invalid user name");
    if (!normalized) throw new Error("Invalid IP address");
    const tcpPorts = parsePortRanges(sshPort);

    const user = repository.createUser(name.trim());
    repository.addIp(
      user.id,
      normalized.network,
      normalized.family,
      "installer",
    );
    repository.setFirewallSettings({ tcpPorts, udpPorts: [] });
    process.stdout.write(
      `${JSON.stringify({ ...user, ip: normalized.network })}\n`,
    );
  } else if (command === "set-firewall" && args.length === 2) {
    const [tcpValue, udpValue] = args;
    const settings = repository.setFirewallSettings({
      tcpPorts: parsePortRanges(tcpValue),
      udpPorts: parsePortRanges(udpValue),
    });
    process.stdout.write(`${JSON.stringify(settings)}\n`);
  } else {
    throw new Error(
      [
        "Usage:",
        "  node src/cli.js bootstrap <user-name> <ip> <ssh-port>",
        '  node src/cli.js set-firewall <tcp-ranges> <udp-ranges> (use "" for none)',
      ].join("\n"),
    );
  }
} finally {
  db.close();
}
