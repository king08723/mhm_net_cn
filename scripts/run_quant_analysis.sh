#!/usr/bin/env bash
# run_quant_analysis.sh — 在已 checkout 的上游源码目录中执行分析
#
# 用法（cwd = analysis/ 上游根目录）：
#   bash ../orchestrator/scripts/run_quant_analysis.sh <STOCK_LIST> <MODE> <FORCE_RUN>
#
# 环境变量：QUANT_PARAMS（JSON）、以及上游 main.py 所需的 LLM/数据源 Secrets

set -euo pipefail

STOCK_SYMBOL="${1:-}"
MODE="${2:-stocks-only}"
FORCE_RUN="${3:-true}"

if [ -z "$STOCK_SYMBOL" ]; then
  echo "❌ 缺少股票代码参数" >&2
  exit 1
fi

if [ ! -f "main.py" ]; then
  echo "❌ 当前目录不是上游分析源码根（找不到 main.py）: $(pwd)" >&2
  exit 1
fi

# 解析 quant 页面扩展参数；缺失字段保持仓库变量/Secret 原有兜底
eval "$(
  python3 - <<'PY'
import json, os, shlex
params = json.loads(os.environ.get("QUANT_PARAMS") or "{}")
mapping = {
    "REPORT_TYPE": params.get("reportType") or os.environ.get("REPORT_TYPE") or "simple",
    "REPORT_LANGUAGE": params.get("reportLanguage") or os.environ.get("REPORT_LANGUAGE") or "zh",
    "DAILY_MARKET_CONTEXT_ENABLED": str(params.get("includeMarketContext", True)).lower(),
    "ENABLE_REALTIME_QUOTE": str(params.get("enableRealtimeQuote", True)).lower(),
    "ENABLE_REALTIME_TECHNICAL_INDICATORS": str(params.get("enableRealtimeTechnicalIndicators", True)).lower(),
    "ENABLE_CHIP_DISTRIBUTION": str(params.get("enableChipDistribution", True)).lower(),
}
if params.get("notificationEmail"):
    mapping["EMAIL_RECEIVERS"] = params["notificationEmail"]
    mapping["NOTIFICATION_REPORT_CHANNELS"] = "email"
for key, value in mapping.items():
    print(f"export {key}={shlex.quote(str(value))}")
PY
)"

export STOCK_LIST="$STOCK_SYMBOL"

# 处理 LITELLM YAML 配置文件
if [ -n "${LITELLM_CONFIG_YAML:-}" ] && [ -n "${LITELLM_CONFIG:-}" ]; then
  echo "📝 写入 LITELLM 配置: $LITELLM_CONFIG"
  mkdir -p "$(dirname "$LITELLM_CONFIG")"
  echo "$LITELLM_CONFIG_YAML" > "$LITELLM_CONFIG"
fi

echo "=========================================="
echo "🚀 Quant 编排仓 · 上游分析"
echo "=========================================="
echo "⏰ 时间: $(TZ='Asia/Shanghai' date '+%Y-%m-%d %H:%M:%S')"
echo "🎯 运行模式: $MODE"
echo "📊 标的: $STOCK_LIST"
echo "📝 报告类型: ${REPORT_TYPE:-}"
echo "🔤 语言: ${REPORT_LANGUAGE:-}"
echo "=========================================="
echo "【AI】"
echo "  Gemini:   $([ -n "${GEMINI_API_KEY:-}${GEMINI_API_KEYS:-}" ] && echo '✅' || echo '❌')"
echo "  AIHubMix: $([ -n "${AIHUBMIX_KEY:-}" ] && echo '✅' || echo '⚪')"
echo "  OpenAI:   $([ -n "${OPENAI_API_KEY:-}" ] && echo '✅' || echo '⚪')"
echo "  DeepSeek: $([ -n "${DEEPSEEK_API_KEY:-}" ] && echo '✅' || echo '⚪')"
echo "【数据源】"
echo "  Tushare:  $([ -n "${TUSHARE_TOKEN:-}" ] && echo '✅' || echo '⚪')"
echo "  TickFlow: $([ -n "${TICKFLOW_API_KEY:-}" ] && echo '✅' || echo '⚪')"
echo "=========================================="

FORCE_RUN_ARG=""
if [ "$FORCE_RUN" = "true" ]; then
  FORCE_RUN_ARG="--force-run"
  echo "⚡ 强制运行（跳过交易日检查）"
fi

mkdir -p data logs reports

if [ "$MODE" = "market-only" ]; then
  python main.py --market-review $FORCE_RUN_ARG
elif [ "$MODE" = "stocks-only" ]; then
  python main.py --no-market-review $FORCE_RUN_ARG
else
  python main.py $FORCE_RUN_ARG
fi

echo ""
echo "📂 reports/:"
ls -la reports/ 2>/dev/null || echo "（空）"
