#!/usr/bin/env bash
# inject_quant_env.sh — 把本仓 Secret QUANT_ENV / QUANT_ENV_B64 注入当前 shell
#
# 用法（必须 source）：
#   source ../orchestrator/scripts/inject_quant_env.sh
#
# 优先顺序：
#   1) QUANT_ENV_B64（base64 整份 .env）
#   2) QUANT_ENV（明文多行 .env）
#   3) 皆空则跳过
#
# 不会覆盖编排层已注入的关键变量（JOB_ID / GITHUB_TOKEN 等）。

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "请使用: source scripts/inject_quant_env.sh" >&2
  exit 1
fi

# 编排层变量：注入 .env 后强制保留
_PROTECTED_KEYS=(
  JOB_ID SYMBOL GITHUB_TOKEN GITHUB_REPOSITORY GITHUB_RUN_ID
  ANALYSIS_DOCS_BRANCH QUANT_PARAMS QUANT_JOB_STATUS REPORTS_DIR
  QUANT_ENV QUANT_ENV_B64
)

_save_protected() {
  _PROTECTED_VALUES=()
  local k
  for k in "${_PROTECTED_KEYS[@]}"; do
    _PROTECTED_VALUES+=("${!k-}")
  done
}

_restore_protected() {
  local i k
  for i in "${!_PROTECTED_KEYS[@]}"; do
    k="${_PROTECTED_KEYS[$i]}"
    # 仅当编排层原本非空时写回，避免把空串强行 export
    if [ -n "${_PROTECTED_VALUES[$i]}" ]; then
      export "$k=${_PROTECTED_VALUES[$i]}"
    fi
  done
}

_quant_env_tmp="$(mktemp)"
_cleanup_quant_env() { rm -f "$_quant_env_tmp"; unset _quant_env_tmp; }

if [ -n "${QUANT_ENV_B64:-}" ]; then
  echo "[quant-env] 从 QUANT_ENV_B64 注入环境变量"
  printf '%s' "$QUANT_ENV_B64" | base64 --decode > "$_quant_env_tmp"
elif [ -n "${QUANT_ENV:-}" ]; then
  echo "[quant-env] 从 QUANT_ENV 注入环境变量"
  printf '%s\n' "$QUANT_ENV" > "$_quant_env_tmp"
else
  echo "[quant-env] 未配置 QUANT_ENV / QUANT_ENV_B64，跳过"
  _cleanup_quant_env
  return 0 2>/dev/null || true
fi

_save_protected
set -a
# shellcheck disable=SC1090
source "$_quant_env_tmp"
set +a
_restore_protected
_cleanup_quant_env

echo "[quant-env] 注入完成（值已脱敏，不会打印）"
unset -f _save_protected _restore_protected _cleanup_quant_env
unset _PROTECTED_KEYS _PROTECTED_VALUES
