#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ticker_normalize.py — 按引擎归一化股票代码（中文注释）

DSA 常用：00700.HK、600519.SH
TradingAgents / Yahoo：0700.HK、600519.SS
"""

from __future__ import annotations

import re
import sys


def normalize_for_tradingagents(symbol: str) -> str:
    """将站点输入归一为 TradingAgents / yfinance 风格。"""
    s = (symbol or "").strip().upper()
    if not s:
        return s

    # 港股：00700.HK / HK00700 → 0700.HK
    m = re.match(r"^(?:HK)?0*(\d{4})\.HK$", s)
    if m:
        return f"{m.group(1)}.HK"
    m = re.match(r"^HK0*(\d{4})$", s)
    if m:
        return f"{m.group(1)}.HK"
    m = re.match(r"^0+(\d{4})$", s)
    if m and len(s) <= 6:
        # 纯数字五位港股代码（如 00700）
        return f"{m.group(1)}.HK"

    # 上交所：.SH → .SS
    if s.endswith(".SH"):
        return s[:-3] + ".SS"

    return s


def normalize_for_dsa(symbol: str) -> str:
    """DSA 路径保持大写即可。"""
    return (symbol or "").strip().upper()


def normalize(symbol: str, engine: str = "dsa") -> str:
    eng = (engine or "dsa").strip().lower()
    if eng in ("tradingagents", "ta"):
        return normalize_for_tradingagents(symbol)
    return normalize_for_dsa(symbol)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("用法: ticker_normalize.py <SYMBOL> [engine]", file=sys.stderr)
        return 2
    symbol = argv[1]
    engine = argv[2] if len(argv) > 2 else "dsa"
    print(normalize(symbol, engine))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
