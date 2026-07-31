#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 GitHub Actions 生成的 Markdown 报告按 jobId 发布到公开分支。

单链路产物（唯一结果源，不可变）：
  jobs/{jobId}/report.md
  jobs/{jobId}/market_review.md
  jobs/{jobId}/manifest.json

可选索引（不参与任务判定）：
  docs/{SYMBOL}/latest.json  → 指向最新成功 jobId

不再向 uniCloud POST（海外 Runner 连国内网关常被 reset）。
前端 / 云函数只按 jobId 读上述文件。

环境变量：
  JOB_ID                 — 任务 ID（必填）
  SYMBOL                 — 股票代码
  GITHUB_TOKEN           — 写 analysis-results 分支
  GITHUB_REPOSITORY      — owner/repo
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional, Tuple


def _http_json(
    url: str,
    method: str = "GET",
    payload: Optional[dict] = None,
    headers: Optional[dict] = None,
    timeout: int = 45,
) -> Tuple[int, str]:
    data = None
    req_headers = {"User-Agent": "daily-stock-analysis-job-sync/5.0", "Accept": "application/json"}
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


def build_manifest(
    *,
    job_id: str,
    symbol: str,
    status: str,
    report: str,
    market_review: str,
    error: str = "",
) -> dict:
    """构造 jobs/{jobId}/manifest.json。"""
    generated_at = int(time.time() * 1000)
    return {
        "jobId": job_id,
        "symbol": symbol.upper(),
        "status": status,
        "runId": (os.environ.get("GITHUB_RUN_ID") or "").strip(),
        "generatedAt": generated_at,
        "finishedAt": generated_at,
        "reportSha": short_sha(report),
        "marketReviewSha": short_sha(market_review),
        "reportLength": len(report or ""),
        "marketReviewLength": len(market_review or ""),
        "error": error or "",
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


def publish_job_to_github(
    *,
    job_id: str,
    symbol: str,
    report: str,
    market_review: str,
    manifest: dict,
) -> bool:
    """把两份 md + manifest 写到 analysis-results 分支 jobs/{jobId}/，并更新 latest 索引。"""
    token = (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
    repo = (os.environ.get("GITHUB_REPOSITORY") or "").strip()
    branch = (os.environ.get("ANALYSIS_DOCS_BRANCH") or "analysis-results").strip()
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

    # 可选：最新成功结果索引（不参与本次任务判定）
    latest = {
        "jobId": job_id,
        "symbol": symbol.upper(),
        "generatedAt": manifest.get("generatedAt"),
        "runId": manifest.get("runId") or "",
        "status": manifest.get("status"),
        "paths": {
            "report": f"{base}/report.md",
            "marketReview": f"{base}/market_review.md",
            "manifest": f"{base}/manifest.json",
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

    manifest_url = (
        f"https://raw.githubusercontent.com/{repo}/{branch}/{base}/manifest.json"
    )
    manifest["manifestUrl"] = manifest_url

    print(f"✅ GitHub jobs 已写入: {', '.join(written)}")
    print(f"   jobId={job_id} runId={manifest.get('runId')} generatedAt={manifest.get('generatedAt')}")
    print(f"   manifest: {manifest_url}")
    return True


def publish_failed_manifest(*, job_id: str, symbol: str, manifest: dict) -> bool:
    """失败也写一份 manifest，便于云函数按 jobId 返回 failed。"""
    token = (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
    repo = (os.environ.get("GITHUB_REPOSITORY") or "").strip()
    branch = (os.environ.get("ANALYSIS_DOCS_BRANCH") or "analysis-results").strip()
    if not token or not repo:
        print("⚠️ 缺少 GITHUB_TOKEN / GITHUB_REPOSITORY，无法发布失败 manifest")
        return False
    try:
        upsert_github_file(
            token=token,
            repo=repo,
            branch=branch,
            path=f"jobs/{job_id}/manifest.json",
            content_text=json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            message=f"job({job_id}): failed manifest [{symbol}]",
        )
        manifest["manifestUrl"] = (
            f"https://raw.githubusercontent.com/{repo}/{branch}/jobs/{job_id}/manifest.json"
        )
        print(f"✅ 已写入失败 manifest: jobs/{job_id}/manifest.json")
        return True
    except Exception as e:
        print(f"⚠️ 写入失败 manifest 异常: {e}")
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
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
        "--status",
        default="succeeded",
        choices=["succeeded", "failed"],
        help="任务终态",
    )
    parser.add_argument("--error", default="", help="失败原因（status=failed 时）")
    args = parser.parse_args()

    if not args.job_id:
        print("❌ 缺少 jobId：请传 --job-id 或设置环境变量 JOB_ID", file=sys.stderr)
        return 1
    if not args.symbol:
        print("❌ 缺少股票代码：请传 --symbol 或设置环境变量 SYMBOL", file=sys.stderr)
        return 1

    job_id = args.job_id.strip()
    symbol = args.symbol.strip().upper()

    print("=" * 42)
    print(f"🌐 发布分析任务文件: jobId={job_id} symbol={symbol}")
    print("=" * 42)

    report, market_review, _, _ = pick_markdown_pair(Path(args.reports_dir))
    status = args.status
    error = (args.error or "").strip()

    if status == "succeeded" and not report and not market_review:
        print("❌ reports 下没有任何可用 Markdown，标记为 failed", file=sys.stderr)
        status = "failed"
        error = error or "reports 下无可用 Markdown"

    manifest = build_manifest(
        job_id=job_id,
        symbol=symbol,
        status=status,
        report=report if status == "succeeded" else "",
        market_review=market_review if status == "succeeded" else "",
        error=error,
    )
    print(f"manifest: {json.dumps(manifest, ensure_ascii=False)}")

    if status == "succeeded":
        ok = publish_job_to_github(
            job_id=job_id,
            symbol=symbol,
            report=report,
            market_review=market_review,
            manifest=manifest,
        )
    else:
        ok = publish_failed_manifest(job_id=job_id, symbol=symbol, manifest=manifest)

    print(f"✅ 同步完成 github_jobs={ok} status={status}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
