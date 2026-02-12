#!/bin/bash
# update-hub-plugin.sh — 更新 cluster-hub 插件到最新版本
set -e

EXTENSIONS_DIR="${OPENCLAW_EXTENSIONS:-$HOME/.openclaw/extensions}/cluster-hub"
PKG="@hpplay-lebo/cluster-hub"
TMPDIR=$(mktemp -d)

# 检查当前版本
CURRENT=""
if [ -f "$EXTENSIONS_DIR/package.json" ]; then
  CURRENT=$(grep '"version"' "$EXTENSIONS_DIR/package.json" | head -1 | sed 's/.*"version": *"//;s/".*//')
fi

# 检查最新版本
LATEST=$(npm view "$PKG" version 2>/dev/null)
if [ -z "$LATEST" ]; then
  echo "❌ 无法获取最新版本"
  rm -rf "$TMPDIR"
  exit 1
fi

echo "当前版本: ${CURRENT:-未安装}"
echo "最新版本: $LATEST"

if [ "$CURRENT" = "$LATEST" ]; then
  echo "✅ 已是最新版本，无需更新"
  rm -rf "$TMPDIR"
  exit 0
fi

# 下载并解压
echo "⬇️  下载 $PKG@$LATEST ..."
cd "$TMPDIR"
npm pack "$PKG@$LATEST" --silent 2>/dev/null
tar xzf hpplay-lebo-cluster-hub-*.tgz

# 同步到 extensions
echo "📦 安装到 $EXTENSIONS_DIR ..."
mkdir -p "$EXTENSIONS_DIR"
rsync -a --delete --exclude='node_modules' package/ "$EXTENSIONS_DIR/"

# 清理
rm -rf "$TMPDIR"

echo "✅ 已更新到 v$LATEST"
echo "⚠️  需要重启 Gateway 生效"
