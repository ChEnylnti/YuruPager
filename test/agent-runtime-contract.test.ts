import { test } from "node:test";

import { AcpAgentRuntime } from "../src/agents/acp/acp-agent-runtime.js";
import {
  createRecordingSink,
  registerAgentRuntimeContractTests,
} from "../src/agents/testing/agent-runtime-contract.js";

registerAgentRuntimeContractTests({
  test: (name, fn) => test(name, fn),
  createRuntime: (scenario) => {
    const sink = createRecordingSink();
    const runtime = new AcpAgentRuntime({
      command: process.execPath,
      args: [fakeAgentScript(), "--scenario", scenario],
      projectName: "Contract Suite",
      projectPath: process.cwd(),
      requestTimeoutMs: 10_000,
    });
    runtime.attach(sink);
    return { runtime, sink };
  },
});

function fakeAgentScript(): string {
  return new URL("../src/agents/testing/fake-acp-agent.js", import.meta.url).pathname;
}
