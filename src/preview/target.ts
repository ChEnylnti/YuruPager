import { request } from "node:http";

export interface PreviewLoopbackTarget {
  host: "127.0.0.1" | "::1";
  port: number;
}

export async function resolvePreviewTarget(port: number, timeoutMs = 3_000): Promise<PreviewLoopbackTarget> {
  for (const host of ["127.0.0.1", "::1"] as const) {
    if (await probeHttp({ host, port }, timeoutMs)) return { host, port };
  }
  throw new Error(`无法连接本机 HTTP 服务 127.0.0.1:${port} 或 [::1]:${port}`);
}

export function loopbackAuthority(target: PreviewLoopbackTarget): string {
  return target.host === "::1" ? `[::1]:${target.port}` : `127.0.0.1:${target.port}`;
}

async function probeHttp(target: PreviewLoopbackTarget, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request({
      host: target.host,
      port: target.port,
      method: "HEAD",
      path: "/",
      headers: {
        host: loopbackAuthority(target),
        origin: `http://${loopbackAuthority(target)}`,
        connection: "close",
      },
    });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      probe.destroy();
      finish(false);
    }, timeoutMs);
    probe.once("response", (response) => {
      response.resume();
      finish(true);
    });
    probe.once("error", () => finish(false));
    probe.end();
  });
}
