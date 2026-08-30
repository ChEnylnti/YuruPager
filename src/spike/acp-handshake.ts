// ACP handshake spike (ADR-024/027). Verifies the AcpAgentRuntime handshake
// and capability probe outside the test runner.
//
// Default target is the bundled fake ACP agent, so this spike is always
// runnable. Pass `--command <bin> --args "<args>"` to probe a real agent,
// e.g. `npm run spike:acp-handshake -- --command gemini --args "--acp"`.

import { fileURLToPath } from "node:url";

import { AcpAgentRuntime } from "../agents/acp/acp-agent-runtime.js";
import { createRecordingSink } from "../agents/testing/agent-runtime-contract.js";

function readArgument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const command = readArgument(args, "--command");
const rawArgs = readArgument(args, "--args");
const fakeScript = fileURLToPath(new URL("../agents/testing/fake-acp-agent.js", import.meta.url));
const target = command === undefined
  ? "bundled fake ACP agent"
  : `${command} ${rawArgs ?? ""}`.trim();

const options = command === undefined
  ? {
      command: process.execPath,
      args: [fakeScript, "--scenario", "standard"],
      projectName: "ACP Handshake Spike",
      projectPath: process.cwd(),
      requestTimeoutMs: 45_000,
    }
  : {
      command,
      args: rawArgs === undefined ? [] : rawArgs.split(" ").filter((part) => part.length > 0),
      projectName: "ACP Handshake Spike",
      projectPath: process.cwd(),
      requestTimeoutMs: 45_000,
    };

const sink = createRecordingSink();
const runtime = new AcpAgentRuntime(options);
runtime.attach(sink);

try {
  await runtime.start();
  const capabilities = await runtime.capabilities();
  const discovered = await runtime.listSessions();
  process.stdout.write(`${JSON.stringify({
    spike: "acp-handshake",
    target,
    initialized: true,
    agentId: capabilities.agentId,
    displayName: capabilities.displayName,
    discovery: capabilities.discovery,
    globalDiscovery: discovered === null ? "none (own sessions only)" : discovered.sessions.length,
    usageReporting: capabilities.usageReporting,
  }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    spike: "acp-handshake",
    target,
    initialized: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await runtime.stop();
}
