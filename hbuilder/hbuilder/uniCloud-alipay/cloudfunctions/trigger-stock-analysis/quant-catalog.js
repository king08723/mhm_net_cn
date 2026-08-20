'use strict';

/**
 * 量化产品目录（云函数同构）
 * 与 js/quant-catalog.js 保持字段一致；会员规则只引用 productId。
 */

const QUANT_PRODUCTS = {
  dsa: {
    id: 'dsa',
    engine: 'dsa',
    title: '标准投研报告',
    requiredPlan: 'guest',
    enabled: true,
    maxSymbols: 10,
    allowMarketOnly: true,
    defaultMode: 'full',
    forceMode: null,
    multiSymbols: true,
    quotaKey: 'default',
  },
  tradingagents: {
    id: 'tradingagents',
    engine: 'tradingagents',
    title: '多智能体研判',
    requiredPlan: 'guest',
    enabled: true,
    maxSymbols: 1,
    allowMarketOnly: false,
    defaultMode: 'stocks-only',
    forceMode: 'stocks-only',
    multiSymbols: false,
    quotaKey: 'tradingagents',
  },
};

/**
 * 以后只改这里：按登录用户 plan 返回可用产品
 * @param {{ plan?: string } | null | undefined} user
 */
function resolveEntitlements(user) {
  const plan = (user && user.plan) || 'guest';
  const allowedProducts = Object.keys(QUANT_PRODUCTS).filter((id) => QUANT_PRODUCTS[id].enabled);
  return { plan, allowedProducts };
}

/**
 * @param {string} productId
 * @param {{ plan: string, allowedProducts: string[] }} entitlements
 */
function assertProductAllowed(productId, entitlements) {
  const id = String(productId || '').trim().toLowerCase() || 'dsa';
  const product = QUANT_PRODUCTS[id];
  if (!product || !product.enabled) {
    return {
      ok: false,
      code: 'PRODUCT_NOT_FOUND',
      message: '未知或不存在的分析产品。',
    };
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

/**
 * 解析请求中的 product；engine 以目录为准，忽略客户端乱传
 * @param {object} body
 */
function resolveProductFromBody(body) {
  const raw = String((body && (body.product || body.productId)) || '').trim().toLowerCase();
  // 兼容旧前端：无 product 时默认 dsa
  const productId = raw || 'dsa';
  const entitlements = resolveEntitlements(null);
  const gate = assertProductAllowed(productId, entitlements);
  return { productId, entitlements, ...gate };
}

module.exports = {
  QUANT_PRODUCTS,
  resolveEntitlements,
  assertProductAllowed,
  resolveProductFromBody,
};
