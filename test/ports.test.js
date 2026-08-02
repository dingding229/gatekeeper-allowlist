import test from "node:test";
import assert from "node:assert/strict";
import { parsePortRanges } from "../src/ports.js";

test("port ranges are validated, sorted, and merged", () => {
  assert.deepEqual(parsePortRanges("443, 22, 8000-9000, 8500-9100"), [
    "22",
    "443",
    "8000-9100",
  ]);
  assert.throws(() => parsePortRanges("0,70000"), /Invalid port range/);
  assert.throws(() => parsePortRanges("9000-8000"), /Invalid port range/);
});
