import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface RuntimeSpec {
  name: string;
  command: string;
  prefixArgs: string[];
  mustBeCompatible: boolean;
}

interface ContractReport {
  name: string;
  version: string;
  schemaGenerated: boolean;
  compatible: boolean;
  missingMethods: string[];
  missingFields: string[];
}

const REQUIRED_CLIENT_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/delete",
  "turn/start",
  "turn/interrupt",
];
const REQUIRED_SERVER_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
];
const REQUIRED_NOTIFICATION_METHODS = [
  "error",
  "serverRequest/resolved",
  "thread/tokenUsage/updated",
  "turn/completed",
];
const REQUIRED_FILE_FIELDS: Readonly<Record<string, string[]>> = {
  "CommandExecutionRequestApprovalParams.json": [
    "itemId",
    "startedAtMs",
    "threadId",
    "turnId",
  ],
  "FileChangeRequestApprovalParams.json": [
    "itemId",
    "startedAtMs",
    "threadId",
    "turnId",
  ],
  "PermissionsRequestApprovalParams.json": [
    "cwd",
    "itemId",
    "permissions",
    "startedAtMs",
    "threadId",
    "turnId",
  ],
  "PermissionsRequestApprovalResponse.json": ["permissions", "scope"],
  "v2/ThreadTokenUsageUpdatedNotification.json": [
    "cachedInputTokens",
    "inputTokens",
    "last",
    "modelContextWindow",
    "outputTokens",
    "reasoningOutputTokens",
    "threadId",
    "tokenUsage",
    "total",
    "totalTokens",
    "turnId",
  ],
};

const runtimes: RuntimeSpec[] = [
  {
    name: "npm-baseline",
    command: "npx",
    prefixArgs: ["--yes", "@openai/codex@0.145.0"],
    mustBeCompatible: false,
  },
  {
    name: "active-codex",
    command: process.env.CODEX_COMMAND ?? "codex",
    prefixArgs: [],
    mustBeCompatible: true,
  },
];

const reports: ContractReport[] = [];
for (const runtime of runtimes) {
  reports.push(await inspectRuntime(runtime));
}

const requiredRuntimeReports = reports.filter((_report, index) =>
  runtimes[index]?.mustBeCompatible === true,
);
const result = {
  passed:
    reports.length >= 2 &&
    reports.every((report) => report.schemaGenerated) &&
    requiredRuntimeReports.every((report) => report.compatible),
  experimentCompleted: true,
  supportConclusion: deriveSupportConclusion(reports),
  reports,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) {
  process.exitCode = 1;
}

async function inspectRuntime(runtime: RuntimeSpec): Promise<ContractReport> {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-contract-"));
  try {
    const version = (
      await run(runtime.command, [...runtime.prefixArgs, "--version"], 60_000)
    ).trim();
    await run(
      runtime.command,
      [
        ...runtime.prefixArgs,
        "app-server",
        "generate-json-schema",
        "--experimental",
        "--out",
        directory,
      ],
      120_000,
    );

    const clientMethods = await readMethods(join(directory, "ClientRequest.json"));
    const serverMethods = await readMethods(join(directory, "ServerRequest.json"));
    const notificationMethods = await readMethods(
      join(directory, "ServerNotification.json"),
    );
    const missingMethods = [
      ...missing(REQUIRED_CLIENT_METHODS, clientMethods),
      ...missing(REQUIRED_SERVER_METHODS, serverMethods),
      ...missing(REQUIRED_NOTIFICATION_METHODS, notificationMethods),
    ];
    const missingFields: string[] = [];
    for (const [file, fields] of Object.entries(REQUIRED_FILE_FIELDS)) {
      let schema: unknown;
      try {
        schema = JSON.parse(await readFile(join(directory, file), "utf8"));
      } catch {
        missingFields.push(`${file}:<file>`);
        continue;
      }
      for (const field of fields) {
        if (!containsProperty(schema, field)) {
          missingFields.push(`${file}:${field}`);
        }
      }
    }
    return {
      name: runtime.name,
      version,
      schemaGenerated: true,
      compatible: missingMethods.length === 0 && missingFields.length === 0,
      missingMethods,
      missingFields,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readMethods(path: string): Promise<Set<string>> {
  const schema: unknown = JSON.parse(await readFile(path, "utf8"));
  const methods = new Set<string>();
  visit(schema, (value) => {
    if (
      isRecord(value) &&
      isRecord(value.method) &&
      Array.isArray(value.method.enum)
    ) {
      for (const method of value.method.enum) {
        if (typeof method === "string") {
          methods.add(method);
        }
      }
    }
  });
  return methods;
}

function containsProperty(value: unknown, property: string): boolean {
  let found = false;
  visit(value, (candidate) => {
    if (
      !found &&
      isRecord(candidate) &&
      isRecord(candidate.properties) &&
      property in candidate.properties
    ) {
      found = true;
    }
  });
  return found;
}

function visit(value: unknown, visitor: (value: unknown) => void): void {
  visitor(value);
  if (Array.isArray(value)) {
    for (const child of value) {
      visit(child, visitor);
    }
    return;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      visit(child, visitor);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missing(required: string[], actual: Set<string>): string[] {
  return required.filter((method) => !actual.has(method));
}

function deriveSupportConclusion(reports: ContractReport[]): string {
  const active = reports.find((report) => report.name === "active-codex");
  const baseline = reports.find((report) => report.name === "npm-baseline");
  if (active?.compatible !== true) {
    return "active_codex_does_not_meet_mvp_contract";
  }
  if (baseline?.compatible === true) {
    return "both_tested_versions_meet_mvp_contract";
  }
  return "baseline_requires_capability_degradation_or_minimum_version_gate";
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${String(timeoutMs)}ms`));
      } else if (code !== 0) {
        reject(
          new Error(
            `${command} failed (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
          ),
        );
      } else {
        resolve(stdout);
      }
    });
  });
}
