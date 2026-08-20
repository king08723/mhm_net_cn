'use strict';

/**
 * 分析任务结果查询 (get-stock-result)
 *
 * 单链路（只认 jobId，GitHub 文件为权威源，DB 保存成功结果缓存）：
 *   GET ?jobId=xxx
 *     → 先看 analysis_jobs（触发失败 / 成功缓存）
 *     → 未命中缓存时读 analysis-results/jobs/{jobId}/manifest.json + md + metrics
 *
 * 读取顺序：raw.githubusercontent → GitHub Contents API → jsDelivr。
 * uniCloud（国内）访问 raw 常超时；不能因单源失败把已成功任务误判为 EMPTY_REPORT。
 */

const crypto = require('crypto');

const ALLOWED_ORIGINS = [
  'https://nhm.net.cn',
  'https://www.nhm.net.cn',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

// 路径 3：结果写在编排仓 analysis-results（与触发 workflow 同仓）
const GITHUB_DOCS_REPO = 'king08723/mhm_net_cn';
const GITHUB_DOCS_BRANCH = 'analysis-results';
const ACTIONS_RUNS_BASE = `https://github.com/${GITHUB_DOCS_REPO}/actions/runs`;
/** 可选：配置后 Contents API 更稳、额度更高 */
const GITHUB_PAT = process.env.GITHUB_PAT || '';

const VALID_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'timeout']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timeout']);
const VALID_PHASES = new Set([
  'queued', 'checkout', 'setup', 'fetch', 'analyze', 'publish', 'succeeded', 'failed',
]);
const FETCH_TIMEOUT_MS = 8000;

function buildCorsHeaders(requestOrigin) {
  const origin = ALLOWED_ORIGINS.includes(requestOrigin)
    ? requestOrigin
    : ALLOWED_ORIGINS[0];

  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function shortHash(text) {
  if (!text) return '';
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

function hashMatches(text, expectedHash) {
  const expected = String(expectedHash || '').trim().toLowerCase();
  if (!expected) return true;
  const value = String(text || '').trim();
  if (!value) return false;
  return shortHash(value) === expected.slice(0, 16);
}

function parseMeta(text) {
  if (!text || !String(text).trim()) return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    return null;
  }
}

function buildRawUrl(filePath, bustCache) {
  const base = `https://raw.githubusercontent.com/${GITHUB_DOCS_REPO}/${GITHUB_DOCS_BRANCH}/${filePath}`;
  return bustCache ? `${base}?t=${Date.now()}` : base;
}

function buildCdnUrl(filePath) {
  return `https://cdn.jsdelivr.net/gh/${GITHUB_DOCS_REPO}@${GITHUB_DOCS_BRANCH}/${filePath}`;
}

function buildGithubApiUrl(filePath) {
  return `https://api.github.com/repos/${GITHUB_DOCS_REPO}/contents/${filePath}?ref=${encodeURIComponent(GITHUB_DOCS_BRANCH)}`;
}

function buildActionsUrl(runId) {
  if (!runId) return '';
  return `${ACTIONS_RUNS_BASE}/${encodeURIComponent(String(runId))}`;
}

/**
 * 通过 GitHub Contents API 拉文本（Accept: raw，国内往往比 raw.githubusercontent 稳）
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function fetchViaGithubApi(filePath) {
  const url = buildGithubApiUrl(filePath);
  const headers = {
    'User-Agent': 'uniCloud-get-stock-result/6.1',
    Accept: 'application/vnd.github.raw',
    'X-GitHub-Api-Version': '2022-11-28',
    'Cache-Control': 'no-cache',
  };
  if (GITHUB_PAT) {
    headers.Authorization = `Bearer ${GITHUB_PAT}`;
  }

  try {
    const res = await uniCloud.httpclient.request(url, {
      method: 'GET',
      dataType: 'text',
      timeout: FETCH_TIMEOUT_MS,
      headers,
    });
    if (!res || res.status !== 200 || res.data == null) return '';
    const text = typeof res.data === 'string' ? res.data : String(res.data);
    return text.trim() ? text : '';
  } catch (e) {
    console.warn('[JOB] GitHub API 拉取失败:', filePath, e.message || e);
    return '';
  }
}

/**
 * 拉取 GitHub 文本：raw → Contents API → CDN
 * @param {string} filePath
 * @param {{ allowCdn?: boolean, bustCache?: boolean, preferApi?: boolean }} options
 * @returns {Promise<string>}
 */
async function fetchTextFile(filePath, options = {}) {
  const allowCdn = options.allowCdn !== false; // 默认允许 CDN 兜底
  const bustCache = options.bustCache !== false;
  const preferApi = options.preferApi === true;

  const attempts = [];
  if (preferApi) {
    attempts.push({ kind: 'api' });
    attempts.push({ kind: 'raw', url: buildRawUrl(filePath, bustCache) });
  } else {
    attempts.push({ kind: 'raw', url: buildRawUrl(filePath, bustCache) });
    attempts.push({ kind: 'api' });
  }
  if (allowCdn) {
    attempts.push({ kind: 'cdn', url: buildCdnUrl(filePath) });
  }

  for (const attempt of attempts) {
    try {
      if (attempt.kind === 'api') {
        const text = await fetchViaGithubApi(filePath);
        if (text) return text;
        continue;
      }

      const res = await uniCloud.httpclient.request(attempt.url, {
        method: 'GET',
        dataType: 'text',
        timeout: FETCH_TIMEOUT_MS,
        headers: {
          'User-Agent': 'uniCloud-get-stock-result/6.1',
          'Cache-Control': 'no-cache, no-store',
          Pragma: 'no-cache',
        },
      });
      if (!res || res.status !== 200 || res.data == null) continue;
      const text = typeof res.data === 'string' ? res.data : String(res.data);
      if (text.trim()) return text;
    } catch (e) {
      console.warn('[JOB] 拉取失败:', attempt.kind, attempt.url || filePath, e.message || e);
    }
  }
  return '';
}

/** manifest 是否声明报告正文已写出 */
function manifestExpectsReport(manifest) {
  const len = Number(manifest.reportLength) || 0;
  const sha = String(manifest.reportSha || '').trim();
  return len > 0 || !!sha;
}

function manifestExpectsMarketReview(manifest) {
  const len = Number(manifest.marketReviewLength) || 0;
  const sha = String(manifest.marketReviewSha || '').trim();
  return len > 0 || !!sha;
}

function manifestExpectsMetrics(manifest) {
  const len = Number(manifest.metricsLength) || 0;
  const sha = String(manifest.metricsSha || '').trim();
  return len > 0 || !!sha || manifest.hasMetrics === true || manifest.metrics === true;
}

/**
 * 归一化 phase；缺省时从 status 推断
 * @param {object} manifest
 * @returns {string}
 */
function resolvePhase(manifest) {
  const raw = String(manifest.phase || '').trim().toLowerCase();
  if (VALID_PHASES.has(raw)) return raw;
  const status = VALID_STATUSES.has(manifest.status) ? manifest.status : '';
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'timeout') return 'failed';
  if (status === 'running') return 'analyze';
  return 'queued';
}

/**
 * 按 jobId 从 GitHub jobs/{jobId}/ 读取结果（唯一结果源）
 * @param {string} jobId
 * @returns {Promise<object|null>}
 */
async function fetchGithubJob(jobId) {
  const base = `jobs/${jobId}`;
  // 刚创建任务：只用 raw，避免 CDN 把 404/旧内容缓存成假排队
  const manifestText = await fetchTextFile(`${base}/manifest.json`, {
    allowCdn: false,
    bustCache: true,
  });
  const manifest = parseMeta(manifestText);
  if (!manifest || !manifest.jobId) return null;

  if (String(manifest.jobId) !== String(jobId)) {
    console.warn('[JOB] manifest jobId 不匹配', manifest.jobId, jobId);
    return null;
  }

  let status = VALID_STATUSES.has(manifest.status) ? manifest.status : 'succeeded';
  const phase = resolvePhase(manifest);
  const phaseMessage = typeof manifest.phaseMessage === 'string' ? manifest.phaseMessage : '';
  const updatedAt = Number(manifest.updatedAt || manifest.finishedAt || manifest.generatedAt) || 0;
  const runId = typeof manifest.runId === 'string' ? manifest.runId : '';
  let error = typeof manifest.error === 'string' ? manifest.error : '';
  let errorCode = typeof manifest.errorCode === 'string' ? manifest.errorCode : '';

  let report = '';
  let marketReview = '';
  let metrics = null;

  if (status === 'succeeded' || phase === 'succeeded' || phase === 'publish') {
    const expectsMarketReview = manifestExpectsMarketReview(manifest);
    const expectsMetrics = manifestExpectsMetrics(manifest);
    // 优先 Contents API：raw 在国内云函数经常超时，曾导致假 EMPTY_REPORT
    const [r, m, metricsText] = await Promise.all([
      fetchTextFile(`${base}/report.md`, { allowCdn: true, bustCache: true, preferApi: true }),
      expectsMarketReview
        ? fetchTextFile(`${base}/market_review.md`, { allowCdn: true, bustCache: true, preferApi: true })
        : Promise.resolve(''),
      expectsMetrics
        ? fetchTextFile(`${base}/metrics.json`, { allowCdn: true, bustCache: true, preferApi: true })
        : Promise.resolve(''),
    ]);
    report = r;
    marketReview = m;
    metrics = parseMeta(metricsText);

    const hasBody = !!(String(report).trim() || String(marketReview).trim());
    const expectsAny = manifestExpectsReport(manifest) || manifestExpectsMarketReview(manifest);

    if (status === 'succeeded' && !hasBody) {
      if (expectsAny) {
        // 产物声明已写出但读取失败：不判终态失败，让前端继续轮询重试
        status = 'running';
        errorCode = errorCode || 'FETCH_FAILED';
        error = error || '报告文件已发布，但云函数读取 GitHub 失败，正在重试…';
      } else {
        status = 'failed';
        errorCode = errorCode || 'EMPTY_REPORT';
        error = error || '任务标记成功，但 jobs/{jobId}/ 下未找到有效 Markdown 报告';
      }
    }
  } else if (TERMINAL_STATUSES.has(status) && status !== 'succeeded') {
    const metricsText = await fetchTextFile(`${base}/metrics.json`, {
      allowCdn: true,
      bustCache: true,
      preferApi: true,
    });
    metrics = parseMeta(metricsText);
  }

  const hasReport = !!(String(report).trim() || String(marketReview).trim());
  if (status === 'succeeded' && hasReport && !errorCode) {
    // 仅当 manifest 声明应有、但实际缺文件时才标 PARTIAL（stocks-only 无复盘属正常）
    const missingExpectedReport = manifestExpectsReport(manifest) && !String(report).trim();
    const missingExpectedMarket = manifestExpectsMarketReview(manifest) && !String(marketReview).trim();
    if (missingExpectedReport || missingExpectedMarket) {
      errorCode = 'PARTIAL_RESULT';
    }
  }

  return {
    jobId: String(manifest.jobId),
    symbol: String(manifest.symbol || '').toUpperCase(),
    product: String(manifest.product || '').trim().toLowerCase(),
    engine: String(manifest.engine || '').trim().toLowerCase(),
    status: status === 'succeeded' && !hasReport ? 'failed' : status,
    phase: (status === 'failed' && !hasReport)
      ? 'failed'
      : (status === 'running' && errorCode === 'FETCH_FAILED' ? 'publish' : phase),
    phaseMessage: errorCode === 'FETCH_FAILED'
      ? (error || phaseMessage)
      : phaseMessage,
    // 来自 GitHub manifest 的阶段，前端可据此驱动真实进度
    phaseSource: 'github-manifest',
    updatedAt,
    generatedAt: Number(manifest.generatedAt) || 0,
    finishedAt: Number(manifest.finishedAt || manifest.generatedAt) || 0,
    runId,
    actionsUrl: buildActionsUrl(runId) || (typeof manifest.actionsUrl === 'string' ? manifest.actionsUrl : ''),
    error,
    errorCode,
    report,
    marketReview,
    metrics,
    reportSha: manifest.reportSha || shortHash(report),
    marketReviewSha: manifest.marketReviewSha || shortHash(marketReview),
    metricsSha: manifest.metricsSha || (metrics ? shortHash(JSON.stringify(metrics)) : ''),
    manifestUrl: `https://raw.githubusercontent.com/${GITHUB_DOCS_REPO}/${GITHUB_DOCS_BRANCH}/${base}/manifest.json`,
    resultFiles: {
      manifestUrl: `https://raw.githubusercontent.com/${GITHUB_DOCS_REPO}/${GITHUB_DOCS_BRANCH}/${base}/manifest.json`,
      reportUrl: `https://raw.githubusercontent.com/${GITHUB_DOCS_REPO}/${GITHUB_DOCS_BRANCH}/${base}/report.md`,
      marketReviewUrl: `https://raw.githubusercontent.com/${GITHUB_DOCS_REPO}/${GITHUB_DOCS_BRANCH}/${base}/market_review.md`,
      metricsUrl: `https://raw.githubusercontent.com/${GITHUB_DOCS_REPO}/${GITHUB_DOCS_BRANCH}/${base}/metrics.json`,
    },
    source: 'github-job',
  };
}

/**
 * 按 jobId 查库（仅用于触发侧失败等本地状态）
 * @param {object} collection
 * @param {string} jobId
 * @returns {Promise<object|null>}
 */
async function findJob(collection, jobId) {
  try {
    const res = await collection.where({ jobId }).limit(1).get();
    if (res.data && res.data.length > 0) return res.data[0];
  } catch (e) {
    console.warn('[DB] 读取失败:', e.message || e);
  }
  return null;
}

/**
 * 可选：把 GitHub 结果回写库；成功正文只作为 DB 缓存，GitHub 仍是权威源
 * @param {object} collection
 * @param {string} jobId
 * @param {object} patch
 */
async function updateJob(collection, jobId, patch) {
  try {
    await collection.where({ jobId }).update(patch);
  } catch (e) {
    console.warn('[DB] 回写失败（不影响返回）:', e.message || e);
  }
}

function isValidCachedResult(job) {
  if (!job || job.status !== 'succeeded') return false;
  const report = String(job.report || '').trim();
  const marketReview = String(job.marketReview || '').trim();
  if (!report && !marketReview) return false;
  if (report && !hashMatches(report, job.reportSha)) return false;
  if (marketReview && !hashMatches(marketReview, job.marketReviewSha)) return false;
  return true;
}

/**
 * 缓存命中时仍回源刷新 metrics，避免摘要启发式修复后 DB 继续返回旧评级
 * @param {string} jobId
 * @returns {Promise<{metrics: object|null, metricsSha: string}>}
 */
async function refreshMetricsFromGithub(jobId) {
  const base = `jobs/${jobId}`;
  const metricsText = await fetchTextFile(`${base}/metrics.json`, {
    allowCdn: true,
    bustCache: true,
    preferApi: true,
  });
  const metrics = parseMeta(metricsText);
  if (!metrics || typeof metrics !== 'object') {
    return { metrics: null, metricsSha: '' };
  }
  return {
    metrics,
    metricsSha: shortHash(JSON.stringify(metrics)),
  };
}

/**
 * 归一化 phaseSource，供前端区分「真实云端阶段」与「DB/本地占位」。
 * 只有 github-manifest 才允许前端进入真实 phase 进度模式。
 * @param {object} job
 * @returns {string}
 */
function resolvePhaseSource(job) {
  const explicit = String(job.phaseSource || '').trim().toLowerCase();
  if (['github-manifest', 'db', 'db-cache', 'pending'].includes(explicit)) {
    return explicit;
  }
  const source = String(job.source || '').trim().toLowerCase();
  if (source === 'github-job') return 'github-manifest';
  if (source === 'db-cache') return 'db-cache';
  if (source === 'pending') return 'pending';
  return 'db';
}

function jobResponse(job) {
  const status = job.status || 'queued';
  const ready = status === 'succeeded' && !!(
    (job.report && String(job.report).trim()) ||
    (job.marketReview && String(job.marketReview).trim())
  );
  const runId = job.runId || '';
  const actionsUrl = job.actionsUrl || buildActionsUrl(runId);
  const source = job.source || 'db';
  const phaseSource = resolvePhaseSource({ ...job, source });

  return {
    success: true,
    ready,
    jobId: job.jobId,
    symbol: job.symbol || '',
    product: job.product || (job.params && job.params.product) || '',
    engine: job.engine || (job.params && job.params.engine) || '',
    status,
    phase: job.phase || (status === 'queued' ? 'queued' : status),
    phaseMessage: job.phaseMessage || '',
    // 进度来源：github-manifest = 可驱动真实阶段；db/pending = 仅占位
    phaseSource,
    updatedAt: Number(job.updatedAt) || 0,
    requestedAt: Number(job.requestedAt) || 0,
    startedAt: Number(job.startedAt) || 0,
    finishedAt: Number(job.finishedAt) || 0,
    generatedAt: Number(job.generatedAt) || 0,
    runId,
    actionsUrl,
    error: job.error || '',
    errorCode: job.errorCode || '',
    report: ready ? (job.report || '') : '',
    marketReview: ready ? (job.marketReview || '') : '',
    metrics: job.metrics || null,
    reportSha: job.reportSha || '',
    marketReviewSha: job.marketReviewSha || '',
    manifestUrl: job.manifestUrl || '',
    resultFiles: job.resultFiles || null,
    source,
  };
}

/**
 * 只有“触发阶段失败”才允许本地短路。
 * 历史版本曾把 GitHub 正文读取超时写成 EMPTY_REPORT，如果继续短路就永远不会再读 GitHub。
 */
function isTriggerStageFailure(job) {
  if (!job || job.status !== 'failed') return false;
  const errorCode = String(job.errorCode || '').trim();
  if (['GITHUB_API_ERROR', 'TRIGGER_FAILED', 'PAT_NOT_CONFIGURED'].includes(errorCode)) {
    return true;
  }

  const error = String(job.error || '');
  const hasGithubEvidence = !!(
    job.manifestUrl ||
    job.reportSha ||
    job.marketReviewSha ||
    job.source === 'github-job' ||
    errorCode === 'EMPTY_REPORT' ||
    errorCode === 'FETCH_FAILED' ||
    /Markdown|报告文件|EMPTY_REPORT|FETCH_FAILED/.test(error)
  );

  // 老版本触发失败没有 errorCode，但也没有任何 GitHub 结果证据。
  return !hasGithubEvidence;
}

exports.main = async (event, context) => {
  const requestOrigin = (event.headers && event.headers.origin) || '';
  const corsHeaders = buildCorsHeaders(requestOrigin);
  const httpMethod = (event.httpMethod || 'GET').toUpperCase();

  if (httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // 已废弃 Actions 回调写入
  if (httpMethod === 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        code: 'METHOD_NOT_ALLOWED',
        message: '结果仅通过 GitHub jobs/{jobId}/ 文件传递，不再接受 POST 回调',
      }),
    };
  }

  let bodyData = {};
  if (typeof event.body === 'string') {
    try { bodyData = JSON.parse(event.body); } catch (_) {}
  } else if (typeof event.body === 'object' && event.body !== null) {
    bodyData = event.body;
  }

  const query = event.queryStringParameters || {};
  const jobId = String(bodyData.jobId || query.jobId || '').trim();
  if (!jobId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        code: 'MISSING_JOB_ID',
        message: '请提供查询参数 jobId',
      }),
    };
  }

  const db = uniCloud.database();
  const collection = db.collection('analysis_jobs');
  const localJob = await findJob(collection, jobId);

  // 仅触发阶段失败才直接返回；历史 EMPTY_REPORT 需要继续读 GitHub 自愈
  if (isTriggerStageFailure(localJob)) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(jobResponse({
        ...localJob,
        phase: 'failed',
        phaseSource: 'db',
        errorCode: localJob.errorCode || 'TRIGGER_FAILED',
        actionsUrl: localJob.actionsUrl || buildActionsUrl(localJob.runId),
        source: 'db',
      })),
    };
  }

  if (isValidCachedResult(localJob)) {
    // 正文走缓存加速；摘要始终尝试回源，防止启发式修正后仍展示旧 rating
    let metrics = localJob.metrics || null;
    try {
      const refreshed = await refreshMetricsFromGithub(jobId);
      if (refreshed.metrics) {
        const oldSha = String(localJob.metricsSha || shortHash(JSON.stringify(localJob.metrics || {})));
        metrics = refreshed.metrics;
        if (refreshed.metricsSha && refreshed.metricsSha !== oldSha) {
          await updateJob(collection, jobId, {
            metrics: refreshed.metrics,
            metricsSha: refreshed.metricsSha,
            updatedAt: Date.now(),
          });
        }
      }
    } catch (e) {
      console.warn('[JOB] 刷新 metrics 失败，沿用缓存:', e.message || e);
    }
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(jobResponse({
        ...localJob,
        metrics,
        // 缓存命中：正文来自 DB，阶段语义仍视为已完成终态
        phaseSource: 'db-cache',
        source: 'db-cache',
      })),
    };
  }

  // 唯一结果源：GitHub jobs/{jobId}/
  let gh = null;
  try {
    gh = await fetchGithubJob(jobId);
  } catch (ghErr) {
    console.warn('[JOB] GitHub 读取异常:', ghErr.message || ghErr);
  }

  if (gh && (TERMINAL_STATUSES.has(gh.status) || gh.phase === 'succeeded' || gh.phase === 'failed')) {
    const hasCacheableBody = !!(String(gh.report || '').trim() || String(gh.marketReview || '').trim());
    const shouldCacheBody = gh.status === 'succeeded'
      && hasCacheableBody
      && (!gh.errorCode || gh.errorCode === 'PARTIAL_RESULT');
    if (localJob) {
      await updateJob(collection, jobId, {
        status: gh.status,
        symbol: gh.symbol || localJob.symbol,
        phase: gh.phase,
        phaseMessage: gh.phaseMessage || '',
        updatedAt: gh.updatedAt || Date.now(),
        generatedAt: gh.generatedAt,
        finishedAt: gh.finishedAt || Date.now(),
        startedAt: Number(localJob.startedAt) || Number(localJob.requestedAt) || Date.now(),
        runId: gh.runId,
        actionsUrl: gh.actionsUrl || '',
        error: gh.error || '',
        errorCode: gh.errorCode || '',
        reportSha: gh.reportSha,
        marketReviewSha: gh.marketReviewSha,
        manifestUrl: gh.manifestUrl,
        metrics: gh.metrics || null,
        metricsSha: gh.metricsSha || (gh.metrics ? shortHash(JSON.stringify(gh.metrics)) : ''),
        // 只缓存已成功且正文非空的结果；失败/读取异常不写正文，避免污染缓存。
        report: shouldCacheBody ? gh.report : '',
        marketReview: shouldCacheBody ? gh.marketReview : '',
        cacheUpdatedAt: shouldCacheBody ? Date.now() : (Number(localJob.cacheUpdatedAt) || 0),
        source: 'github-job',
      });
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(jobResponse({
        ...gh,
        phaseSource: 'github-manifest',
        requestedAt: localJob ? localJob.requestedAt : 0,
        startedAt: localJob
          ? (Number(localJob.startedAt) || Number(localJob.requestedAt) || 0)
          : 0,
      })),
    };
  }

  // 有中间 phase 的 running 产物：透传进度，不视为终态
  if (gh && !TERMINAL_STATUSES.has(gh.status)) {
    if (localJob) {
      await updateJob(collection, jobId, {
        status: gh.status || 'running',
        phase: gh.phase,
        phaseMessage: gh.phaseMessage || '',
        updatedAt: gh.updatedAt || Date.now(),
        runId: gh.runId || localJob.runId || '',
        actionsUrl: gh.actionsUrl || localJob.actionsUrl || '',
        source: 'github-job',
      });
    }
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(jobResponse({
        ...gh,
        status: gh.status || 'running',
        phaseSource: 'github-manifest',
        ready: false,
        report: '',
        marketReview: '',
        requestedAt: localJob ? localJob.requestedAt : 0,
        startedAt: localJob
          ? (Number(localJob.startedAt) || Number(localJob.requestedAt) || 0)
          : 0,
      })),
    };
  }

  // 尚未有 GitHub 产物：返回本地 queued，或未就绪（phaseSource=db，勿当真实阶段）
  if (localJob) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(jobResponse({
        ...localJob,
        status: localJob.status || 'queued',
        phase: localJob.phase || 'queued',
        phaseSource: 'db',
        actionsUrl: localJob.actionsUrl || buildActionsUrl(localJob.runId),
        source: 'db',
      })),
    };
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify(jobResponse({
      jobId,
      status: 'queued',
      phase: 'queued',
      phaseMessage: '分析尚未完成，或 jobs/{jobId}/manifest.json 尚未写入',
      phaseSource: 'pending',
      source: 'pending',
      ready: false,
    })),
  };
};
