/**
 * 量化产品目录（前端）
 *
 * 稳定 productId 供会员规则引用；本阶段 guest 开放全部已上线产品。
 * 云函数内有同构校验，不能只信前端。
 */

import {
  POLL_DEADLINE_MS,
  STEPS,
  PHASE_ETA,
  ANALYZE_SIM_MESSAGES,
} from './quant-config.js';

/** @typedef {'guest'|'plus'|'pro'} PlanId */

/**
 * @typedef {object} ProductCapabilities
 * @property {boolean} multiSymbols
 * @property {boolean} marketOnly
 * @property {boolean} marketContext
 * @property {boolean} realtimeQuote
 * @property {boolean} realtimeTech
 * @property {boolean} chipDistribution
 * @property {boolean} researchDepth
 */

/**
 * @typedef {object} QuantProduct
 * @property {string} id
 * @property {string} engine
 * @property {string} title
 * @property {string} subtitle
 * @property {string} description
 * @property {PlanId} requiredPlan
 * @property {boolean} enabled
 * @property {string} badge
 * @property {string} etaHint
 * @property {number} pollDeadlineMs
 * @property {string} quotaKey
 * @property {ProductCapabilities} capabilities
 * @property {string} symbolPlaceholder
 * @property {string} symbolHint
 */

/** @type {QuantProduct[]} */
export const QUANT_PRODUCTS = [
  {
    id: 'dsa',
    engine: 'dsa',
    title: '标准投研报告',
    subtitle: '决策仪表盘',
    description: '整合行情、技术指标、市场环境与大模型推理，支持多标的与大盘复盘。',
    requiredPlan: 'guest',
    enabled: true,
    badge: '开放体验',
    etaHint: '通常约 3–8 分钟',
    pollDeadlineMs: POLL_DEADLINE_MS,
    quotaKey: 'default',
    capabilities: {
      multiSymbols: true,
      marketOnly: true,
      marketContext: true,
      realtimeQuote: true,
      realtimeTech: true,
      chipDistribution: true,
      researchDepth: false,
    },
    symbolPlaceholder: '例: 00700.HK, AAPL, 600519.SH（逗号分隔）',
    symbolHint: '支持 A 股 / 港股 / 美股，可一次输入多个标的',
  },
  {
    id: 'tradingagents',
    engine: 'tradingagents',
    title: '多智能体研判',
    subtitle: 'TradingAgents',
    description: '多角色分析师辩论后给出交易决策；单标的、耗时更长，适合深度复盘。',
    requiredPlan: 'guest',
    enabled: true,
    badge: '开放体验',
    etaHint: '通常约 10–30 分钟',
    pollDeadlineMs: 35 * 60 * 1000,
    quotaKey: 'tradingagents',
    capabilities: {
      multiSymbols: false,
      marketOnly: false,
      marketContext: false,
      realtimeQuote: false,
      realtimeTech: false,
      chipDistribution: false,
      researchDepth: true,
    },
    symbolPlaceholder: '例: AAPL 或 0700.HK（仅单个标的）',
    symbolHint: '多智能体模式仅支持单个股票代码',
  },
  {
    id: 'custom-agent',
    engine: '',
    title: '自定义策略问股',
    subtitle: '即将推出',
    description: '按会员等级开放的专属策略与会话能力（占位，暂不可用）。',
    requiredPlan: 'plus',
    enabled: false,
    badge: '会员预留',
    etaHint: '',
    pollDeadlineMs: POLL_DEADLINE_MS,
    quotaKey: 'custom-agent',
    capabilities: {
      multiSymbols: false,
      marketOnly: false,
      marketContext: false,
      realtimeQuote: false,
      realtimeTech: false,
      chipDistribution: false,
      researchDepth: false,
    },
    symbolPlaceholder: '',
    symbolHint: '',
  },
];

export const DEFAULT_PRODUCT_ID = 'dsa';

/**
 * 以后只改这里：按登录用户 plan 返回可用产品
 * @param {{ plan?: PlanId } | null | undefined} user
 */
export function resolveEntitlements(user) {
  const plan = (user && user.plan) || 'guest';
  // 本阶段：guest 开放全部 enabled 产品
  const allowedProducts = QUANT_PRODUCTS.filter((p) => p.enabled).map((p) => p.id);
  return { plan, allowedProducts };
}

/**
 * @param {string} productId
 * @returns {QuantProduct | null}
 */
export function getProduct(productId) {
  const id = String(productId || '').trim().toLowerCase();
  return QUANT_PRODUCTS.find((p) => p.id === id) || null;
}

/**
 * @param {string} productId
 * @param {{ plan?: PlanId, allowedProducts: string[] }} entitlements
 */
export function assertProductAllowed(productId, entitlements) {
  const product = getProduct(productId);
  if (!product || !product.enabled) {
    return { ok: false, code: 'PRODUCT_NOT_FOUND', message: '未知或不存在的分析产品。' };
  }
  if (!entitlements.allowedProducts.includes(product.id)) {
    return {
      ok: false,
      code: 'PRODUCT_NOT_ALLOWED',
      message: `当前身份（${entitlements.plan}）暂不可使用「${product.title}」，后续将按会员等级开放。`,
    };
  }
  return { ok: true, product };
}

/** TradingAgents 进度文案（更长分析阶段） */
export const TA_STEPS = [
  { id: 'dispatch', phase: 'queued', icon: 'paperPlane', label: '创建分析任务', desc: '正在创建多智能体研判任务…', duration: 5 },
  { id: 'queue', phase: 'checkout', icon: 'layers', label: '云端算力排队', desc: '云端算力已接受请求，正在排队分配分析资源…', duration: 20 },
  { id: 'env', phase: 'setup', icon: 'server', label: '初始化多智能体', desc: '正在加载分析师、研究员与风控组件…', duration: 60 },
  { id: 'fetch', phase: 'fetch', icon: 'database', label: '拉取行情与资讯', desc: '正在拉取行情、新闻与基本面数据…', duration: 90 },
  { id: 'compute', phase: 'analyze', icon: 'cpu', label: '多智能体辩论', desc: '分析师与研究员交叉辩论，生成交易决策…', duration: 600 },
  { id: 'output', phase: 'publish', icon: 'chart', label: '生成研究报告', desc: '正在汇总各方观点，生成完整报告…', duration: 45 },
];

export const TA_PHASE_ETA = {
  queued: { typical: '约 10–30 秒', remainMin: 12, remainMax: 25 },
  checkout: { typical: '约 20–40 秒', remainMin: 11, remainMax: 22 },
  setup: { typical: '约 40–90 秒', remainMin: 10, remainMax: 20 },
  fetch: { typical: '约 1–3 分钟', remainMin: 8, remainMax: 18 },
  analyze: { typical: '约 8–20 分钟', remainMin: 5, remainMax: 15 },
  publish: { typical: '约 30–60 秒', remainMin: 0, remainMax: 1 },
};

export const TA_ANALYZE_SIM_MESSAGES = [
  '市场分析师正在解读量价结构…',
  '情绪分析师正在汇总舆情与社交信号…',
  '新闻分析师正在评估宏观与事件冲击…',
  '基本面分析师正在核对财务与估值…',
  '多头与空头研究员正在交叉辩论…',
  '研究经理正在权衡收益与风险…',
  '交易员正在拟定仓位与时机…',
  '风控团队正在评估波动与回撤…',
  '组合经理正在形成最终决策…',
  '正在汇总多智能体报告，请稍候…',
];

export const TA_VIRTUAL_STEP_SECONDS = [3, 8, 15, 30, 480, 40];

/**
 * 按产品取进度配置
 * @param {string} productId
 */
export function getProgressProfile(productId) {
  if (productId === 'tradingagents') {
    return {
      steps: TA_STEPS,
      phaseEta: TA_PHASE_ETA,
      analyzeMessages: TA_ANALYZE_SIM_MESSAGES,
      virtualStepSeconds: TA_VIRTUAL_STEP_SECONDS,
      pollDeadlineMs: 35 * 60 * 1000,
      virtualProgressCap: 72,
    };
  }
  return {
    steps: STEPS,
    phaseEta: PHASE_ETA,
    analyzeMessages: ANALYZE_SIM_MESSAGES,
    virtualStepSeconds: null,
    pollDeadlineMs: POLL_DEADLINE_MS,
    virtualProgressCap: 68,
  };
}
