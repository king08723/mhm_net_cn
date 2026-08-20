#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""run_tradingagents.py — 无头调用 TradingAgentsGraph（避开交互式 CLI）

须在已 checkout 的 TradingAgents 源码根目录执行（或 PYTHONPATH 含该根）。
环境变量：
  STOCK_LIST / SYMBOL — 股票代码（仅取第一个）
  QUANT_PARAMS — JSON（reportLanguage → TRADINGAGENTS_OUTPUT_LANGUAGE）
  TRADINGAGENTS_* — 见 default_config.py
输出：
  reports/ta_raw/{TICKER}_{date}/complete_report.md
  再经 adapt_ta_to_job 写到 reports/
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def _apply_quant_params_to_env() -> None:
    """把 quant 页语言等参数映射到 TRADINGAGENTS_*。"""
    raw = os.environ.get("QUANT_PARAMS") or "{}"
    try:
        params = json.loads(raw)
    except json.JSONDecodeError:
        params = {}

    lang = str(params.get("reportLanguage") or os.environ.get("REPORT_LANGUAGE") or "zh").lower()
    lang_map = {"zh": "Chinese", "en": "English", "ko": "Korean"}
    if not os.environ.get("TRADINGAGENTS_OUTPUT_LANGUAGE"):
        os.environ["TRADINGAGENTS_OUTPUT_LANGUAGE"] = lang_map.get(lang, "Chinese")


def _env_nonempty(*names: str) -> bool:
    return any((os.environ.get(n) or "").strip() for n in names)


def _ensure_llm_provider_env() -> None:
    """未显式配置 TRADINGAGENTS_LLM_PROVIDER 时，按已有 Key 自动选择。

    TradingAgents 默认 provider=openai；本站常只配 GEMINI/GOOGLE，不配 OPENAI，
    会导致开跑即 ValueError。须在 import DEFAULT_CONFIG 之前写入环境变量。
    """
    # Gemini 与 Google 客户端共用 GOOGLE_API_KEY
    if not (os.environ.get("GOOGLE_API_KEY") or "").strip():
        gemini = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEYS") or "").strip()
        if gemini:
            # 多 key 时只取第一个
            os.environ["GOOGLE_API_KEY"] = gemini.split(",")[0].strip()

    if (os.environ.get("TRADINGAGENTS_LLM_PROVIDER") or "").strip():
        return

    # 优先级：google → openai → anthropic → deepseek → xai
    choice = None
    if _env_nonempty("GOOGLE_API_KEY", "GEMINI_API_KEY", "GEMINI_API_KEYS"):
        choice = "google"
        os.environ.setdefault("TRADINGAGENTS_DEEP_THINK_LLM", "gemini-2.5-pro")
        os.environ.setdefault("TRADINGAGENTS_QUICK_THINK_LLM", "gemini-2.5-flash")
    elif _env_nonempty("OPENAI_API_KEY", "OPENAI_API_KEYS"):
        choice = "openai"
    elif _env_nonempty("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEYS"):
        choice = "anthropic"
    elif _env_nonempty("DEEPSEEK_API_KEY", "DEEPSEEK_API_KEYS"):
        choice = "deepseek"
    elif _env_nonempty("XAI_API_KEY"):
        choice = "xai"

    if choice:
        os.environ["TRADINGAGENTS_LLM_PROVIDER"] = choice
        print(f"ℹ️ 未设置 TRADINGAGENTS_LLM_PROVIDER，按可用密钥自动选择: {choice}")
    else:
        print(
            "⚠️ 未检测到 OPENAI/GOOGLE/ANTHROPIC/DEEPSEEK/XAI API Key；"
            "TradingAgents 可能在初始化时失败。请在 mhm_net_cn Secrets 配置至少一个，"
            "或设置 Variables.TRADINGAGENTS_LLM_PROVIDER。",
            file=sys.stderr,
        )


def main() -> int:
    # 确保当前目录（上游根）可被 import
    cwd = Path.cwd().resolve()
    if str(cwd) not in sys.path:
        sys.path.insert(0, str(cwd))

    _apply_quant_params_to_env()
    # 必须在 import DEFAULT_CONFIG 之前（其模块加载时会读 TRADINGAGENTS_*）
    _ensure_llm_provider_env()

    from tradingagents.default_config import DEFAULT_CONFIG
    from tradingagents.graph.trading_graph import TradingAgentsGraph
    from tradingagents.reporting import write_report_tree

    # 编排层 ticker 归一化脚本
    orch_scripts = Path(__file__).resolve().parent
    sys.path.insert(0, str(orch_scripts))
    from ticker_normalize import normalize  # noqa: E402
    from adapt_ta_to_job import adapt  # noqa: E402

    raw_symbol = (
        os.environ.get("STOCK_LIST")
        or os.environ.get("SYMBOL")
        or ""
    ).split(",")[0].strip()
    if not raw_symbol:
        print("❌ 缺少股票代码（STOCK_LIST / SYMBOL）", file=sys.stderr)
        return 1

    ticker = normalize(raw_symbol, "tradingagents")
    analysis_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    config = DEFAULT_CONFIG.copy()
    # 结果写到工作区，便于适配
    results_root = cwd / "reports" / "ta_raw"
    results_root.mkdir(parents=True, exist_ok=True)
    config["results_dir"] = str(results_root)

    print("==========================================")
    print("🚀 Quant 编排 · TradingAgents 无头运行")
    print(f"📊 ticker: {raw_symbol} → {ticker}")
    print(f"📅 date: {analysis_date}")
    print(f"🔤 language: {config.get('output_language')}")
    print(f"🤖 provider: {config.get('llm_provider')}")
    print("==========================================")

    # 默认启用全部分析师（与 CLI 全选一致）
    selected = ["market", "social", "news", "fundamentals"]
    ta = TradingAgentsGraph(selected, config=config, debug=True)
    final_state, decision = ta.propagate(ticker, analysis_date)
    print(f"✅ decision: {decision}")

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    save_path = results_root / f"{ticker}_{stamp}"
    report_file = write_report_tree(final_state, ticker, save_path)
    print(f"✅ report tree: {report_file}")

    # 扁平适配到 reports/（供 quant_bridge / push 使用）
    flat_dir = cwd / "reports"
    flat_dir.mkdir(parents=True, exist_ok=True)
    rc = adapt(save_path, flat_dir, ticker)
    if rc != 0:
        return rc

    # 若 decision 是字符串，补进 metrics
    metrics_path = flat_dir / "metrics.json"
    try:
        metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
        if decision and not metrics.get("rating"):
            metrics["rating"] = str(decision)[:64]
        metrics["modelVersion"] = "tradingagents"
        metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️ 更新 metrics 失败（可忽略）: {exc}")

    print("📂 reports/:")
    for p in sorted(flat_dir.glob("*")):
        if p.is_file():
            print(f"  - {p.name} ({p.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
