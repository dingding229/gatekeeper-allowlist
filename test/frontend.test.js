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

test("device rows expose complete IDs and reserve a removal column", () => {
  assert.match(renderSource, /audit-row device-row/);
  assert.match(renderSource, /device-id/);
  assert.doesNotMatch(renderSource, /device_key\.slice/);
  assert.match(
    styles,
    /\.device-row\s*\{[^}]*grid-template-columns:\s*minmax\(130px, 170px\)\s+minmax\(0, 1fr\)\s+140px\s+max-content/s,
  );
  assert.match(styles, /\.device-row\s*\{[^}]*padding-left:\s*73px/s);
  assert.match(styles, /\.ip-table\s*\{[^}]*table-layout:\s*fixed/s);
  assert.match(styles, /\.device-id\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(
    styles,
    /\.device-row \.danger-link\s*\{[^}]*white-space:\s*nowrap/s,
  );
});
