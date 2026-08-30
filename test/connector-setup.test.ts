import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  connectorWebSocketUrl,
  loadConnectorConfig,
  normalizeServerUrl,
  previewWebSocketUrl,
  runSetup,
} from "../src/connector/setup.js";

test("setup stores an approved device credential with private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-setup-"));
  const output: string[] = [];
  const token = "ypd_test-secret-that-must-not-be-logged";
  let requests = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    requests += 1;
    const url = String(input);
    if (url.endsWith("/claim")) {
      return jsonResponse({
        pairingId: "pairing-1",
        status: "pending_approval",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, 202);
    }
    return jsonResponse({
      pairingId: "pairing-1",
      status: "approved",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      workspaceId: "workspace-1",
      workstationId: "workstation-1",
      connectorToken: token,
    });
  }) as typeof fetch;

  try {
    const config = await runSetup({
      serverUrl: "https://pager.example/yurupager",
      pairCode: "ABCD-EFGH-JKLM",
      dataDirectory: directory,
      installService: false,
      entryPath: "/opt/yurupager/main.js",
      pollIntervalMs: 0,
      fetchImpl,
      output: (message) => output.push(message),
    });
    assert.equal(requests, 2);
    assert.equal(config.token, token);
    assert.equal(config.cloudWebSocketUrl, "wss://pager.example/yurupager/connector/v1/ws");
    assert.deepEqual(await loadConnectorConfig(join(directory, "config.json")), config);
    assert.equal((await stat(join(directory, "config.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "device-key.pem"))).mode & 0o777, 0o600);
    assert.match(await readFile(join(directory, "device-public-key.pem"), "utf8"), /BEGIN PUBLIC KEY/);
    assert.equal(output.join("\n").includes(token), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup URL helpers preserve a deployment base path and require TLS", () => {
  assert.equal(normalizeServerUrl("https://pager.example/yurupager"), "https://pager.example/yurupager/");
  assert.equal(connectorWebSocketUrl("http://127.0.0.1:4300/"), "ws://127.0.0.1:4300/connector/v1/ws");
  assert.equal(previewWebSocketUrl("https://pager.example/yurupager"), "wss://pager.example/yurupager/connector/v1/preview/ws");
  assert.throws(() => normalizeServerUrl("http://pager.example/"), /HTTPS/);
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
