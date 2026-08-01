#!/usr/bin/env bash
# quant_bridge.sh — 编排仓（mhm_net_cn）运行时胶水（路径 3）
#
# 设计目标：
# - 本仓 workflow 在阶段边界调用本脚本，写入 jobs/{jobId}/manifest phase 与终态产物
# - 上游 daily_stock_analysis 零侵入（不改其 workflow / 不挂胶水）
# - 无 JOB_ID 时全部空操作
#
# 用法（在 Actions 中）：
#   bash scripts/quant_bridge.sh pre              # 环境就绪后：setup + fetch
#   bash scripts/quant_bridge.sh mark analyze     # 进入研判前
#   bash scripts/quant_bridge.sh finish           # 终态发布（读 job 成功/失败）
#   bash scripts/quant_bridge.sh finish success|failure
#
# 环境变量：JOB_ID, SYMBOL, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID
# 可选：QUANT_JOB_STATUS=success|failure、REPORTS_DIR、ANALYSIS_DOCS_BRANCH

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUSH_PY="${ROOT_DIR}/scripts/push_unicloud_result.py"
REPORTS_DIR="${REPORTS_DIR:-reports}"

log() { echo "[quant-bridge] $*"; }

# 无 jobId：与 quant 无关，直接放行
if [ -z "${JOB_ID:-}" ]; then
  log "JOB_ID 为空，跳过（非 quant 触发）"
  exit 0
fi

if [ ! -f "$PUSH_PY" ]; then
  log "⚠️ 找不到 $PUSH_PY，跳过"
  exit 0
fi

# 发布脚本失败不拖垮主流程（finish 除外由调用方决定）
run_push() {
  # shellcheck disable=SC2068
  python3 "$PUSH_PY" --reports-dir "$REPORTS_DIR" "$@" || {
    log "⚠️ push 调用失败（已忽略）：$*"
    return 0
  }
}

cmd="${1:-}"
shift || true

case "$cmd" in
  pre)
    # 执行期写入：环境已就绪，进入拉数前的阶段
    log "pre → setup + fetch (jobId=${JOB_ID})"
    run_push --phase setup \
      --phase-message "正在初始化分析环境与依赖…（通常约 30–60 秒）"
    run_push --phase fetch \
      --phase-message "正在拉取行情与市场数据…（通常约 30–90 秒）"
    ;;

  mark)
    phase="${1:-analyze}"
    log "mark → phase=${phase} (jobId=${JOB_ID})"
    case "$phase" in
      checkout)
        run_push --phase checkout \
          --phase-message "正在检出代码与准备仓库…（通常约 15–30 秒）"
        ;;
      setup)
        run_push --phase setup \
          --phase-message "正在初始化分析环境与依赖…（通常约 30–60 秒）"
        ;;
      fetch)
        run_push --phase fetch \
          --phase-message "正在拉取行情与市场数据…（通常约 30–90 秒）"
        ;;
      analyze)
        run_push --phase analyze \
          --phase-message "正在运行大模型推理，生成投研观点…（通常约 2–5 分钟，请耐心等待）"
        ;;
      publish)
        run_push --phase publish \
          --phase-message "正在整理摘要并发布研究报告…（通常约 20–40 秒）"
        ;;
      *)
        log "未知 phase: $phase"
        exit 1
        ;;
    esac
    ;;

  finish)
    # 优先环境变量，其次显式参数，默认按 success（兼容旧调用）
    status="${QUANT_JOB_STATUS:-${1:-}}"
    if [ -z "$status" ]; then
      status="success"
    fi
    # 归一化
    case "$status" in
      success|succeeded|SUCCESS) status="success" ;;
      failure|failed|cancelled|FAILURE|CANCELLED) status="failure" ;;
    esac

    log "finish → status=${status} reports=${REPORTS_DIR} (jobId=${JOB_ID})"
    run_push --phase publish \
      --phase-message "正在整理摘要并发布研究报告…（通常约 20–40 秒）"

    if [ "$status" = "success" ]; then
      # 成功：强制 metrics + history（由 push 脚本保证）
      python3 "$PUSH_PY" --reports-dir "$REPORTS_DIR" --status succeeded --phase succeeded
    else
      python3 "$PUSH_PY" \
        --reports-dir "$REPORTS_DIR" \
        --status failed \
        --phase failed \
        --error "Actions 作业未成功完成" \
        --error-code ANALYSIS_FAILED
    fi
    ;;

  *)
    cat <<'EOF'
用法:
  quant_bridge.sh pre
  quant_bridge.sh mark <checkout|setup|fetch|analyze|publish>
  quant_bridge.sh finish [success|failure]

无 JOB_ID 时全部为空操作。
REPORTS_DIR 可指向上游分析产物目录（默认 reports）。
EOF
    exit 1
    ;;
esac
