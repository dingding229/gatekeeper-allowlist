import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const renderSource = readFileSync(
  new URL("../public/js/render.js", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../public/styles.css", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../public/js/app.js", import.meta.url),
  "utf8",
);
const firewallSource = readFileSync(
  new URL("../public/js/firewall.js", import.meta.url),
  "utf8",
);
const historySource = readFileSync(
  new URL("../public/js/history.js", import.meta.url),
  "utf8",
);

test("device rows use the same table format as network rows", () => {
  assert.match(renderSource, /ip-table device-table/);
  assert.match(renderSource, /device, index/);
  assert.match(renderSource, /加入.*device\.first_seen_at/s);
  assert.match(renderSource, /最近.*device\.last_seen_at/s);
  assert.match(renderSource, /device-id/);
  assert.doesNotMatch(renderSource, /device_key\.slice/);
  assert.match(styles, /\.ip-table\s*\{[^}]*table-layout:\s*fixed/s);
  assert.match(styles, /\.device-id\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test("network and device sections both expose current usage headings", () => {
  assert.match(
    renderSource,
    /已放行网段（\$\{ips\.length\}\/\$\{user\.ip_limit\}）/,
  );
  assert.match(
    renderSource,
    /已识别设备（\$\{devices\.length\}\/\$\{user\.device_limit\}）/,
  );
});

test("firewall configuration is an independent lazy-loaded page", () => {
  assert.match(pageSource, /data-tab="firewall"/);
  assert.match(pageSource, /id="firewallTab"/);
  assert.match(pageSource, /id="settingsTab"/);
  assert.match(
    appSource,
    /tab === "firewall"[\s\S]*state\.applicationSettings[\s\S]*!firewallController\.isLoaded\(\)/,
  );
  assert.match(firewallSource, /api\/admin\/firewall-config/);
  assert.match(firewallSource, /目标 revision/);
  assert.match(firewallSource, /实际报告/);
});

test("history event rendering is isolated from dashboard rendering", () => {
  assert.doesNotMatch(renderSource, /renderHistory/);
  assert.match(historySource, /reported: "已上报"/);
  assert.match(historySource, /added: "新增"/);
  assert.match(historySource, /removed: "已删除"/);
  assert.match(historySource, /evicted: "自动淘汰"/);
});
