#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { homedir, hostname, platform, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../codex/json-rpc-client.js";
import { SqliteLocalImageStore } from "../codex/local-image-store.js";
import { SqliteApprovalJournal } from "../reliability/sqlite-approval-journal.js";
import { SqliteCommandJournal } from "../reliability/sqlite-command-journal.js";
import { SqliteDecisionLedger } from "../reliability/sqlite-decision-ledger.js";
import { ConnectorCloudClient } from "../transport/connector-cloud-client.js";
import { SqliteMessageStore } from "../transport/sqlite-message-store.js";
import { ConnectorRuntime } from "./runtime.js";
import { loadConnectorConfig, runSetup } from "./setup.js";
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

  let runtime: ConnectorRuntime | undefined;
  const codex = new CodexAppServerClient({
    command: process.env.CODEX_COMMAND ?? "codex",
    cwd: process.env.YURUPAGER_PROJECT_PATH ?? process.cwd(),
    onServerResponseWritten(request) {
      runtime?.markCodexResponseWritten(request);
    },
  });
  const runtimeOptions = {
    cloud,
    codex,
    journal,
    commands,
    decisions,
    media,
    codexCommand: process.env.CODEX_COMMAND ?? "codex",
    workstationName: process.env.YURUPAGER_WORKSTATION_NAME ?? hostname(),
    platform: `${platform()} ${release()} / ${process.arch}`,
    connectorVersion: "0.2.0-alpha",
    projectName: process.env.YURUPAGER_PROJECT_NAME ?? "Codex workspace",
    projectPath: process.env.YURUPAGER_PROJECT_PATH ?? process.cwd(),
    model: process.env.YURUPAGER_MODEL ?? "gpt-5.6-codex",
  };
  const initiatedByEmail = process.env.YURUPAGER_INITIATOR_EMAIL;
  runtime = new ConnectorRuntime(
    initiatedByEmail === undefined ? runtimeOptions : { ...runtimeOptions, initiatedByEmail },
  );

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
