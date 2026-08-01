#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 GitHub Actions 生成的 Markdown 报告按 jobId 发布到公开分支。

路径 3：由编排仓 mhm_net_cn 的 workflow 调用；写入 GITHUB_REPOSITORY
（默认即编排仓）的 analysis-results，上游 daily_stock_analysis 零侵入。

单链路产物（唯一结果源，不可变）：
  jobs/{jobId}/report.md
  jobs/{jobId}/market_review.md
  jobs/{jobId}/manifest.json
  jobs/{jobId}/metrics.json   （成功时强制产出；缺文件则从报告启发式生成）

可选索引（不参与任务判定）：
  docs/{SYMBOL}/latest.json   → 指向最新成功 jobId
  docs/{SYMBOL}/history.json  → 最近 N 次成功摘要

中途进度（供前端真实阶段驱动）：
  python push_unicloud_result.py --phase fetch --phase-message "正在拉取行情…"
  只更新 manifest.json 的 phase / phaseMessage / updatedAt。

不再向 uniCloud POST（海外 Runner 连国内网关常被 reset）。
前端 / 云函数只按 jobId 读上述文件。

环境变量：
  JOB_ID                 — 任务 ID（必填）
  SYMBOL                 — 股票代码
  GITHUB_TOKEN           — 写 analysis-results 分支
  GITHUB_REPOSITORY      — owner/repo（编排仓）
  GITHUB_RUN_ID          — Actions run id（可选，写入 manifest）
  ANALYSIS_DOCS_BRANCH   — 结果分支（默认 analysis-results）
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


VALID_PHASES = {
    "queued",
    "checkout",
    "setup",
    "fetch",
    "analyze",
    "publish",
    "succeeded",
    "failed",
}

# 中间阶段默认 status；终态由 phase 推导
PHASE_STATUS = {
    "queued": "queued",
    "checkout": "running",
    "setup": "running",
    "fetch": "running",
    "analyze": "running",
    "publish": "running",
    "succeeded": "succeeded",
    "failed": "failed",
}

# 默认文案含耗时提示，前端可直接展示
DEFAULT_PHASE_MESSAGES = {
    "queued": "任务已创建，等待 Runner 入队（通常约 10–30 秒）",
    "checkout": "正在检出代码与准备仓库…（通常约 15–30 秒）",
    "setup": "正在初始化分析环境与依赖…（通常约 30–60 秒）",
    "fetch": "正在拉取行情与市场数据…（通常约 30–90 秒）",
    "analyze": "正在运行大模型推理，生成投研观点…（通常约 2–5 分钟，请耐心等待）",
    "publish": "正在整理摘要并发布研究报告…（通常约 20–40 秒）",
    "succeeded": "分析已完成",
    "failed": "分析失败",
}

HISTORY_MAX_ITEMS = 20


def _http_json(
    url: str,
    method: str = "GET",
    payload: Optional[dict] = None,
    headers: Optional[dict] = None,
    timeout: int = 45,
) -> Tuple[int, str]:
    data = None
    req_headers = {"User-Agent": "daily-stock-analysis-job-sync/6.0", "Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req_headers["Content-Type"] = "application/json; charset=utf-8"

    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return int(resp.status), body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        return int(e.code), body


def short_sha(text: str) -> str:
    """内容指纹，便于比对是否同一份报告。"""
    if not text:
        return ""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def now_ms() -> int:
    return int(time.time() * 1000)


def github_auth() -> Tuple[str, str, str]:
    token = (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
    repo = (os.environ.get("GITHUB_REPOSITORY") or "").strip()
    branch = (os.environ.get("ANALYSIS_DOCS_BRANCH") or "analysis-results").strip()
    return token, repo, branch


def build_manifest(
    *,
    job_id: str,
    symbol: str,
    status: str,
    report: str,
    market_review: str,
    error: str = "",
    error_code: str = "",
    phase: str = "",
    phase_message: str = "",
    metrics_text: str = "",
) -> dict:
    """构造 jobs/{jobId}/manifest.json（含 phase / 长度 / sha）。"""
    generated_at = now_ms()
    resolved_phase = (phase or ("succeeded" if status == "succeeded" else status)).strip().lower()
    if resolved_phase not in VALID_PHASES:
        resolved_phase = "succeeded" if status == "succeeded" else ("failed" if status == "failed" else "publish")

    msg = (phase_message or DEFAULT_PHASE_MESSAGES.get(resolved_phase, "")).strip()

    return {
        "jobId": job_id,
        "symbol": symbol.upper(),
        "status": status,
        "phase": resolved_phase,
        "phaseMessage": msg,
        "runId": (os.environ.get("GITHUB_RUN_ID") or "").strip(),
        "updatedAt": generated_at,
        "generatedAt": generated_at if status == "succeeded" else 0,
        "finishedAt": generated_at if status in ("succeeded", "failed", "timeout") else 0,
        "reportSha": short_sha(report),
        "marketReviewSha": short_sha(market_review),
        "reportLength": len(report or ""),
        "marketReviewLength": len(market_review or ""),
        "metricsSha": short_sha(metrics_text),
        "metricsLength": len(metrics_text or ""),
        "hasMetrics": bool(metrics_text and metrics_text.strip()),
        "error": error or "",
        "errorCode": error_code or "",
    }


def build_phase_manifest(
    *,
    job_id: str,
    symbol: str,
    phase: str,
    phase_message: str = "",
    error: str = "",
    error_code: str = "",
) -> dict:
    """中途进度 manifest：不声明报告正文，避免前端误判 EMPTY_REPORT。"""
    phase = phase.strip().lower()
    if phase not in VALID_PHASES:
        raise ValueError(f"非法 phase：{phase}，允许值：{', '.join(sorted(VALID_PHASES))}")

    status = PHASE_STATUS[phase]
    ts = now_ms()
    msg = (phase_message or DEFAULT_PHASE_MESSAGES.get(phase, "")).strip()

    return {
        "jobId": job_id,
        "symbol": (symbol or "").upper(),
        "status": status,
        "phase": phase,
        "phaseMessage": msg,
        "runId": (os.environ.get("GITHUB_RUN_ID") or "").strip(),
        "updatedAt": ts,
        "generatedAt": ts if phase == "succeeded" else 0,
        "finishedAt": ts if phase in ("succeeded", "failed") else 0,
        "reportSha": "",
        "marketReviewSha": "",
        "reportLength": 0,
        "marketReviewLength": 0,
        "metricsSha": "",
        "metricsLength": 0,
        "hasMetrics": False,
        "error": error or "",
        "errorCode": error_code or ("ANALYSIS_FAILED" if phase == "failed" and not error_code else ""),
    }


def pick_markdown_pair(reports_dir: Path) -> Tuple[str, str, str, str]:
    """
    返回 (report_text, market_review_text, report_name, market_name)
    """
    if not reports_dir.exists():
        return "", "", "", ""

    md_files = sorted(
        [p for p in reports_dir.glob("*.md") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    print("reports 目录内容:")
    for p in md_files:
        print(f"  - {p.name} ({p.stat().st_size} bytes)")

    report_path = None
    market_path = None
    for p in md_files:
        name = p.name.lower()
        if "market_review" in name or name.startswith("market"):
            if market_path is None:
                market_path = p
        else:
            if report_path is None:
                report_path = p

    report_text = report_path.read_text(encoding="utf-8", errors="replace").strip() if report_path else ""
    market_text = market_path.read_text(encoding="utf-8", errors="replace").strip() if market_path else ""
    report_name = report_path.name if report_path else ""
    market_name = market_path.name if market_path else ""

    if report_path:
        print(f"个股报告: reports/{report_name} (len={len(report_text)})")
    else:
        print("⚠️ 未找到个股报告 md")
    if market_path:
        print(f"市场复盘: reports/{market_name} (len={len(market_text)})")
    else:
        print("⚠️ 未找到市场复盘 md")

    return report_text, market_text, report_name, market_name


def _first_match(patterns: List[str], text: str, flags: int = re.IGNORECASE) -> str:
    for pat in patterns:
        m = re.search(pat, text, flags)
        if m:
            return (m.group(1) if m.lastindex else m.group(0)).strip()
    return ""


def _extract_levels(text: str, kind: str) -> List[float]:
    """从正文抽取支撑/压力价位（最多 3 个）。"""
    label = "支撑" if kind == "support" else "压力|阻力"
    pattern = rf"(?:{label})[^0-9]{{0,12}}((?:\d{{2,6}}(?:\.\d{{1,3}})?(?:\s*[,，/、]\s*)?){{1,3}})"
    m = re.search(pattern, text)
    if not m:
        return []
    nums = re.findall(r"\d{2,6}(?:\.\d{1,3})?", m.group(1))
    out: List[float] = []
    for n in nums[:3]:
        try:
            out.append(float(n))
        except ValueError:
            continue
    return out


# 报告结论用语（含上游仪表盘「减仓/加仓」等，不能只认买入/卖出）
_RATING_TOKEN = r"(买入|增持|加仓|持有|中性|观望|减持|减仓|卖出)"
_TREND_TOKEN = r"(上行|上涨|偏多|看多|震荡|横盘|下行|下跌|偏空|看空)"


def _normalize_rating(raw: str) -> str:
    """统一展示用语，避免同义结论分裂。"""
    text = (raw or "").strip()
    mapping = {
        "加仓": "买入",
        "增持": "买入",
        "减仓": "卖出",
        "减持": "卖出",
    }
    return mapping.get(text, text)


def _normalize_trend(raw: str) -> str:
    text = (raw or "").strip()
    mapping = {
        "看多": "偏多",
        "上涨": "上行",
        "看空": "偏空",
        "下跌": "下行",
        "横盘": "震荡",
    }
    return mapping.get(text, text)


def _extract_rating_from_dashboard(text: str) -> str:
    """
    解析仪表盘计数行，例如：🟢买入:0 🟡观望:0 🔴卖出:1
    只认「数量 > 0」的类别，避免把「买入:0」误判为买入。
    """
    counts = {
        "买入": 0,
        "观望": 0,
        "卖出": 0,
    }
    for key in counts:
        m = re.search(rf"{key}\s*[:：]\s*(\d+)", text)
        if m:
            counts[key] = int(m.group(1))
    # 有明确多数时采用；并列则放弃交给后续规则
    ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    if ranked and ranked[0][1] > 0 and (len(ranked) == 1 or ranked[0][1] > ranked[1][1]):
        return ranked[0][0]
    return ""


def _extract_rating_from_report(text: str) -> str:
    """按优先级抽取操作结论，避免正文里先出现的「买入:0」污染结果。"""
    # 1) 核心结论块：`**🟠 减仓** | 看空`
    rating = _first_match(
        [
            rf"核心结论[\s\S]{{0,120}}?\*\*[^*]*?{_RATING_TOKEN}\*\*",
            rf"\*\*[^*]*?{_RATING_TOKEN}\*\*\s*\|\s*{_TREND_TOKEN}",
        ],
        text,
    )
    if rating:
        return _normalize_rating(rating)

    # 2) 分析结果摘要行：`中芯国际(00981.HK)**: 减仓 | 评分 31 | 看空`
    rating = _first_match(
        [
            rf"分析结果摘要[\s\S]{{0,200}}?{_RATING_TOKEN}\s*\|",
            rf"\*\*[^*]+\)\*\*:\s*{_RATING_TOKEN}\s*\|",
            rf"\):\s*{_RATING_TOKEN}\s*\|\s*(?:评分|看)",
        ],
        text,
    )
    if rating:
        return _normalize_rating(rating)

    # 3) 仪表盘计数（只认 >0）
    rating = _extract_rating_from_dashboard(text)
    if rating:
        return _normalize_rating(rating)

    # 4) 显式标签；禁止裸匹配「买入:0」这类计数
    rating = _first_match(
        [
            rf"(?:综合(?:评级|观点|建议)|投资建议|操作建议|操作结论|评级)[:：\s]*[*【\[]?\s*{_RATING_TOKEN}",
            rf"(?<![🟢🟡🔴\w]){_RATING_TOKEN}(?!\s*[:：]\s*\d)",
        ],
        text,
    )
    return _normalize_rating(rating) if rating else ""


def extract_metrics_from_report(report: str, symbol: str) -> Dict[str, Any]:
    """
    从 Markdown 报告启发式抽取结构化摘要。
    无法可靠抽取时给出保守默认值，保证前端摘要卡始终可展示。
    """
    text = report or ""
    rating = _extract_rating_from_report(text)

    risk = _first_match(
        [
            r"(?:风险(?:等级|级别)|风险提示)[:：\s]*[*【\[]?\s*(高|中高|中|中低|低)",
            r"判定为\s*(高|中高|中|中低|低)\s*置信度",
        ],
        text,
    )
    # 「中置信度」是置信度措辞，不是风险等级；若只命中置信度则不当风险
    if risk and re.search(rf"{re.escape(risk)}\s*置信度", text) and not re.search(
        r"风险(?:等级|级别)|风险提示", text
    ):
        risk = ""

    trend = ""
    # 核心结论 / 摘要行：`减仓 | 评分 31 | 看空` 或 `**减仓** | 看空`
    for pat in (
        rf"\*\*[^*]*?{_RATING_TOKEN}\*\*\s*\|\s*{_TREND_TOKEN}",
        rf"{_RATING_TOKEN}\s*\|\s*评分[^|\n]*\|\s*{_TREND_TOKEN}",
        rf"(?:趋势(?:判断|方向)?|走势)[:：\s]*[*【\[]?\s*{_TREND_TOKEN}",
        rf"({_TREND_TOKEN})趋势",
    ):
        m = re.search(pat, text, flags=re.IGNORECASE)
        if not m:
            continue
        # 多分组时取最后一个趋势组
        if m.lastindex and m.lastindex >= 2:
            trend = (m.group(m.lastindex) or "").strip()
        else:
            trend = (m.group(1) if m.lastindex else m.group(0)).strip()
        if trend:
            break
    trend = _normalize_trend(trend)

    conf_raw = _first_match(
        [
            r"(?:置信度|把握|信心)[:：\s]*(\d{1,3}(?:\.\d+)?)\s*%",
            r"(?:置信度|把握|信心)[:：\s]*(0?\.\d+|1(?:\.0+)?)",
            r"confidence[:：\s]*(\d{1,3}(?:\.\d+)?%?|0?\.\d+)",
            r"(高|中高|中|中低|低)\s*置信度",
        ],
        text,
    )
    confidence: Optional[float] = None
    if conf_raw:
        level_map = {"高": 0.8, "中高": 0.7, "中": 0.55, "中低": 0.4, "低": 0.3}
        if conf_raw in level_map:
            confidence = level_map[conf_raw]
        else:
            raw = conf_raw.replace("%", "").strip()
            try:
                val = float(raw)
                if val > 1:
                    val = val / 100.0
                if 0 <= val <= 1:
                    confidence = round(val, 2)
            except ValueError:
                confidence = None

    # 保守默认：抽不到时不假装高置信
    if not rating:
        rating = "中性"
    if not risk:
        risk = "中"
    if not trend:
        trend = "震荡"
    if confidence is None:
        confidence = 0.55

    degraded: List[str] = []
    if rating == "中性" and "中性" not in text and "持有" not in text:
        degraded.append("rating-heuristic")
    if "置信度" not in text and "confidence" not in text.lower():
        degraded.append("confidence-default")

    return {
        "rating": rating,
        "confidence": confidence,
        "trend": trend,
        "supportLevels": _extract_levels(text, "support"),
        "resistanceLevels": _extract_levels(text, "resistance"),
        "riskLevel": risk,
        "dataAsOf": now_ms(),
        "modelVersion": "report-heuristic-v2",
        "realtimeEnabled": str(os.environ.get("ENABLE_REALTIME_QUOTE", "")).lower() in ("1", "true", "yes"),
        "degradedFeatures": degraded,
        "symbol": (symbol or "").upper(),
        "source": "report-heuristic",
    }


def ensure_metrics_text(
    *,
    reports_dir: Path,
    metrics_path: str,
    report: str,
    symbol: str,
) -> str:
    """
    成功发布时强制产出 metrics：
    1) 显式 --metrics-file / reports/metrics.json
    2) 否则从报告启发式生成
    """
    text = load_optional_metrics(reports_dir, metrics_path)
    if text:
        # 校验是否为合法 JSON 对象
        try:
            obj = json.loads(text)
            if isinstance(obj, dict) and obj:
                # 补齐关键字段，避免前端空卡
                if "dataAsOf" not in obj:
                    obj["dataAsOf"] = now_ms()
                if "symbol" not in obj and symbol:
                    obj["symbol"] = symbol.upper()
                return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
        except json.JSONDecodeError:
            print("⚠️ metrics.json 非法，将改为从报告生成")

    metrics = extract_metrics_from_report(report, symbol)
    print(
        f"metrics: 已从报告启发式生成 "
        f"rating={metrics.get('rating')} risk={metrics.get('riskLevel')} "
        f"trend={metrics.get('trend')} confidence={metrics.get('confidence')}"
    )
    return json.dumps(metrics, ensure_ascii=False, indent=2) + "\n"


def load_optional_metrics(reports_dir: Path, metrics_path: str = "") -> str:
    """读取可选 metrics.json 文本。"""
    candidates = []
    if metrics_path:
        candidates.append(Path(metrics_path))
    candidates.append(Path(reports_dir) / "metrics.json")
    candidates.append(Path("metrics.json"))
    for p in candidates:
        if p.is_file():
            text = p.read_text(encoding="utf-8", errors="replace").strip()
            if text:
                print(f"metrics: {p} (len={len(text)})")
                return text
    return ""


def upsert_github_file(
    *,
    token: str,
    repo: str,
    branch: str,
    path: str,
    content_text: str,
    message: str,
) -> str:
    api = f"https://api.github.com/repos/{repo}/contents/{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    # 确保分支存在
    ref_url = f"https://api.github.com/repos/{repo}/git/ref/heads/{branch}"
    st, ref_body = _http_json(ref_url, headers=headers, timeout=30)
    if st == 404:
        st_main, main_body = _http_json(
            f"https://api.github.com/repos/{repo}/git/ref/heads/main",
            headers=headers,
            timeout=30,
        )
        if st_main >= 400:
            st_main, main_body = _http_json(
                f"https://api.github.com/repos/{repo}/git/ref/heads/master",
                headers=headers,
                timeout=30,
            )
        if st_main >= 400:
            raise RuntimeError(f"无法读取默认分支 ref: {st_main} {main_body[:200]}")
        base_sha = json.loads(main_body)["object"]["sha"]
        st_create, create_body = _http_json(
            f"https://api.github.com/repos/{repo}/git/refs",
            method="POST",
            payload={"ref": f"refs/heads/{branch}", "sha": base_sha},
            headers=headers,
            timeout=30,
        )
        if st_create >= 300 and st_create != 422:
            raise RuntimeError(f"创建分支失败: {st_create} {create_body[:200]}")
        print(f"created branch: {branch}")

    st_get, get_body = _http_json(f"{api}?ref={branch}", headers=headers, timeout=30)
    sha = None
    if st_get == 200:
        try:
            sha = json.loads(get_body).get("sha")
        except Exception:
            sha = None

    put_payload = {
        "message": message,
        "content": base64.b64encode(content_text.encode("utf-8")).decode("ascii"),
        "branch": branch,
    }
    if sha:
        put_payload["sha"] = sha

    st_put, put_body = _http_json(api, method="PUT", payload=put_payload, headers=headers, timeout=45)
    if st_put >= 300:
        raise RuntimeError(f"写入 GitHub 文件失败: {st_put} {put_body[:300]}")
    return path


def read_github_file(*, token: str, repo: str, branch: str, path: str) -> str:
    """读取 analysis-results 上已有文件（用于合并 history）。"""
    api = f"https://api.github.com/repos/{repo}/contents/{path}?ref={branch}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    st, body = _http_json(api, headers=headers, timeout=30)
    if st == 200 and body:
        return body
    return ""


def build_history_entry(manifest: dict, metrics: Optional[dict]) -> dict:
    m = metrics or {}
    return {
        "jobId": manifest.get("jobId"),
        "symbol": manifest.get("symbol"),
        "generatedAt": manifest.get("generatedAt") or now_ms(),
        "runId": manifest.get("runId") or "",
        "status": manifest.get("status"),
        "rating": m.get("rating") or "",
        "riskLevel": m.get("riskLevel") or "",
        "trend": m.get("trend") or "",
        "confidence": m.get("confidence"),
    }


def merge_history(existing_text: str, entry: dict) -> str:
    """合并并截断历史列表。"""
    items: List[dict] = []
    if existing_text.strip():
        try:
            data = json.loads(existing_text)
            if isinstance(data, list):
                items = [x for x in data if isinstance(x, dict)]
            elif isinstance(data, dict):
                for key in ("jobs", "history", "items"):
                    if isinstance(data.get(key), list):
                        items = [x for x in data[key] if isinstance(x, dict)]
                        break
        except json.JSONDecodeError:
            items = []

    job_id = entry.get("jobId")
    items = [x for x in items if x.get("jobId") != job_id]
    items.insert(0, entry)
    items = items[:HISTORY_MAX_ITEMS]
    payload = {
        "symbol": entry.get("symbol") or "",
        "updatedAt": now_ms(),
        "jobs": items,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def publish_phase_manifest(*, job_id: str, symbol: str, manifest: dict) -> bool:
    """中途/失败阶段：只写 manifest.json。"""
    token, repo, branch = github_auth()
    if not token or not repo:
        print("⚠️ 缺少 GITHUB_TOKEN / GITHUB_REPOSITORY，无法发布 phase manifest")
        return False
    try:
        path = f"jobs/{job_id}/manifest.json"
        upsert_github_file(
            token=token,
            repo=repo,
            branch=branch,
            path=path,
            content_text=json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            message=f"job({job_id}): phase={manifest.get('phase')} [{symbol}]",
        )
        manifest["manifestUrl"] = (
            f"https://raw.githubusercontent.com/{repo}/{branch}/{path}"
        )
        print(f"✅ 已更新 phase manifest: {path} phase={manifest.get('phase')}")
        print(f"   {manifest['manifestUrl']}")
        return True
    except Exception as e:
        print(f"⚠️ 写入 phase manifest 异常: {e}")
        return False


def publish_job_to_github(
    *,
    job_id: str,
    symbol: str,
    report: str,
    market_review: str,
    manifest: dict,
    metrics_text: str = "",
) -> bool:
    """把两份 md + metrics + manifest 写到 analysis-results，并更新 latest/history。"""
    token, repo, branch = github_auth()
    if not token or not repo:
        print("⚠️ 缺少 GITHUB_TOKEN / GITHUB_REPOSITORY，无法发布 jobs")
        return False
    if not report and not market_review:
        print("⚠️ 两份报告均为空，跳过 GitHub jobs 发布")
        return False

    base = f"jobs/{job_id}"
    written = []
    if report:
        p = upsert_github_file(
            token=token,
            repo=repo,
            branch=branch,
            path=f"{base}/report.md",
            content_text=report,
            message=f"job({job_id}): update report.md [{symbol}]",
        )
        written.append(p)
    if market_review:
        p = upsert_github_file(
            token=token,
            repo=repo,
            branch=branch,
            path=f"{base}/market_review.md",
            content_text=market_review,
            message=f"job({job_id}): update market_review.md [{symbol}]",
        )
        written.append(p)

    # 成功路径强制写 metrics.json
    if not metrics_text.strip():
        metrics_text = ensure_metrics_text(
            reports_dir=Path("reports"),
            metrics_path="",
            report=report,
            symbol=symbol,
        )
        # 回填 manifest 的 metrics 元数据
        manifest["metricsSha"] = short_sha(metrics_text)
        manifest["metricsLength"] = len(metrics_text)
        manifest["hasMetrics"] = True

    p = upsert_github_file(
        token=token,
        repo=repo,
        branch=branch,
        path=f"{base}/metrics.json",
        content_text=metrics_text if metrics_text.endswith("\n") else metrics_text + "\n",
        message=f"job({job_id}): update metrics.json [{symbol}]",
    )
    written.append(p)

    # manifest 最后写：云函数用它判定任务是否完成
    manifest_path = upsert_github_file(
        token=token,
        repo=repo,
        branch=branch,
        path=f"{base}/manifest.json",
        content_text=json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        message=f"job({job_id}): update manifest.json [{symbol}]",
    )
    written.append(manifest_path)

    metrics_obj: Optional[dict] = None
    try:
        metrics_obj = json.loads(metrics_text)
    except json.JSONDecodeError:
        metrics_obj = None

    # 最新成功结果索引
    latest = {
        "jobId": job_id,
        "symbol": symbol.upper(),
        "generatedAt": manifest.get("generatedAt"),
        "runId": manifest.get("runId") or "",
        "status": manifest.get("status"),
        "phase": manifest.get("phase") or "",
        "rating": (metrics_obj or {}).get("rating") or "",
        "riskLevel": (metrics_obj or {}).get("riskLevel") or "",
        "paths": {
            "report": f"{base}/report.md",
            "marketReview": f"{base}/market_review.md",
            "manifest": f"{base}/manifest.json",
            "metrics": f"{base}/metrics.json",
        },
    }
    upsert_github_file(
        token=token,
        repo=repo,
        branch=branch,
        path=f"docs/{symbol.upper()}/latest.json",
        content_text=json.dumps(latest, ensure_ascii=False, indent=2) + "\n",
        message=f"docs({symbol}): update latest.json → {job_id}",
    )

    # 历史摘要（前端历史面板）
    hist_path = f"docs/{symbol.upper()}/history.json"
    existing_hist = read_github_file(token=token, repo=repo, branch=branch, path=hist_path)
    hist_text = merge_history(existing_hist, build_history_entry(manifest, metrics_obj))
    upsert_github_file(
        token=token,
        repo=repo,
        branch=branch,
        path=hist_path,
        content_text=hist_text,
        message=f"docs({symbol}): update history.json → {job_id}",
    )

    manifest_url = (
        f"https://raw.githubusercontent.com/{repo}/{branch}/{base}/manifest.json"
    )
    manifest["manifestUrl"] = manifest_url

    print(f"✅ GitHub jobs 已写入: {', '.join(written)}")
    print(f"   jobId={job_id} runId={manifest.get('runId')} phase={manifest.get('phase')}")
    print(f"   hasMetrics={manifest.get('hasMetrics')} metricsLen={manifest.get('metricsLength')}")
    print(f"   manifest: {manifest_url}")
    return True


def publish_failed_manifest(*, job_id: str, symbol: str, manifest: dict) -> bool:
    """失败也写一份 manifest，便于云函数按 jobId 返回 failed。"""
    return publish_phase_manifest(job_id=job_id, symbol=symbol, manifest=manifest)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="发布 jobs/{jobId}/ 结果，或中途更新 manifest.phase"
    )
    parser.add_argument(
        "--job-id",
        default=os.environ.get("JOB_ID", "").strip(),
        help="任务 ID（也可用环境变量 JOB_ID）",
    )
    parser.add_argument(
        "--symbol",
        default=os.environ.get("SYMBOL", "").strip(),
        help="股票代码（也可用环境变量 SYMBOL）",
    )
    parser.add_argument("--reports-dir", default="reports")
    parser.add_argument(
        "--metrics-file",
        default="",
        help="可选 metrics.json 路径（默认尝试 reports/metrics.json；缺失则启发式生成）",
    )
    parser.add_argument(
        "--status",
        default="succeeded",
        choices=["succeeded", "failed"],
        help="任务终态（与 --phase 互斥：有 --phase 时按 phase 推导 status）",
    )
    parser.add_argument("--error", default="", help="失败原因（status=failed 时）")
    parser.add_argument(
        "--error-code",
        default="",
        help="错误码（如 ANALYSIS_FAILED）",
    )
    parser.add_argument(
        "--phase",
        default="",
        choices=sorted(VALID_PHASES),
        help="中途/终态阶段；仅写 manifest 时用中间 phase；终态发布也会写入 phase",
    )
    parser.add_argument(
        "--phase-message",
        default="",
        help="阶段说明文案（写入 manifest.phaseMessage）",
    )
    parser.add_argument(
        "--phase-only",
        action="store_true",
        help="强制只更新 manifest phase（不读 reports、不写 md）",
    )
    args = parser.parse_args()

    if not args.job_id:
        print("❌ 缺少 jobId：请传 --job-id 或设置环境变量 JOB_ID", file=sys.stderr)
        return 1

    job_id = args.job_id.strip()
    symbol = args.symbol.strip().upper()

    # 中途进度模式：只写 manifest.phase
    is_mid_phase = bool(args.phase) and args.phase not in ("succeeded", "failed") and not args.error
    if args.phase_only or is_mid_phase:
        if not args.phase:
            print("❌ --phase-only 需要同时指定 --phase", file=sys.stderr)
            return 1
        if not symbol:
            symbol = (os.environ.get("SYMBOL") or "").strip().upper() or "UNKNOWN"
        print("=" * 42)
        print(f"📡 更新任务阶段: jobId={job_id} phase={args.phase}")
        print("=" * 42)
        try:
            manifest = build_phase_manifest(
                job_id=job_id,
                symbol=symbol,
                phase=args.phase,
                phase_message=args.phase_message,
                error=args.error,
                error_code=args.error_code,
            )
        except ValueError as e:
            print(f"❌ {e}", file=sys.stderr)
            return 1
        print(f"manifest: {json.dumps(manifest, ensure_ascii=False)}")
        ok = publish_phase_manifest(job_id=job_id, symbol=symbol, manifest=manifest)
        return 0 if ok else 1

    if not symbol:
        print("❌ 缺少股票代码：请传 --symbol 或设置环境变量 SYMBOL", file=sys.stderr)
        return 1

    print("=" * 42)
    print(f"🌐 发布分析任务文件: jobId={job_id} symbol={symbol}")
    print("=" * 42)

    report, market_review, _, _ = pick_markdown_pair(Path(args.reports_dir))
    status = args.status
    error = (args.error or "").strip()
    error_code = (args.error_code or "").strip()

    if status == "succeeded" and not report and not market_review:
        print("❌ reports 下没有任何可用 Markdown，标记为 failed", file=sys.stderr)
        status = "failed"
        error = error or "reports 下无可用 Markdown"
        error_code = error_code or "EMPTY_REPORT"

    metrics_text = ""
    if status == "succeeded":
        metrics_text = ensure_metrics_text(
            reports_dir=Path(args.reports_dir),
            metrics_path=args.metrics_file,
            report=report or market_review,
            symbol=symbol,
        )

    # 终态 phase：优先用参数，否则按 status
    terminal_phase = args.phase or ("succeeded" if status == "succeeded" else "failed")
    if status == "succeeded" and terminal_phase not in ("succeeded", "publish"):
        terminal_phase = "succeeded"
    if status == "failed":
        terminal_phase = "failed"

    manifest = build_manifest(
        job_id=job_id,
        symbol=symbol,
        status=status,
        report=report if status == "succeeded" else "",
        market_review=market_review if status == "succeeded" else "",
        error=error,
        error_code=error_code,
        phase=terminal_phase,
        phase_message=args.phase_message,
        metrics_text=metrics_text if status == "succeeded" else "",
    )
    print(f"manifest: {json.dumps(manifest, ensure_ascii=False)}")

    if status == "succeeded":
        ok = publish_job_to_github(
            job_id=job_id,
            symbol=symbol,
            report=report,
            market_review=market_review,
            manifest=manifest,
            metrics_text=metrics_text,
        )
    else:
        ok = publish_failed_manifest(job_id=job_id, symbol=symbol, manifest=manifest)

    print(f"✅ 同步完成 github_jobs={ok} status={status} phase={manifest.get('phase')}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
