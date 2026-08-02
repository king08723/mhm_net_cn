/**
 * 将 partials 注入各 HTML 的 inject:header / inject:footer 标记区。
 * 用法：node scripts/inject_partials.js
 * 根据 <html data-nav="index|services|portfolio|quant|contact|none"> 高亮导航。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HEADER_SRC = path.join(ROOT, 'partials/site-header.html');
const FOOTER_SRC = path.join(ROOT, 'partials/site-footer.html');

const PAGES = [
  'index.html',
  'services.html',
  'portfolio.html',
  'quant.html',
  'contact.html',
  '403.html',
];

const IDLE = 'hover:text-blue-300 transition-colors';
const ACTIVE = 'text-blue-400 font-semibold border-b-2 border-blue-400 pb-1';
const IDLE_M = 'text-blue-100 hover:text-white hover:bg-white/5';
const ACTIVE_M = 'text-blue-400 font-semibold bg-white/5';

const SLOGAN = `<div class="hidden md:block border-t border-white/10 bg-blue-900/40">
    <div class="container mx-auto px-4 py-2 text-xs md:text-sm text-blue-200 flex items-center justify-center md:justify-start gap-2">
      <svg class="qi text-blue-300 flex-shrink-0" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 11l18-5v12L3 13v-2zM11.5 13.5v5"/></svg>
      <span class="truncate">为创业者提供技术合伙级支持，为企业提供数字化转型策略与咨询</span>
    </div>
  </div>`;

function navClasses(activeKey, key) {
  return activeKey === key ? ACTIVE : IDLE;
}

function navMobile(activeKey, key) {
  return activeKey === key ? ACTIVE_M : IDLE_M;
}

function renderHeader(nav) {
  let html = fs.readFileSync(HEADER_SRC, 'utf8');
  const map = {
    '{{NAV_INDEX}}': navClasses(nav, 'index'),
    '{{NAV_SERVICES}}': navClasses(nav, 'services'),
    '{{NAV_PORTFOLIO}}': navClasses(nav, 'portfolio'),
    '{{NAV_QUANT}}': navClasses(nav, 'quant'),
    '{{NAV_CONTACT}}': navClasses(nav, 'contact'),
    '{{NAV_INDEX_MOBILE}}': navMobile(nav, 'index'),
    '{{NAV_SERVICES_MOBILE}}': navMobile(nav, 'services'),
    '{{NAV_PORTFOLIO_MOBILE}}': navMobile(nav, 'portfolio'),
    '{{NAV_QUANT_MOBILE}}': navMobile(nav, 'quant'),
    '{{NAV_CONTACT_MOBILE}}': navMobile(nav, 'contact'),
    '{{SLOGAN_BAR}}': nav === 'quant' || nav === 'none' ? '' : SLOGAN,
  };
  for (const [k, v] of Object.entries(map)) {
    html = html.split(k).join(v);
  }
  return html.trim();
}

function renderFooter() {
  return fs.readFileSync(FOOTER_SRC, 'utf8').trim();
}

function injectBlock(html, name, content) {
  const start = `<!-- inject:${name}:start -->`;
  const end = `<!-- inject:${name}:end -->`;
  const block = `${start}\n${content}\n${end}`;
  if (html.includes(start) && html.includes(end)) {
    const re = new RegExp(
      `${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      'm'
    );
    return html.replace(re, block);
  }
  // 兼容仅有单行标记
  const single = `<!-- inject:${name} -->`;
  if (html.includes(single)) {
    return html.replace(single, block);
  }
  console.warn(`[inject] 未找到标记 inject:${name}，跳过`);
  return html;
}

function detectNav(html, filename) {
  const m = html.match(/data-nav=["']([^"']+)["']/);
  if (m) return m[1];
  const base = filename.replace(/\.html$/, '');
  if (base === '403') return 'none';
  if (base === 'index') return 'index';
  return base;
}

function processFile(filename) {
  const filePath = path.join(ROOT, filename);
  if (!fs.existsSync(filePath)) {
    console.warn(`[inject] 缺少文件 ${filename}`);
    return;
  }
  let html = fs.readFileSync(filePath, 'utf8');
  const nav = detectNav(html, filename);
  html = injectBlock(html, 'header', renderHeader(nav));
  html = injectBlock(html, 'footer', renderFooter());
  fs.writeFileSync(filePath, html, 'utf8');
  console.log(`[inject] ${filename} (nav=${nav})`);
}

PAGES.forEach(processFile);
console.log('[inject] 完成');
