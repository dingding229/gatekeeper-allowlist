import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const template = readFileSync(
  new URL("../deploy/nftables/gatekeeper.nft.template", import.meta.url),
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
