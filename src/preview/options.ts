import { previewLimits } from "@yurupager/shared";

export interface PreviewCommandOptions {
  port: number;
  name: string;
  durationMinutes: number;
}

export function parsePreviewArguments(args: string[]): PreviewCommandOptions {
  const portText = args[0];
  if (portText === undefined || !/^[1-9][0-9]*$/u.test(portText)) {
    throw new Error("用法：yurupager preview <1024..65535> [--name label] [--duration minutes]");
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < previewLimits.minLocalPort || port > previewLimits.maxLocalPort) {
    throw new Error(`预览端口必须是 ${previewLimits.minLocalPort} 到 ${previewLimits.maxLocalPort} 的整数`);
  }

  let name = `localhost:${port}`;
  let durationMinutes = 60;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option !== "--name" && option !== "--duration") {
      throw new Error(`未知参数：${option ?? ""}`);
    }
    if (seen.has(option)) throw new Error(`参数不能重复：${option}`);
    seen.add(option);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} 需要一个值`);
    index += 1;
    if (option === "--name") {
      name = normalizePreviewName(value);
    } else {
      if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("预览时长必须是整数分钟");
      durationMinutes = Number(value);
    }
  }

  const durationMs = durationMinutes * 60_000;
  if (
    !Number.isSafeInteger(durationMinutes) ||
    durationMs < previewLimits.minRouteDurationMs ||
    durationMs > previewLimits.maxRouteDurationMs
  ) {
    throw new Error(
      `预览时长必须是 ${previewLimits.minRouteDurationMs / 60_000} 到 ${previewLimits.maxRouteDurationMs / 60_000} 分钟`,
    );
  }
  return { port, name, durationMinutes };
}

function normalizePreviewName(value: string): string {
  const name = value.trim();
  if (
    name.length === 0 ||
    Array.from(name).length > previewLimits.maxNameCharacters ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)
  ) {
    throw new Error(`预览名称必须是 1 到 ${previewLimits.maxNameCharacters} 个可见字符`);
  }
  return name;
}
