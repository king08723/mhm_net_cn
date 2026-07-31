'use strict';

/**
 * 触发量化分析任务 (trigger-stock-analysis)
 *
 * 单链路：持久化限流/去重 → 创建 analysis_jobs → workflow_dispatch(jobId) → 返回 jobId
 * 前端只认 jobId，不再使用 triggeredAt / since。
 */

const https = require('https');
const crypto = require('crypto');

// ============================================================
// 安全配置：PAT 必须通过 uniCloud 云函数控制台的【环境变量】配置
// 变量名：GITHUB_PAT
// ============================================================
const GITHUB_PAT = process.env.GITHUB_PAT;
const REPO_OWNER = 'king08723';
const REPO_NAME = 'daily_stock_analysis';
const WORKFLOW_ID = '00-daily-analysis.yml';
const ACTIONS_WORKFLOW_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_ID}`;

const ALLOWED_ORIGINS = [
  'https://nhm.net.cn',
  'https://www.nhm.net.cn',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_CALLS = 5;
const DAILY_MAX_CALLS = 20;
const DEDUPE_WINDOW_MS = 8 * 60 * 1000;
const RECENT_SUCCEEDED_MS = 10 * 60 * 1000;

const MAX_SYMBOLS_PER_JOB = 10;
const DEFAULT_OPTIONS = {
  mode: 'stocks-only',
  reportType: 'simple',
  reportLanguage: 'zh',
  notificationChannels: [],
  notificationEmail: '',
  includeMarketContext: true,
  multiSymbols: true,
  enableRealtimeQuote: true,
  enableRealtimeTechnicalIndicators: true,
  enableChipDistribution: true,
};
const ALLOWED_MODES = new Set(['full', 'market-only', 'stocks-only']);
const ALLOWED_REPORT_TYPES = new Set(['brief', 'simple', 'full']);
const ALLOWED_REPORT_LANGUAGES = new Set(['zh', 'en', 'ko']);

/** 任务状态 */
const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
};

/**
 * 生成任务 ID：一次点击对应一次任务
 * @returns {string}
 */
function createJobId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString('hex');
  return `job_${ts}_${rand}`;
}

/**
 * 规范化客户端 IP（取 x-forwarded-for 第一段）
 * @param {string} raw
 * @returns {string}
 */
function normalizeClientIp(raw) {
  return String(raw || 'unknown').split(',')[0].trim() || 'unknown';
}

/**
 * 校验股票代码格式
 * @param {string} symbol
 * @returns {boolean}
 */
function isValidSymbol(symbol) {
  if (!symbol || typeof symbol !== 'string') return false;
  const cleaned = symbol.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(cleaned);
}

function normalizeSymbols(raw, allowMultiple) {
  const symbols = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[，、\s]+/g, ',')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!allowMultiple && symbols.length > 1) {
    return { symbols, error: '当前任务不允许多个股票代码。' };
  }
  if (symbols.length > MAX_SYMBOLS_PER_JOB) {
    return { symbols, error: `一次最多分析 ${MAX_SYMBOLS_PER_JOB} 个股票代码。` };
  }
  const invalid = symbols.find((item) => !isValidSymbol(item));
  if (invalid) {
    return { symbols, error: `股票代码格式非法：「${invalid}」。请使用合法格式（如 00700.HK, AAPL, 000001.SZ）。` };
  }

  return { symbols, error: '' };
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function parseChoice(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeNotificationChannels(channels, email) {
  // 当前公网前端只允许新增邮件通知渠道，避免暴露其它推送能力。
  if (!email) return [];
  const list = Array.isArray(channels) ? channels : String(channels || '').split(',');
  return list.map((item) => String(item).trim().toLowerCase()).includes('email')
    ? ['email']
    : ['email'];
}

function normalizeOptions(body) {
  const notificationEmail = String(body.notificationEmail || '').trim();
  return {
    mode: parseChoice(body.mode, ALLOWED_MODES, DEFAULT_OPTIONS.mode),
    reportType: parseChoice(body.reportType, ALLOWED_REPORT_TYPES, DEFAULT_OPTIONS.reportType),
    reportLanguage: parseChoice(body.reportLanguage, ALLOWED_REPORT_LANGUAGES, DEFAULT_OPTIONS.reportLanguage),
    notificationEmail,
    notificationChannels: normalizeNotificationChannels(body.notificationChannels, notificationEmail),
    includeMarketContext: parseBoolean(body.includeMarketContext, DEFAULT_OPTIONS.includeMarketContext),
    multiSymbols: parseBoolean(body.multiSymbols, DEFAULT_OPTIONS.multiSymbols),
    enableRealtimeQuote: parseBoolean(body.enableRealtimeQuote, DEFAULT_OPTIONS.enableRealtimeQuote),
    enableRealtimeTechnicalIndicators: parseBoolean(
      body.enableRealtimeTechnicalIndicators,
      DEFAULT_OPTIONS.enableRealtimeTechnicalIndicators
    ),
    enableChipDistribution: parseBoolean(body.enableChipDistribution, DEFAULT_OPTIONS.enableChipDistribution),
  };
}

/**
 * 生成请求指纹：同标的+同参数短时去重用
 * @param {string} symbol
 * @param {object} options
 * @returns {string}
 */
function buildRequestFingerprint(symbol, options) {
  const payload = [
    String(symbol || '').toUpperCase(),
    options.mode,
    options.reportType,
    options.reportLanguage,
    options.includeMarketContext ? '1' : '0',
    options.enableRealtimeQuote ? '1' : '0',
    options.enableRealtimeTechnicalIndicators ? '1' : '0',
    options.enableChipDistribution ? '1' : '0',
  ].join('|');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 24);
}

/**
 * 构造 CORS 响应头
 * @param {string} requestOrigin
 * @returns {Object}
 */
function buildCorsHeaders(requestOrigin) {
  const origin = ALLOWED_ORIGINS.includes(requestOrigin)
    ? requestOrigin
    : ALLOWED_ORIGINS[0];

  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * 日窗口起始（UTC 日界，足够做配额；个人站无需按本地时区）
 * @param {number} now
 * @returns {number}
 */
function dayWindowStart(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * 持久化限流：短窗 + 日配额，跨实例生效；触发失败也会计入
 * @param {string} clientIp
 * @returns {Promise<{ allowed: boolean, remaining: number, resetIn?: number, code?: string, message?: string }>}
 */
async function checkPersistentRateLimit(clientIp) {
  const db = uniCloud.database();
  const col = db.collection('analysis_rate_limits');
  const now = Date.now();
  const ip = normalizeClientIp(clientIp);

  let docs = [];
  try {
    const res = await col.where({ clientIp: ip }).limit(5).get();
    docs = (res && res.data) || [];
  } catch (e) {
    console.warn('[RATE] 读取限流失败，降级放行:', e.message || e);
    return { allowed: true, remaining: RATE_MAX_CALLS - 1 };
  }

  let doc = docs[0] || null;
  let shortCount = 0;
  let shortStart = now;
  let dayCount = 0;
  let dayStart = dayWindowStart(now);

  if (doc) {
    shortStart = Number(doc.shortWindowStart) || now;
    shortCount = Number(doc.shortCount) || 0;
    dayStart = Number(doc.dayWindowStart) || dayStart;
    dayCount = Number(doc.dayCount) || 0;

    if (now - shortStart > RATE_WINDOW_MS) {
      shortStart = now;
      shortCount = 0;
    }
    if (dayWindowStart(now) !== dayStart) {
      dayStart = dayWindowStart(now);
      dayCount = 0;
    }
  }

  if (shortCount >= RATE_MAX_CALLS) {
    const resetIn = Math.ceil((RATE_WINDOW_MS - (now - shortStart)) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetIn: Math.max(resetIn, 1),
      code: 'RATE_LIMITED',
      message: `触发频率过高，请 ${Math.max(resetIn, 1)} 秒后再试。`,
    };
  }

  if (dayCount >= DAILY_MAX_CALLS) {
    const resetIn = Math.ceil((dayStart + 24 * 60 * 60 * 1000 - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetIn: Math.max(resetIn, 1),
      code: 'DAILY_QUOTA_EXCEEDED',
      message: `今日触发次数已达上限（${DAILY_MAX_CALLS} 次），请明天再试。`,
    };
  }

  shortCount += 1;
  dayCount += 1;
  const patch = {
    clientIp: ip,
    shortWindowStart: shortStart,
    shortCount,
    dayWindowStart: dayStart,
    dayCount,
    updatedAt: now,
  };

  try {
    if (doc && doc._id) {
      await col.doc(doc._id).update(patch);
    } else {
      await col.add({ ...patch, createdAt: now });
    }
  } catch (e) {
    console.warn('[RATE] 写入限流失败（不影响本次触发）:', e.message || e);
  }

  return {
    allowed: true,
    remaining: Math.min(RATE_MAX_CALLS - shortCount, DAILY_MAX_CALLS - dayCount),
  };
}

/**
 * 同 fingerprint 短时去重：复用 queued/running，或提示已有近期成功任务
 * @param {string} fingerprint
 * @param {boolean} forceRun
 * @returns {Promise<object|null>}
 */
async function findDedupeJob(fingerprint, forceRun) {
  if (forceRun || !fingerprint) return null;
  const db = uniCloud.database();
  const now = Date.now();

  try {
    const activeRes = await db.collection('analysis_jobs')
      .where({
        requestFingerprint: fingerprint,
        status: db.command.in([JOB_STATUS.QUEUED, JOB_STATUS.RUNNING]),
        requestedAt: db.command.gte(now - DEDUPE_WINDOW_MS),
      })
      .orderBy('requestedAt', 'desc')
      .limit(1)
      .get();

    if (activeRes.data && activeRes.data.length > 0) {
      return { kind: 'active', job: activeRes.data[0] };
    }

    const doneRes = await db.collection('analysis_jobs')
      .where({
        requestFingerprint: fingerprint,
        status: JOB_STATUS.SUCCEEDED,
        requestedAt: db.command.gte(now - RECENT_SUCCEEDED_MS),
      })
      .orderBy('requestedAt', 'desc')
      .limit(1)
      .get();

    if (doneRes.data && doneRes.data.length > 0) {
      return { kind: 'succeeded', job: doneRes.data[0] };
    }
  } catch (e) {
    console.warn('[DEDUPE] 查询失败，跳过去重:', e.message || e);
  }
  return null;
}

/**
 * 向 GitHub API 发送 workflow_dispatch（携带 jobId 与前端参数）
 * @param {string} symbol
 * @param {string} jobId
 * @param {object} analysisOptions
 * @param {boolean} forceRun
 * @returns {Promise<{statusCode: number, body: string}>}
 */
function dispatchGitHubAction(symbol, jobId, analysisOptions, forceRun) {
  const postData = JSON.stringify({
    ref: 'main',
    inputs: {
      stock_symbol: symbol,
      job_id: jobId,
      mode: analysisOptions.mode,
      // 默认不强制；用户点「重新跑一次」时 force_run=true
      force_run: forceRun ? 'true' : 'false',
      // GitHub workflow_dispatch input 数量有限，扩展参数统一打包为 JSON。
      quant_params: JSON.stringify(analysisOptions),
    },
  });

  const requestOptions = {
    hostname: 'api.github.com',
    port: 443,
    path: `/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_ID}/dispatches`,
    method: 'POST',
    headers: {
      'User-Agent': 'uniCloud-StockAnalysisTrigger/4.0',
      Authorization: `Bearer ${GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve) => {
    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });

    req.on('error', (e) => {
      resolve({ statusCode: 500, body: e.message });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ statusCode: 504, body: 'GitHub API 请求超时' });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * 写入 analysis_jobs
 * @param {object} record
 * @returns {Promise<void>}
 */
async function insertJob(record) {
  const db = uniCloud.database();
  await db.collection('analysis_jobs').add(record);
}

/**
 * 按 jobId 更新任务
 * @param {string} jobId
 * @param {object} patch
 * @returns {Promise<void>}
 */
async function updateJob(jobId, patch) {
  const db = uniCloud.database();
  await db.collection('analysis_jobs').where({ jobId }).update(patch);
}

exports.main = async (event, context) => {
  const requestOrigin = (event.headers && event.headers.origin) || '';
  const clientIp = (event.headers && (
    event.headers['x-forwarded-for'] ||
    event.headers['x-real-ip']
  )) || 'unknown';

  const corsHeaders = buildCorsHeaders(requestOrigin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (!GITHUB_PAT) {
    console.error('[SECURITY] GITHUB_PAT 环境变量未配置，拒绝执行');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        code: 'PAT_NOT_CONFIGURED',
        message: '服务端凭据未正确配置，请联系管理员。',
      }),
    };
  }

  let body = {};
  try {
    const raw = event.body;
    body = typeof raw === 'string' ? JSON.parse(raw) : (raw || event);
  } catch (e) {
    body = event;
  }

  const options = normalizeOptions(body);
  const forceRun = parseBoolean(body.forceRun, false);
  const symbolResult = normalizeSymbols(body.symbol, options.multiSymbols);

  if (symbolResult.error || !symbolResult.symbols.length) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        code: 'INVALID_SYMBOL',
        message: symbolResult.error || '请输入合法股票代码（如 00700.HK, AAPL, 000001.SZ）。',
      }),
    };
  }

  if (!isValidEmail(options.notificationEmail)) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        code: 'INVALID_NOTIFICATION_EMAIL',
        message: '邮件通知地址格式不正确，请检查后重试。',
      }),
    };
  }

  const rawSymbol = symbolResult.symbols.join(',');
  const requestFingerprint = buildRequestFingerprint(rawSymbol, options);
  const ip = normalizeClientIp(clientIp);

  // 先持久化限流（含失败请求），再做去重与派发
  const rateResult = await checkPersistentRateLimit(ip);
  if (!rateResult.allowed) {
    return {
      statusCode: 429,
      headers: {
        ...corsHeaders,
        'Retry-After': String(rateResult.resetIn || 300),
      },
      body: JSON.stringify({
        success: false,
        code: rateResult.code || 'RATE_LIMITED',
        message: rateResult.message || `触发频率过高，请 ${rateResult.resetIn || 300} 秒后再试。`,
        resetIn: rateResult.resetIn,
      }),
    };
  }

  // 同参数短时去重：返回已有 jobId，避免重复烧 Actions
  const dedupe = await findDedupeJob(requestFingerprint, forceRun);
  if (dedupe && dedupe.job) {
    const existing = dedupe.job;
    const reused = {
      success: true,
      reused: true,
      dedupeKind: dedupe.kind,
      message: dedupe.kind === 'active'
        ? '已有相同参数的分析任务进行中，已复用该任务'
        : '近期已有相同参数的成功任务，已复用；如需强制重跑请开启「重新跑一次」',
      jobId: existing.jobId,
      symbol: existing.symbol || rawSymbol,
      status: existing.status || JOB_STATUS.QUEUED,
      phase: existing.phase || (existing.status === JOB_STATUS.SUCCEEDED ? 'succeeded' : 'queued'),
      params: existing.params || options,
      requestedAt: existing.requestedAt || Date.now(),
      remaining: rateResult.remaining,
      actionsUrl: existing.actionsUrl || ACTIONS_WORKFLOW_URL,
      forceRun,
    };
    console.log(`[DEDUPE] 复用任务：jobId=${existing.jobId}, kind=${dedupe.kind}`);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(reused),
    };
  }

  const jobId = createJobId();
  const requestedAt = Date.now();
  const jobRecord = {
    jobId,
    symbol: rawSymbol,
    status: JOB_STATUS.QUEUED,
    phase: 'queued',
    phaseMessage: '任务已创建，等待 Actions 入队',
    requestedAt,
    startedAt: 0,
    finishedAt: 0,
    generatedAt: 0,
    updatedAt: requestedAt,
    runId: '',
    actionsUrl: ACTIONS_WORKFLOW_URL,
    error: '',
    errorCode: '',
    // 正文以 GitHub 为准，库内不长期堆 MD
    report: '',
    marketReview: '',
    reportSha: '',
    marketReviewSha: '',
    manifestUrl: '',
    metrics: null,
    source: '',
    clientIp: ip,
    requestFingerprint,
    forceRun,
    params: {
      mode: options.mode,
      reportType: options.reportType,
      reportLanguage: options.reportLanguage,
      notificationChannels: options.notificationChannels,
      notificationEmail: options.notificationEmail,
      includeMarketContext: options.includeMarketContext,
      multiSymbols: options.multiSymbols,
      enableRealtimeQuote: options.enableRealtimeQuote,
      enableRealtimeTechnicalIndicators: options.enableRealtimeTechnicalIndicators,
      enableChipDistribution: options.enableChipDistribution,
    },
  };

  // 先落库再派发，保证前端拿到的 jobId 一定可查询
  try {
    await insertJob(jobRecord);
  } catch (dbErr) {
    console.error('[JOB] 创建任务失败:', dbErr.message || dbErr);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        code: 'JOB_CREATE_FAILED',
        message: '创建分析任务失败，请稍后重试。',
      }),
    };
  }

  console.log(`[ACTION] 派发工作流：jobId=${jobId}, symbol=${rawSymbol}, mode=${options.mode}, forceRun=${forceRun}, ip=${ip}`);
  const { statusCode, body: githubBody } = await dispatchGitHubAction(rawSymbol, jobId, options, forceRun);

  if (statusCode === 204 || statusCode === 200) {
    console.log(`[ACTION] 成功派发：jobId=${jobId}, symbol=${rawSymbol}`);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        reused: false,
        message: '已创建分析任务并触发工作流',
        jobId,
        symbol: rawSymbol,
        status: JOB_STATUS.QUEUED,
        phase: 'queued',
        params: jobRecord.params,
        requestedAt,
        remaining: rateResult.remaining,
        actionsUrl: ACTIONS_WORKFLOW_URL,
        forceRun,
      }),
    };
  }

  // 派发失败：标记任务失败
  const friendlyMessages = {
    401: '服务端 GitHub 凭据无效，请联系管理员更新配置。',
    403: '服务端凭据权限不足，请联系管理员检查 PAT 权限范围。',
    404: '目标工作流不存在，请联系管理员检查仓库与工作流配置。',
    422: '工作流触发参数有误，请检查股票代码输入。',
    504: 'GitHub API 请求超时，请稍后重试。',
  };
  const failMessage = friendlyMessages[statusCode]
    || `GitHub Actions 触发失败（状态码 ${statusCode}），请稍后重试。`;

  console.error(`[ACTION] 派发失败：jobId=${jobId}, statusCode=${statusCode}, body=${githubBody}`);
  try {
    await updateJob(jobId, {
      status: JOB_STATUS.FAILED,
      phase: 'failed',
      finishedAt: Date.now(),
      updatedAt: Date.now(),
      error: failMessage,
      errorCode: 'GITHUB_API_ERROR',
    });
  } catch (updErr) {
    console.warn('[JOB] 更新失败状态异常:', updErr.message || updErr);
  }

  return {
    statusCode: 502,
    headers: corsHeaders,
    body: JSON.stringify({
      success: false,
      code: 'GITHUB_API_ERROR',
      message: failMessage,
      jobId,
      status: JOB_STATUS.FAILED,
      phase: 'failed',
      actionsUrl: ACTIONS_WORKFLOW_URL,
    }),
  };
};
