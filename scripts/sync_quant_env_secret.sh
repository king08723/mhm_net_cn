#!/usr/bin/env bash
# sync_quant_env_secret.sh — 把本地 .env 一键写入本仓 GitHub Secret QUANT_ENV_B64
#
# 背景：GitHub 无法读出已配置 Secret 的值，所以不能「从 daily_stock_analysis
# 仓库 API 自动抄到 mhm_net_cn」。只要你手头还有一份 .env（或从原仓设置页
# 对照着拼出来），用本脚本写入一次即可。
#
# 用法：
#   bash scripts/sync_quant_env_secret.sh /path/to/daily_stock_analysis/.env
#   bash scripts/sync_quant_env_secret.sh ./my-quant.env --repo king08723/mhm_net_cn
#
# 依赖：gh（已登录）、base64

set -euo pipefail

ENV_FILE="${1:-}"
REPO="king08723/mhm_net_cn"
SECRET_NAME="QUANT_ENV_B64"

shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --name) SECRET_NAME="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  cat <<'EOF' >&2
用法:
  bash scripts/sync_quant_env_secret.sh <env文件> [--repo owner/repo] [--name QUANT_ENV_B64]

说明:
  - 推荐从 daily_stock_analysis 本地克隆的 .env 复制
  - 若只有 GitHub Secrets、没有本地 .env：无法自动导出，只能对照原仓
    Settings → Secrets 名称，把仍在用的 Key 手工写进一个 .env 再跑本脚本
  - 实际上游 workflow 里绝大多数 Key 是可选的；通常只需 LLM + 数据源少数几项
EOF
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "❌ 需要安装并登录 GitHub CLI: https://cli.github.com/" >&2
  exit 1
fi

# 粗略统计有效行（不打印内容）
LINE_COUNT="$(grep -E -c '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" || true)"
echo "📦 将写入 ${REPO} ← Secret ${SECRET_NAME}"
echo "   来源: ${ENV_FILE}（约 ${LINE_COUNT} 个 KEY=）"
echo "   编码: base64（避免多行/特殊字符问题）"

base64 < "$ENV_FILE" | gh secret set "$SECRET_NAME" --repo "$REPO"

echo "✅ 已更新 ${REPO} / ${SECRET_NAME}"
echo "   之后 Actions 会通过 scripts/inject_quant_env.sh 自动注入，无需逐条配置。"
