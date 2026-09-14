import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCodexVersion } from "../src/connector/version-gate.js";

test("accepts each Codex minor with a verified Alpha contract", () => {
  assert.equal(parseCodexVersion("codex-cli 0.145.0").supported, true);
  assert.equal(parseCodexVersion("codex-cli 0.146.0-alpha.9.2").supported, true);
  assert.equal(parseCodexVersion("codex-cli 0.147.0-alpha.1.2").supported, true);
  assert.equal(parseCodexVersion("codex-cli 0.148.0-alpha.9").supported, true);
  assert.equal(parseCodexVersion("codex-cli 0.154.0-alpha.6.2").supported, true);
});

test("fails closed outside the verified Codex minor window", () => {
  assert.equal(parseCodexVersion("codex-cli 0.144.9").supported, false);
  assert.equal(parseCodexVersion("codex-cli 0.149.0-alpha.1").supported, false);
  assert.equal(parseCodexVersion("codex-cli 1.145.0").supported, false);
});

test("rejects output without a Codex version", () => {
  assert.throws(
    () => parseCodexVersion("codex-cli unknown"),
    /Unable to parse Codex version/,
  );
});
