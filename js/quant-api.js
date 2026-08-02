/**
 * 云函数 / 公开结果库请求与网关解包
 */
import { JOBS_RAW_BASE, MARKED_SRC, DOMPURIFY_SRC } from './quant-config.js';

/** 解包 uniCloud / 网关常见 { body, statusCode } 外壳 */
export function unwrapGatewayJson(rawResult, httpStatus) {
  let result = rawResult;
  if (rawResult && typeof rawResult === 'object' && ('body' in rawResult || 'statusCode' in rawResult)) {
    if (typeof rawResult.body === 'string') {
      try { result = JSON.parse(rawResult.body); } catch (_) { result = { message: rawResult.body }; }
    } else if (typeof rawResult.body === 'object' && rawResult.body !== null) {
      result = rawResult.body;
    }
  }
  const statusNum = (rawResult && typeof rawResult.statusCode === 'number')
    ? rawResult.statusCode
    : httpStatus;
  return { result, statusNum };
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-quant-lib="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.quantLib = src;
    s.onload = () => {
      s.dataset.loaded = '1';
      resolve();
    };
    s.onerror = () => reject(new Error(`脚本加载失败: ${src}`));
    document.head.appendChild(s);
  });
}

let markdownLibsPromise = null;

/** 首次渲染报告前按需加载 marked + DOMPurify */
export function ensureMarkdownLibs() {
  if (typeof window.marked !== 'undefined' && typeof window.DOMPurify !== 'undefined') {
    return Promise.resolve();
  }
  if (!markdownLibsPromise) {
    markdownLibsPromise = Promise.all([
      loadScriptOnce(MARKED_SRC),
      loadScriptOnce(DOMPURIFY_SRC),
    ]);
  }
  return markdownLibsPromise;
}

/**
 * 历史回看兜底：直接读已发布的 jobs/{jobId}
 * @returns {Promise<object|null>}
 */
export async function fetchJobFromGithubRaw(jobId, hooks = {}) {
  if (!jobId) return null;
  const base = `${JOBS_RAW_BASE}/${encodeURIComponent(jobId)}`;
  const stamp = Date.now();
  try {
    const manifestRes = await fetch(`${base}/manifest.json?t=${stamp}`, { cache: 'no-store' });
    if (!manifestRes.ok) return null;
    const manifest = await manifestRes.json();
    if (!manifest || typeof manifest !== 'object') return null;

    const status = manifest.status || manifest.phase || '';
    const lastManifestUrl = `${base}/manifest.json`;
    if (typeof hooks.onManifest === 'function') {
      hooks.onManifest({
        manifestUrl: lastManifestUrl,
        runId: manifest.runId,
        updatedAt: manifest.updatedAt,
      });
    }

    if (status === 'failed' || status === 'timeout') {
      return {
        success: true,
        ready: false,
        status,
        jobId: manifest.jobId || jobId,
        symbol: manifest.symbol || '',
        error: manifest.error || '分析失败',
        errorCode: manifest.errorCode || 'ANALYSIS_FAILED',
        phase: manifest.phase || status,
        phaseMessage: manifest.phaseMessage || '',
        phaseSource: 'github-manifest',
        source: 'github-job',
        generatedAt: manifest.generatedAt || manifest.finishedAt || 0,
        manifestUrl: lastManifestUrl,
      };
    }

    if (status !== 'succeeded') return null;

    const [reportRes, metricsRes, marketRes] = await Promise.all([
      fetch(`${base}/report.md?t=${stamp}`, { cache: 'no-store' }),
      manifest.hasMetrics === false
        ? Promise.resolve(null)
        : fetch(`${base}/metrics.json?t=${stamp}`, { cache: 'no-store' }),
      (manifest.marketReviewLength > 0 || manifest.marketReviewSha)
        ? fetch(`${base}/market_review.md?t=${stamp}`, { cache: 'no-store' })
        : Promise.resolve(null),
    ]);

    const report = reportRes && reportRes.ok ? await reportRes.text() : '';
    if (!report.trim()) return null;

    let metrics = null;
    if (metricsRes && metricsRes.ok) {
      try { metrics = await metricsRes.json(); } catch (_) { metrics = null; }
    }
    const marketReview = marketRes && marketRes.ok ? await marketRes.text() : '';

    return {
      success: true,
      ready: true,
      status: 'succeeded',
      jobId: manifest.jobId || jobId,
      symbol: manifest.symbol || '',
      report,
      marketReview: marketReview || '',
      metrics,
      phase: 'succeeded',
      phaseMessage: manifest.phaseMessage || '分析已完成',
      phaseSource: 'github-manifest',
      source: 'github-job',
      generatedAt: manifest.generatedAt || manifest.finishedAt || 0,
      runId: manifest.runId || '',
      updatedAt: manifest.updatedAt || 0,
      manifestUrl: lastManifestUrl,
      resultFiles: {
        manifestUrl: lastManifestUrl,
        reportUrl: `${base}/report.md`,
        metricsUrl: `${base}/metrics.json`,
      },
    };
  } catch (_) {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
