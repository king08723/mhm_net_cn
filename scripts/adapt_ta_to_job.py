#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""adapt_ta_to_job.py — 将 TradingAgents 产物适配为 jobs/{jobId} 扁平契约

输入：TA write_report_tree 目录（含 complete_report.md）
输出：--out-dir 下的 report.md + 可选 metrics.json
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path


def find_complete_report(src: Path) -> Path | None:
    """在源目录中定位 complete_report.md。"""
    direct = src / "complete_report.md"
    if direct.is_file():
        return direct
    matches = sorted(src.rglob("complete_report.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0] if matches else None


def heuristic_metrics(report: str, symbol: str) -> dict:
    """从报告正文启发式提取摘要字段（供前端摘要卡）。"""
    text = report or ""
    rating = ""
    for pat in [
        r"(?i)\b(BUY|SELL|HOLD|买入|卖出|观望|中性)\b",
        r"(?i)decision[:：]\s*([A-Za-z\u4e00-\u9fff]+)",
        r"(?i)final\s+decision[:：]\s*([A-Za-z\u4e00-\u9fff]+)",
    ]:
        m = re.search(pat, text)
        if m:
            rating = (m.group(1) if m.lastindex else m.group(0)).strip()
            break

    risk = ""
    m = re.search(r"(?i)risk[^.\n]{0,40}(high|medium|low|高|中|低)", text)
    if m:
        risk = m.group(1)

    return {
        "rating": rating or "见报告",
        "confidence": None,
        "trend": "",
        "supportLevels": [],
        "resistanceLevels": [],
        "riskLevel": risk or "",
        "dataAsOf": 0,
        "modelVersion": "tradingagents",
        "realtimeEnabled": False,
        "degradedFeatures": [],
        "symbol": symbol,
        "engine": "tradingagents",
    }


def adapt(src_dir: Path, out_dir: Path, symbol: str) -> int:
    """复制/生成扁平 report.md 与 metrics.json。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    complete = find_complete_report(src_dir)
    if not complete:
        print(f"❌ 未找到 complete_report.md：{src_dir}", file=sys.stderr)
        return 1

    report_text = complete.read_text(encoding="utf-8", errors="replace").strip()
    if not report_text:
        print("❌ complete_report.md 为空", file=sys.stderr)
        return 1

    report_path = out_dir / "report.md"
    report_path.write_text(report_text + "\n", encoding="utf-8")
    print(f"✅ 写入 {report_path} ({len(report_text)} chars)")

    # 可选：把分节树一并拷到 out_dir/ta_sections 便于排障（不进 jobs 契约）
    sections_dst = out_dir / "ta_sections"
    if sections_dst.exists():
        shutil.rmtree(sections_dst)
    try:
        shutil.copytree(
            complete.parent,
            sections_dst,
            ignore=shutil.ignore_patterns("*.pyc", "__pycache__"),
        )
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️ 拷贝分节树失败（可忽略）: {exc}")

    metrics = heuristic_metrics(report_text, symbol)
    metrics_path = out_dir / "metrics.json"
    metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"✅ 写入 {metrics_path}")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="适配 TradingAgents 报告到 job 扁平目录")
    parser.add_argument("--src-dir", required=True, help="TA 报告树根目录")
    parser.add_argument("--out-dir", required=True, help="扁平输出目录（将作为 REPORTS_DIR）")
    parser.add_argument("--symbol", default="", help="股票代码（写入 metrics）")
    args = parser.parse_args(argv)
    return adapt(Path(args.src_dir), Path(args.out_dir), args.symbol)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
