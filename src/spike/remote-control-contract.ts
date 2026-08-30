import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isRecord } from "../codex/guards.js";
import { CodexAppServerClient } from "../codex/json-rpc-client.js";

const execFileAsync = promisify(execFile);

export const REQUIRED_REMOTE_CONTROL_METHODS = [
  "remoteControl/enable",
  "remoteControl/disable",
  "remoteControl/status/read",
  "remoteControl/pairing/start",
  "remoteControl/pairing/status",
  "remoteControl/client/list",
  "remoteControl/client/revoke",
] as const;

export const REQUIRED_REMOTE_CONTROL_NOTIFICATION =
  "remoteControl/status/changed";

export const REQUIRED_PAIRING_RESPONSE_FIELDS = [
  "environmentId",
  "expiresAt",
  "pairingCode",
] as const;

export const REQUIRED_CLIENT_FIELDS = [
  "clientId",
  "displayName",
  "deviceType",
  "lastSeenAt",
  "platform",
] as const;

export const REQUIRED_STATUS_VALUES = [
  "disabled",
  "connecting",
  "connected",
  "errored",
] as const;

export interface RemoteControlSchemaAnalysis {
  methods: string[];
  notifications: string[];
  pairingResponseFields: string[];
  clientFields: string[];
  statusValues: string[];
  missingMethods: string[];
  missingNotifications: string[];
  missingPairingResponseFields: string[];
  missingClientFields: string[];
  missingStatusValues: string[];
  compatible: boolean;
}

export interface RemoteControlContractReport extends RemoteControlSchemaAnalysis {
  scope: "standalone_cli";
  command: string;
  version: string | null;
  remoteControlHelp: boolean;
  pairingHelp: boolean;
  schemaGenerated: boolean;
  experimental: true;
  error?: string;
}

export interface LocalRemoteControlStatusReport {
  scope: "fresh_local_app_server";
  attempted: true;
  reachable: boolean;
  status: string | null;
  environmentIdPresent: boolean;
  fields: string[];
  error?: string;
}

/**
 * Analyze schemas emitted by the standalone Codex CLI without making a
 * remote-control connection. This intentionally does not attach to the
 * first-party Codex Desktop remote-control process.
 */
export function analyzeRemoteControlSchemas(
  schemas: Readonly<Record<string, unknown>>,
): RemoteControlSchemaAnalysis {
  const clientRequest = schemas["ClientRequest.json"];
  const serverNotification = schemas["ServerNotification.json"];
  const pairingResponse = schemas["v2/RemoteControlPairingStartResponse.json"];
  const clientsResponse = schemas["v2/RemoteControlClientsListResponse.json"];
  const statusResponse = schemas["v2/RemoteControlStatusReadResponse.json"];

  const methods = [...collectMethods(clientRequest)]
    .filter((method) => method.startsWith("remoteControl/"))
    .sort();
  const notifications = [...collectMethods(serverNotification)]
    .filter((method) => method.startsWith("remoteControl/"))
    .sort();
  const pairingResponseFields = [...collectProperties(pairingResponse)].sort();
  const clientFields = [...collectProperties(clientsResponse)].sort();
  const statusValues = [...collectEnumValues(statusResponse, "status")].sort();

  const missingMethods = missing(REQUIRED_REMOTE_CONTROL_METHODS, methods);
  const missingNotifications = missing(
    [REQUIRED_REMOTE_CONTROL_NOTIFICATION],
    notifications,
  );
  const missingPairingResponseFields = missing(
    REQUIRED_PAIRING_RESPONSE_FIELDS,
    pairingResponseFields,
  );
  const missingClientFields = missing(REQUIRED_CLIENT_FIELDS, clientFields);
  const missingStatusValues = missing(REQUIRED_STATUS_VALUES, statusValues);

  return {
    methods,
    notifications,
    pairingResponseFields,
    clientFields,
    statusValues,
    missingMethods,
    missingNotifications,
    missingPairingResponseFields,
    missingClientFields,
    missingStatusValues,
    compatible:
      missingMethods.length === 0 &&
      missingNotifications.length === 0 &&
      missingPairingResponseFields.length === 0 &&
      missingClientFields.length === 0 &&
      missingStatusValues.length === 0,
  };
}

export async function inspectRemoteControlContract(
  command = process.env.CODEX_COMMAND ?? "codex",
): Promise<RemoteControlContractReport> {
  const reportBase = {
    scope: "standalone_cli" as const,
    command,
    version: null,
    remoteControlHelp: false,
    pairingHelp: false,
    schemaGenerated: false,
    experimental: true as const,
  };
  const directory = await mkdtemp(join(tmpdir(), "yurupager-remote-control-"));
  try {
    const versionResult = await run(command, ["--version"]);
    const version = versionResult.ok ? versionResult.stdout.trim() : null;
    const remoteControlResult = await run(command, ["remote-control", "--help"]);
    const pairingResult = await run(command, [
      "remote-control",
      "pair",
      "--help",
    ]);
    const schemaResult = await run(command, [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      directory,
    ], 120_000);

    if (!schemaResult.ok) {
      return {
        ...reportBase,
        version,
        remoteControlHelp: hasRemoteControlCommands(remoteControlResult),
        pairingHelp: hasPairingHelp(pairingResult),
        error: schemaResult.error,
        ...emptyAnalysis(),
      };
    }

    const schemas = await readSchemaBundle(directory);
    return {
      ...reportBase,
      version,
      remoteControlHelp: hasRemoteControlCommands(remoteControlResult),
      pairingHelp: hasPairingHelp(pairingResult),
      schemaGenerated: true,
      ...analyzeRemoteControlSchemas(schemas),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Call only the read-only status method on a fresh local app-server process.
 * This does not enable remote control, start a turn, create a pairing code, or
 * inspect the first-party Codex Desktop remote-control process.
 */
export async function probeLocalRemoteControlStatus(
  command = process.env.CODEX_COMMAND ?? "codex",
): Promise<LocalRemoteControlStatusReport> {
  const client = new CodexAppServerClient({
    command,
    args: ["app-server", "--stdio"],
    requestTimeoutMs: 15_000,
  });
  try {
    await client.start();
    await client.initialize({
      name: "yurupager-remote-control-status-spike",
      version: "0.0.1",
    });
    const response = await client.request<unknown>(
      "remoteControl/status/read",
      null,
    );
    return summarizeRemoteControlStatus(response);
  } catch (error: unknown) {
    return {
      scope: "fresh_local_app_server",
      attempted: true,
      reachable: false,
      status: null,
      environmentIdPresent: false,
      fields: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.stop();
  }
}

export function summarizeRemoteControlStatus(
  response: unknown,
): LocalRemoteControlStatusReport {
  if (!isRecord(response)) {
    return {
      scope: "fresh_local_app_server",
      attempted: true,
      reachable: true,
      status: null,
      environmentIdPresent: false,
      fields: [],
      error: "remoteControl/status/read returned a non-object response",
    };
  }
  return {
    scope: "fresh_local_app_server",
    attempted: true,
    reachable: true,
    status: typeof response.status === "string" ? response.status : null,
    environmentIdPresent: typeof response.environmentId === "string",
    fields: Object.keys(response).sort(),
  };
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = await inspectRemoteControlContract();
  const localStatus = process.argv.includes("--local-status")
    ? await probeLocalRemoteControlStatus()
    : undefined;
  process.stdout.write(
    `${JSON.stringify(
      localStatus === undefined ? report : { ...report, localStatus },
      null,
      2,
    )}\n`,
  );
  if (
    !report.compatible ||
    !report.remoteControlHelp ||
    !report.pairingHelp ||
    (localStatus !== undefined && !localStatus.reachable)
  ) {
    process.exitCode = 1;
  }
}

async function readSchemaBundle(
  directory: string,
): Promise<Record<string, unknown>> {
  const files = [
    "ClientRequest.json",
    "ServerNotification.json",
    "v2/RemoteControlPairingStartResponse.json",
    "v2/RemoteControlClientsListResponse.json",
    "v2/RemoteControlStatusReadResponse.json",
  ];
  const entries = await Promise.all(
    files.map(async (file) => {
      try {
        const content = await readFile(join(directory, file), "utf8");
        return [file, JSON.parse(content) as unknown] as const;
      } catch {
        return [file, undefined] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

async function run(
  command: string,
  args: string[],
  timeout = 30_000,
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string }> {
  try {
    const result = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    if (isRecord(error)) {
      const message =
        typeof error.message === "string" ? error.message : String(error);
      const stderr = typeof error.stderr === "string" ? error.stderr : "";
      return {
        ok: false,
        error: `${message}${stderr.length > 0 ? `: ${stderr.trim()}` : ""}`,
      };
    }
    return { ok: false, error: String(error) };
  }
}

function hasRemoteControlCommands(
  result:
    | { ok: true; stdout: string; stderr: string }
    | { ok: false; error: string },
): boolean {
  return (
    result.ok &&
    ["start", "stop", "pair"].every((command) =>
      new RegExp(`\\b${command}\\b`).test(result.stdout),
    )
  );
}

function hasPairingHelp(
  result:
    | { ok: true; stdout: string; stderr: string }
    | { ok: false; error: string },
): boolean {
  return result.ok && /pairing/i.test(`${result.stdout}\n${result.stderr}`);
}

function emptyAnalysis(): RemoteControlSchemaAnalysis {
  return {
    methods: [],
    notifications: [],
    pairingResponseFields: [],
    clientFields: [],
    statusValues: [],
    missingMethods: [...REQUIRED_REMOTE_CONTROL_METHODS],
    missingNotifications: [REQUIRED_REMOTE_CONTROL_NOTIFICATION],
    missingPairingResponseFields: [...REQUIRED_PAIRING_RESPONSE_FIELDS],
    missingClientFields: [...REQUIRED_CLIENT_FIELDS],
    missingStatusValues: [...REQUIRED_STATUS_VALUES],
    compatible: false,
  };
}

function collectMethods(schema: unknown): Set<string> {
  const methods = new Set<string>();
  visit(schema, (value) => {
    if (
      !isRecord(value) ||
      !isRecord(value.method) ||
      !Array.isArray(value.method.enum)
    ) {
      return;
    }
    for (const method of value.method.enum) {
      if (typeof method === "string") methods.add(method);
    }
  });
  return methods;
}

function collectProperties(schema: unknown): Set<string> {
  const properties = new Set<string>();
  visit(schema, (value) => {
    if (!isRecord(value) || !isRecord(value.properties)) return;
    for (const property of Object.keys(value.properties)) {
      properties.add(property);
    }
  });
  return properties;
}

function collectEnumValues(schema: unknown, property: string): Set<string> {
  const values = new Set<string>();
  const references = new Set<string>();
  visit(schema, (value) => {
    if (!isRecord(value) || !isRecord(value.properties)) return;
    const candidate = value.properties[property];
    if (!isRecord(candidate)) return;
    if (Array.isArray(candidate.enum)) {
      for (const item of candidate.enum) {
        if (typeof item === "string") values.add(item);
      }
    }
    if (typeof candidate.$ref === "string") {
      references.add(candidate.$ref);
    }
  });
  for (const reference of references) {
    const definitionName = reference.match(/^#\/definitions\/(.+)$/)?.[1];
    if (definitionName === undefined || !isRecord(schema)) continue;
    const definitions = schema.definitions;
    if (!isRecord(definitions)) continue;
    const definition = definitions[definitionName];
    if (!isRecord(definition) || !Array.isArray(definition.enum)) continue;
    for (const item of definition.enum) {
      if (typeof item === "string") values.add(item);
    }
  }
  return values;
}

function missing(required: readonly string[], actual: readonly string[]): string[] {
  const available = new Set(actual);
  return required.filter((item) => !available.has(item));
}

function visit(value: unknown, visitor: (value: unknown) => void): void {
  visitor(value);
  if (Array.isArray(value)) {
    for (const child of value) visit(child, visitor);
    return;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) visit(child, visitor);
  }
}
