#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { homedir, hostname, platform, release } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentRuntime } from "../agents/types.js";

import { CodexAppServerClient } from "../codex/json-rpc-client.js";
import { SqliteLocalImageStore } from "../codex/local-image-store.js";
import { SqliteApprovalJournal } from "../reliability/sqlite-approval-journal.js";
import { SqliteCommandJournal } from "../reliability/sqlite-command-journal.js";
import { SqliteDecisionLedger } from "../reliability/sqlite-decision-ledger.js";
import { ConnectorCloudClient } from "../transport/connector-cloud-client.js";
import { SqliteMessageStore } from "../transport/sqlite-message-store.js";
import { AcpAgentRuntime } from "../agents/acp/acp-agent-runtime.js";
import { CursorAgentRuntime } from "../agents/cursor/cursor-agent-runtime.js";
import { ZcodeAgentRuntime } from "../agents/zcode/zcode-agent-runtime.js";
import { resolveAgentPreset } from "../agents/agent-presets.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { MultiAgentRuntime } from "./multi-agent-runtime.js";
import { ConnectorRuntime } from "./runtime.js";
import { codexAgentConfig, loadConnectorConfig, resolveConnectorAgents, runSetup } from "./setup.js";
import { startPreview } from "../preview/command.js";
import { connectorHelp, isHelpRequest, previewHelp } from "./help.js";

const dataDirectory = process.env.YURUPAGER_DATA_DIR ?? join(homedir(), ".yurupager");
const configPath = process.env.YURUPAGER_CONFIG_FILE ?? join(dataDirectory, "config.json");
const [command, ...args] = process.argv.slice(2);

if (command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(connectorHelp());
} else if (command === "setup" && isHelpRequest(args)) {
  process.stdout.write(connectorHelp());
} else if (command === "setup") {
  const pairCode = readArgument(args, "--pair");
  const serverUrl = readArgument(args, "--server");
  await runSetup({
    pairCode,
    serverUrl,
    dataDirectory,
    installService: !args.includes("--no-install"),
    entryPath: fileURLToPath(import.meta.url),
  });
} else if (command === "preview" && isHelpRequest(args)) {
  process.stdout.write(previewHelp());
} else if (command === "preview") {
  const preview = await startPreview({ args, configPath });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\n正在停止预览...\n");
    await preview.stop();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await preview.finished;
} else if (command === undefined || command === "start") {
  await startConnector();
} else {
  throw new Error(`未知命令：${command}`);
}

async function startConnector(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux" && process.env.YURUPAGER_ALLOW_UNSUPPORTED_PLATFORM !== "1") {
    throw new Error("YuruPager Connector currently supports macOS and Linux");
  }
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const config = await loadConnectorConfig(configPath);
  const token = process.env.YURUPAGER_CONNECTOR_TOKEN ?? config?.token;
  if (token === undefined || token.length < 16) {
    throw new Error("Connector 尚未配对。请从 YuruPager Web 复制配对命令并执行");
  }

  const store = new SqliteMessageStore(join(dataDirectory, "transport.sqlite"));
  const journal = new SqliteApprovalJournal(join(dataDirectory, "approval-journal.sqlite"));
  const commands = new SqliteCommandJournal(join(dataDirectory, "command-journal.sqlite"));
  const decisions = new SqliteDecisionLedger(join(dataDirectory, "decisions.sqlite"));
  const media = new SqliteLocalImageStore(
    join(dataDirectory, "image-manifest.sqlite"),
    join(dataDirectory, "images"),
  );
  const cloud = new ConnectorCloudClient({
    url: process.env.YURUPAGER_CLOUD_WS ?? config?.cloudWebSocketUrl ?? "ws://127.0.0.1:4300/connector/v1/ws",
    token,
    store,
  });

  const agentConfigs = (config === null
    ? [codexAgentConfig()]
    : resolveConnectorAgents(config)
  ).map((agent) => (
    agent.kind === "codex" && process.env.CODEX_COMMAND !== undefined
      ? { ...agent, command: process.env.CODEX_COMMAND }
      : agent
  ));
  const projectPath = process.env.YURUPAGER_PROJECT_PATH ?? process.cwd();
  const projectBasename = basename(projectPath) || "workspace";
  const runtimes: AgentRuntime[] = [];
  let codexRuntime: ConnectorRuntime | undefined;
  for (const agent of agentConfigs) {
    if (agent.kind === "codex") {
      const codex = new CodexAppServerClient({
        command: agent.command,
        cwd: projectPath,
        onServerResponseWritten(request) {
          codexRuntime?.markCodexResponseWritten(request);
        },
      });
      const runtimeOptions = {
        cloud,
        agentId: "codex",
        codex,
        journal,
        commands,
        decisions,
        media,
        registerCloudHandlers: false,
        codexCommand: agent.command,
        workstationName: process.env.YURUPAGER_WORKSTATION_NAME ?? hostname(),
        platform: `${platform()} ${release()} / ${process.arch}`,
        connectorVersion: "0.2.0-alpha",
        projectName: process.env.YURUPAGER_PROJECT_NAME ?? "Codex workspace",
        projectPath,
        model: process.env.YURUPAGER_MODEL ?? "gpt-5.6-codex",
      };
      const initiatedByEmail = process.env.YURUPAGER_INITIATOR_EMAIL;
      codexRuntime = new ConnectorRuntime(
        initiatedByEmail === undefined ? runtimeOptions : { ...runtimeOptions, initiatedByEmail },
      );
      runtimes.push(codexRuntime);
      continue;
    }
    if (agent.kind === "acp" || resolveAgentPreset(agent.kind)?.runtime === "acp") {
      const preset = resolveAgentPreset(agent.kind);
      const command = agent.command.length > 0 ? agent.command : preset?.command ?? "";
      if (command.length === 0) {
        throw new Error(`配置的 agent ${agent.kind} 未提供 command，且没有可用的预设`);
      }
      const acp = new AcpAgentRuntime({
        agentId: agent.kind,
        command,
        args: (agent.args ?? []).length > 0 ? agent.args ?? [] : preset?.args ?? [],
        cwd: projectPath,
        projectName: projectBasename,
        projectPath,
        sessionStorePath: join(dataDirectory, "agent-sessions.sqlite"),
      });
      runtimes.push(acp);
      continue;
    }
    if (agent.kind === "zcode" || resolveAgentPreset(agent.kind)?.runtime === "zcode") {
      const preset = resolveAgentPreset(agent.kind);
      const command = agent.command.length > 0
        ? agent.command
        : process.env.ZCODE_COMMAND ?? preset?.command ?? "zcode";
      const mode = process.env.ZCODE_MODE === "edit" ? "edit" : "build";
      runtimes.push(new ZcodeAgentRuntime({
        agentId: agent.kind,
        command,
        args: agent.args ?? [],
        cwd: projectPath,
        projectName: projectBasename,
        projectPath,
        sessionStorePath: join(dataDirectory, "agent-sessions.sqlite"),
        mode,
      }));
      continue;
    }
    if (agent.kind === "cursor") {
      const cursor = new CursorAgentRuntime({
        command: agent.command.length > 0 ? agent.command : "cursor-agent",
        args: agent.args ?? [],
        cwd: projectPath,
        projectName: projectBasename,
        projectPath,
        sessionStorePath: join(dataDirectory, "agent-sessions.sqlite"),
      });
      runtimes.push(cursor);
      continue;
    }
    throw new Error(`配置包含尚未支持的 agent 类型：${agent.kind}`);
  }
  if (runtimes.length === 0) throw new Error("配置未启用任何 agent");
  const runtimeById = new Map<string, AgentRuntime>();
  for (const agentRuntime of runtimes) runtimeById.set(agentRuntime.agentId, agentRuntime);
  const workflowEngine = new WorkflowEngine({
    cloud,
    resolveRuntime: (agentKind) => runtimeById.get(agentKind),
    journalPath: join(dataDirectory, "workflow-runs.sqlite"),
  });
  const runtime = new MultiAgentRuntime({ cloud, agents: runtimes, workflowEngine });

  const shutdown = async () => {
    await runtime?.stop();
    journal.close();
    commands.close();
    decisions.close();
    media.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await runtime.start();
  process.stdout.write(`YuruPager Connector online for ${process.env.YURUPAGER_PROJECT_PATH ?? process.cwd()}\n`);
}

function readArgument(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return value;
}
