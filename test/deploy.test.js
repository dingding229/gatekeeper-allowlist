import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const template = readFileSync(
  new URL("../deploy/nftables/gatekeeper.nft.template", import.meta.url),
  "utf8",
);
const syncService = readFileSync(
  new URL("../deploy/systemd/gatekeeper-sync.service", import.meta.url),
  "utf8",
);
const listenerService = readFileSync(
  new URL(
    "../deploy/systemd/gatekeeper-sync-listener.service",
    import.meta.url,
  ),
  "utf8",
);
const watcher = readFileSync(
  new URL("../scripts/watch-firewall.sh", import.meta.url),
  "utf8",
);
const installer = readFileSync(
  new URL("../install.sh", import.meta.url),
  "utf8",
);
const updater = readFileSync(new URL("../update.sh", import.meta.url), "utf8");
const syncScript = readFileSync(
  new URL("../scripts/sync-nftables.sh", import.meta.url),
  "utf8",
);
const backupScript = readFileSync(
  new URL("../scripts/backup.sh", import.meta.url),
  "utf8",
);
const restoreScript = readFileSync(
  new URL("../scripts/restore.sh", import.meta.url),
  "utf8",
);
const backupTimer = readFileSync(
  new URL("../deploy/systemd/gatekeeper-backup.timer", import.meta.url),
  "utf8",
);

test("nftables policy covers host input and Docker forwarded ports", () => {
  assert.match(template, /hook input/);
  assert.match(template, /hook forward/);
  assert.match(template, /ct original proto-dst @protected_tcp_ports/);
  assert.match(template, /ct original proto-dst @protected_udp_ports/);
  assert.doesNotMatch(template, /elements\s*=\s*\{\s*\}/);
  assert.doesNotMatch(template, /elements\s*=\s*\{[^}\n]*;\s*}/);
  assert.match(template, /type ipv6_addr;/);
  assert.match(template, /flags interval;/);
  assert.match(template, /__INITIAL_IPV6_ELEMENTS__/);
  assert.match(template, /__INITIAL_UDP_PORT_ELEMENTS__/);
});

test("nftables renderer places semicolons outside populated sets", () => {
  const script = fileURLToPath(
    new URL("../scripts/render-nftables.sh", import.meta.url),
  );
  const templatePath = fileURLToPath(
    new URL("../deploy/nftables/gatekeeper.nft.template", import.meta.url),
  );
  const rendered = execFileSync(
    script,
    [templatePath, "39.182.168.0/24", "", "6900, 7000-65535", ""],
    { encoding: "utf8" },
  );

  assert.match(rendered, /elements = \{ 39\.182\.168\.0\/24 \};/);
  assert.match(rendered, /elements = \{ 6900, 7000-65535 \};/);
  assert.doesNotMatch(rendered, /elements\s*=\s*\{[^}\n]*;\s*}/);
  assert.doesNotMatch(rendered, /elements\s*=\s*\{\s*\}/);
  assert.doesNotMatch(rendered, /__INITIAL_/);
});

test("systemd sync service requires the firewall and supports custom paths", () => {
  assert.match(syncService, /Requires=gatekeeper-firewall\.service/);
  assert.match(
    syncService,
    /ExecStart=__INSTALL_DIR__\/scripts\/sync-nftables\.sh/,
  );
  assert.match(listenerService, /Requires=gatekeeper-firewall\.service/);
  assert.match(listenerService, /Restart=always/);
  assert.match(
    listenerService,
    /ExecStart=__INSTALL_DIR__\/scripts\/watch-firewall\.sh/,
  );
  assert.match(watcher, /firewall-revision\?since=/);
  assert.match(watcher, /sync-nftables\.sh/);
  assert.match(installer, /enable --now gatekeeper-sync-listener\.service/);
  assert.match(updater, /enable --now gatekeeper-sync-listener\.service/);
  assert.match(syncScript, /api\/internal\/firewall-status/);
});

test("deployment installs validated off-volume backups and restore tooling", () => {
  assert.match(backupScript, /VACUUM INTO/);
  assert.doesNotMatch(backupScript, /\$\{path\}/);
  assert.match(backupScript, /PRAGMA quick_check/);
  assert.match(backupScript, /\/var\/backups\/gatekeeper/);
  assert.match(restoreScript, /sqlite3 .*PRAGMA quick_check/);
  assert.match(backupTimer, /OnCalendar=/);
  assert.match(installer, /gatekeeper-backup\.timer/);
  assert.match(updater, /gatekeeper-backup\.timer/);
});

test("updater bypasses source caches and verifies the running version", () => {
  assert.match(updater, /Cache-Control: no-cache/);
  assert.match(updater, /--force-recreate gatekeeper/);
  assert.match(updater, /--force-recreate caddy/);
  assert.match(updater, /EXPECTED_VERSION/);
  assert.match(updater, /DEPLOYED_VERSION/);
  assert.match(updater, /版本校验失败/);
  assert.match(updater, /公网域名版本校验通过/);
});

test("nftables installer validates then atomically writes the config", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gatekeeper-nft-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fakeBin = join(directory, "bin");
  const output = join(directory, "config", "gatekeeper.nft");
  const installScript = fileURLToPath(
    new URL("../scripts/install-nftables-config.sh", import.meta.url),
  );
  const templatePath = fileURLToPath(
    new URL("../deploy/nftables/gatekeeper.nft.template", import.meta.url),
  );
  mkdirSync(fakeBin, { recursive: true });
  const fakeNft = join(fakeBin, "nft");
  writeFileSync(fakeNft, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeNft, 0o755);

  execFileSync(
    installScript,
    [templatePath, output, "203.0.113.0/24", "", "6900", ""],
    { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } },
  );
  const installed = readFileSync(output, "utf8");
  assert.match(installed, /elements = \{ 203\.0\.113\.0\/24 \};/);
  assert.match(installed, /elements = \{ 6900 \};/);
  assert.doesNotMatch(installed, /__INITIAL_/);
});
