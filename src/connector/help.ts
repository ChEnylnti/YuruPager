export function connectorHelp(): string {
  return `YuruPager Connector

用法：
  yurupager start
  yurupager setup --server <https-url> --pair <XXXX-XXXX-XXXX> [--no-install]
  yurupager preview <1024..65535> [--name label] [--duration minutes]
  yurupager --help

命令：
  start    启动已配对的后台 Connector（省略命令时行为相同）
  setup    使用 Web 生成的一次性配对码登记当前工作站
  preview  临时开放一个本机 HTTP/WS 开发端口，按 Ctrl+C 停止

运行 yurupager preview --help 查看预览边界和示例。
`;
}

export function previewHelp(): string {
  return `YuruPager 开发预览

用法：
  yurupager preview <1024..65535> [--name label] [--duration minutes]

示例：
  yurupager preview 5173 --name "Vite" --duration 60

选项：
  --name       Web 中显示的标签，最多 80 个可见字符
  --duration   有效分钟数，范围 15..240，默认 60
  -h, --help   显示本帮助

前提与边界：
  - 当前工作站必须已通过 YuruPager 动态配对。
  - 目标固定为 127.0.0.1 或 ::1 的指定端口，只支持 HTTP/WS。
  - 不接受主机名、LAN 地址、CONNECT、任意 TCP 或本机 HTTPS。
  - 流量仅在内存中转；断线会关闭旧流且不会自动重放。
  - 按 Ctrl+C、在 Web 停止或等待到期即可撤销授权。
`;
}

export function isHelpRequest(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--help" || args[0] === "-h");
}
