import { CodexAppServerClient } from "../codex/json-rpc-client.js";

const threadId = readArgument(process.argv.slice(2), "--thread");
const first = new CodexAppServerClient({ requestTimeoutMs: 30_000 });
const second = new CodexAppServerClient({ requestTimeoutMs: 30_000 });
let secondSubscribed = false;

try {
  await Promise.all([first.start(), second.start()]);
  await Promise.all([
    first.initialize({ name: "yurupager-writer-owner", version: "0.0.1" }),
    second.initialize({ name: "yurupager-writer-contender", version: "0.0.1" }),
  ]);
  await first.request("thread/resume", { threadId, excludeTurns: true });

  let contentionError: string | null = null;
  try {
    await second.request("thread/resume", { threadId, excludeTurns: true });
  } catch (error) {
    contentionError = error instanceof Error ? error.message : String(error);
  }

  await first.stop();
  let takeoverError: string | null = null;
  try {
    await second.request("thread/resume", { threadId, excludeTurns: true });
    secondSubscribed = true;
  } catch (error) {
    takeoverError = error instanceof Error ? error.message : String(error);
  }

  const result = {
    passed:
      contentionError?.includes("active writer") === true &&
      takeoverError === null,
    experimentCompleted: true,
    contentionObserved: contentionError?.includes("active writer") === true,
    ownerProcessStopped: true,
    takeoverSucceeded: takeoverError === null,
    takeoverError,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
} finally {
  if (secondSubscribed && second.running) await second.stop();
  await Promise.allSettled([first.stop(), second.stop()]);
}

function readArgument(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required; use an existing idle Codex thread`);
  }
  return value;
}
