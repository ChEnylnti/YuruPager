import { test } from "node:test";

import { FakeAgentRuntime } from "../src/agents/testing/fake-agent-runtime.js";
import {
  createRecordingSink,
  registerAgentRuntimeContractTests,
} from "../src/agents/testing/agent-runtime-contract.js";

registerAgentRuntimeContractTests({
  test: (name, fn) => test(name, fn),
  createRuntime: (scenario) => {
    const sink = createRecordingSink();
    const runtime = new FakeAgentRuntime({
      agentId: "fake-acp",
      args: ["--scenario", scenario],
      requestTimeoutMs: 10_000,
    });
    runtime.attach(sink);
    return { runtime, sink };
  },
});
