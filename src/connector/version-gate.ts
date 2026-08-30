import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CodexVersionProbe {
  raw: string;
  version: string;
  supported: boolean;
}

export function parseCodexVersion(raw: string): CodexVersionProbe {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (match === null) throw new Error(`Unable to parse Codex version: ${raw}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported = major === 0 && minor >= 145 && minor < 149;
  return { raw, version: match[0], supported };
}

export async function probeCodexVersion(command = "codex"): Promise<CodexVersionProbe> {
  const { stdout } = await execFileAsync(command, ["--version"], { timeout: 15_000 });
  return parseCodexVersion(stdout.trim());
}

export async function enforceCodexVersion(command = "codex"): Promise<CodexVersionProbe> {
  const probe = await probeCodexVersion(command);
  if (!probe.supported) {
    throw new Error(
      `Unsupported Codex app-server version ${probe.version}; supported Alpha minors are 0.145.x through 0.148.x`,
    );
  }
  return probe;
}
