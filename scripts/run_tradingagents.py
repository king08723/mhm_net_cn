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


def _set_env_if_blank(name: str, value: str) -> None:
    """GitHub Actions 常把未配置的 Secret/Variable 注入成空字符串，setdefault 无效。"""
    if not (os.environ.get(name) or "").strip():
        os.environ[name] = value


def _looks_like_openai_model(name: str) -> bool:
    n = (name or "").strip().lower()
    return n.startswith("gpt-") or n.startswith("o1") or n.startswith("o3") or n.startswith("o4")


def _ensure_llm_provider_env() -> None:
    """确保 TRADINGAGENTS_LLM_PROVIDER 与模型名匹配已有密钥。

    TradingAgents 默认 provider=openai、模型 gpt-*；本站常只配 GEMINI。
    Actions 里空 Variables 会变成 env=""，必须按「空白」处理并写入 google 模型。
    须在 import DEFAULT_CONFIG 之前调用。
    """
    # Gemini 与 Google 客户端共用 GOOGLE_API_KEY
    if not (os.environ.get("GOOGLE_API_KEY") or "").strip():
        gemini = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEYS") or "").strip()
        if gemini:
            os.environ["GOOGLE_API_KEY"] = gemini.split(",")[0].strip()

    provider = (os.environ.get("TRADINGAGENTS_LLM_PROVIDER") or "").strip().lower()
    if not provider:
        if _env_nonempty("GOOGLE_API_KEY", "GEMINI_API_KEY", "GEMINI_API_KEYS"):
            provider = "google"
        elif _env_nonempty("OPENAI_API_KEY", "OPENAI_API_KEYS"):
            provider = "openai"
        elif _env_nonempty("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEYS"):
            provider = "anthropic"
        elif _env_nonempty("DEEPSEEK_API_KEY", "DEEPSEEK_API_KEYS"):
            provider = "deepseek"
        elif _env_nonempty("XAI_API_KEY"):
            provider = "xai"
        if provider:
            os.environ["TRADINGAGENTS_LLM_PROVIDER"] = provider
            print(f"ℹ️ 未设置 TRADINGAGENTS_LLM_PROVIDER，按可用密钥自动选择: {provider}")
        else:
            print(
                "⚠️ 未检测到 OPENAI/GOOGLE/ANTHROPIC/DEEPSEEK/XAI API Key；"
                "请配置 Secrets，或设置 Variables.TRADINGAGENTS_LLM_PROVIDER。",
                file=sys.stderr,
            )
            return

    # 与 provider 对齐模型（空白或仍是 openai 默认名时覆盖）
    deep = (os.environ.get("TRADINGAGENTS_DEEP_THINK_LLM") or "").strip()
    quick = (os.environ.get("TRADINGAGENTS_QUICK_THINK_LLM") or "").strip()
    if provider == "google":
        if not deep or _looks_like_openai_model(deep):
            os.environ["TRADINGAGENTS_DEEP_THINK_LLM"] = "gemini-2.5-pro"
        if not quick or _looks_like_openai_model(quick):
            os.environ["TRADINGAGENTS_QUICK_THINK_LLM"] = "gemini-2.5-flash"
    elif provider == "anthropic":
        if not deep or _looks_like_openai_model(deep):
            _set_env_if_blank("TRADINGAGENTS_DEEP_THINK_LLM", "claude-3-5-sonnet-20241022")
        if not quick or _looks_like_openai_model(quick):
            _set_env_if_blank("TRADINGAGENTS_QUICK_THINK_LLM", "claude-3-5-haiku-20241022")

    print(
        "🤖 LLM env → "
        f"provider={os.environ.get('TRADINGAGENTS_LLM_PROVIDER')} "
        f"deep={os.environ.get('TRADINGAGENTS_DEEP_THINK_LLM')} "
        f"quick={os.environ.get('TRADINGAGENTS_QUICK_THINK_LLM')}"
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
    # 二次对齐：防止模块已被其它路径先 import 导致 env 覆盖未生效
    provider = (os.environ.get("TRADINGAGENTS_LLM_PROVIDER") or config.get("llm_provider") or "").strip()
    if provider:
        config["llm_provider"] = provider
    if provider == "google":
        deep = str(config.get("deep_think_llm") or "")
        quick = str(config.get("quick_think_llm") or "")
        if not deep or _looks_like_openai_model(deep):
            config["deep_think_llm"] = os.environ.get("TRADINGAGENTS_DEEP_THINK_LLM") or "gemini-2.5-pro"
        if not quick or _looks_like_openai_model(quick):
            config["quick_think_llm"] = os.environ.get("TRADINGAGENTS_QUICK_THINK_LLM") or "gemini-2.5-flash"

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
    print(f"🧠 deep/quick: {config.get('deep_think_llm')} / {config.get('quick_think_llm')}")
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
