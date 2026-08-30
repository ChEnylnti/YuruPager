#!/bin/sh
set -eu

SERVER=""
PAIR_CODE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) SERVER=${2:-}; shift 2 ;;
    --pair) PAIR_CODE=${2:-}; shift 2 ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done

if [ -z "$SERVER" ] || [ -z "$PAIR_CODE" ]; then
  printf '用法：install-connector.sh --server https://example/yurupager/ --pair XXXX-XXXX-XXXX\n' >&2
  exit 2
fi
for command in node npm curl tar; do
  command -v "$command" >/dev/null 2>&1 || { printf '缺少依赖：%s\n' "$command" >&2; exit 1; }
done

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  printf 'YuruPager Connector 需要 Node.js 22 或更新版本。\n' >&2
  exit 1
fi

case "$SERVER" in */) ;; *) SERVER="$SERVER/" ;; esac
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/yurupager-connector.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT INT TERM
ARCHIVE="$TEMP_DIR/yurupager-connector.tgz"
curl -fsSL "${SERVER}api/connector/package.tgz" -o "$ARCHIVE"
EXPECTED=$(curl -fsSL "${SERVER}api/connector/package.sha256" | tr -d '[:space:]')
if command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')
else
  ACTUAL=$(sha256sum "$ARCHIVE" | awk '{print $1}')
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  printf 'Connector 安装包校验失败。\n' >&2
  exit 1
fi

RELEASE="$HOME/.yurupager/app/0.2.0-alpha"
mkdir -p "$RELEASE"
tar -xzf "$ARCHIVE" -C "$RELEASE"
(cd "$RELEASE" && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
chmod 755 "$RELEASE/dist/src/connector/main.js"
BIN_DIR=${YURUPAGER_BIN_DIR:-"$HOME/.local/bin"}
mkdir -p "$BIN_DIR"
ln -sfn "$RELEASE/dist/src/connector/main.js" "$BIN_DIR/yurupager"
case ":${PATH:-}:" in
  *:"$BIN_DIR":*) ;;
  *) printf '提示：请把 %s 加入 PATH，之后可直接运行 yurupager。\n' "$BIN_DIR" ;;
esac
exec node "$RELEASE/dist/src/connector/main.js" setup --server "$SERVER" --pair "$PAIR_CODE"
