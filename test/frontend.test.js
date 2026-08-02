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
