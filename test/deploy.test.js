import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const template = readFileSync(
  new URL("../deploy/nftables/gatekeeper.nft.template", import.meta.url),
  "utf8",
);

test("nftables policy covers host input and Docker forwarded ports", () => {
  assert.match(template, /hook input/);
  assert.match(template, /hook forward/);
  assert.match(template, /ct original proto-dst @protected_tcp_ports/);
  assert.match(template, /ct original proto-dst @protected_udp_ports/);
});
