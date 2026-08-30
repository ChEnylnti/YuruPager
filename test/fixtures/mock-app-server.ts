import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  const method = message.method;
  const id = message.id;

  if (method === "initialize") {
    write({
      id,
      result: {
        codexHome: "/tmp/mock-codex-home",
        platformFamily: "unix",
        platformOs: "test",
        userAgent: "mock-app-server/1.0",
      },
    });
    return;
  }
  if (method === "initialized") {
    write({
      id: "server-request-1",
      method: "mock/approval",
      params: { safe: true },
    });
    return;
  }
  if (method === "echo") {
    write({ id, result: message.params });
    return;
  }
  if (method === "crash") {
    process.exit(17);
  }
  if (id === "server-request-1") {
    write({
      method: "mock/responseObserved",
      params: { response: message.result },
    });
  }
});

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

