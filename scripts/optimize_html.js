/**
 * 构建期 HTML 优化：
 * 1) 清理 portfolio 脏字符串
 * 2) 将遗留 <i class="fa-…"> 内联为 SVG
 * 3) 去掉 site-icons.js 引用
 * 4) 为静态 CSS/JS 打统一版本戳
 *
 * 用法：node scripts/optimize_html.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASSET_V = process.env.ASSET_V || '20260802-perf1';

const PAGES = [
  'index.html',
  'services.html',
  'portfolio.html',
  'quant.html',
  'contact.html',
  '403.html',
];

/** 与历史 site-icons.js 同源路径表 */
const PATHS = {
  bars: 'M4 7h16M4 12h16M4 17h16',
  brain: 'M9.5 2a3.5 3.5 0 0 0-3.4 4.2A3.5 3.5 0 0 0 4 9.5c0 1.3.7 2.4 1.8 3v1.7c0 .7.5 1.3 1.2 1.3h1.2V18a2 2 0 0 0 2 2h1',
  briefcase: 'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M4 7h16v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z',
  bullhorn: 'M3 11l18-5v12L3 13v-2zM11.5 13.5v5',
  'calendar-check': 'M8 2v3M16 2v3M4 8h16M6 4h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 14l2 2 4-4',
  'calendar-plus': 'M8 2v3M16 2v3M4 8h16M6 4h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM12 12v6M9 15h6',
  'chart-bar': 'M4 19V5M4 19h16M8 16V10M12 16V7M16 16v-4',
  'chart-line': 'M4 19V5M4 19h16M8 15l3-4 3 2 4-6',
  check: 'M5 12l5 5L20 7',
  'circle-check': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 12l2 2 4-4',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  code: 'M8 8l-4 4 4 4M16 8l4 4-4 4',
  comments: 'M7 8h10M7 12h6M5 19l3-3h9a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14z',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM14.5 9.5l-2 5-5 2 2-5 5-2z',
  database: 'M12 3c4.4 0 8 1.8 8 4s-3.6 4-8 4-8-1.8-8-4 3.6-4 8-4zM4 7v5c0 2.2 3.6 4 8 4s8-1.8 8-4V7M4 12v5c0 2.2 3.6 4 8 4s8-1.8 8-4v-5',
  envelope: 'M4 8l8 5 8-5M5 19h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2z',
  'envelope-open-text': 'M3 8l9 6 9-6M5 19h14a2 2 0 0 0 2-2V8l-9 6L3 8v9a2 2 0 0 0 2 2z',
  'file-signature': 'M7 3h7l3 3v5M7 3v14a2 2 0 0 0 2 2h4M14 17c1.5 0 3 1 3 2.5S15.5 22 14 22s-3-1-3-2.5 1.5-2.5 3-2.5z',
  flask: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3',
  'gauge-high': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 12l5-5',
  gears: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  github: 'M9 19c-4 1.5-4-2-6-2m12 4v-3.9a3.4 3.4 0 0 0-1-2.6c3.2-.4 6.5-1.6 6.5-7A5.4 5.4 0 0 0 18 4.8 5 5 0 0 0 17.9 1S16.7.7 14 2.6a13 13 0 0 0-8 0C3.3.7 2.1 1 2.1 1A5 5 0 0 0 2 4.8 5.4 5.4 0 0 0 .5 8.5c0 5.4 3.3 6.6 6.4 7A3.4 3.4 0 0 0 6 18.1V22',
  handshake: 'M12 15l-2 2a3 3 0 0 1-4 0l-1-1a2 2 0 0 1 0-3l4-4M12 15l2 2a3 3 0 0 0 4 0l1-1a2 2 0 0 0 0-3l-4-4M8 8l2-2a2 2 0 0 1 3 0l1 1M16 8l-2-2a2 2 0 0 0-3 0L10 7',
  'handshake-angle': 'M4 14l4-4 3 3 5-5 4 4M8 18h8',
  headset: 'M4 12a8 8 0 0 1 16 0M4 12v4a2 2 0 0 0 2 2h1v-6H6a2 2 0 0 0-2 2zm16 0v4a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2zM12 20h2a2 2 0 0 0 2-2',
  house: 'M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5z',
  industry: 'M4 20V9l5 3V9l5 3V4h6v16H4z',
  language: 'M5 8h8M9 8c0 6-4 10-4 10M13 8c0 6 4 10 4 10M3 12h8M14 16h7M16.5 12l2.5 8 2.5-8',
  'layer-group': 'M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  lightbulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11.2V16h6v-1.8A6 6 0 0 0 12 3z',
  linkedin: 'M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2zM4 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  'location-dot': 'M12 21s7-5.3 7-11a7 7 0 1 0-14 0c0 5.7 7 11 7 11zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  message: 'M5 19l3-3h9a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14z',
  'network-wired': 'M5 16h14M7 16v3M17 16v3M12 11v5M8 11h8M6 7h4v4H6V7zm8 0h4v4h-4V7z',
  'paper-plane': 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  'pencil-ruler': 'M3 21l3-1 11-11-2-2L4 18l-1 3zM14 6l2 2M16 4l2 2',
  'people-group': 'M7 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM17 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20v-1a4 4 0 0 1 4-4h0a4 4 0 0 1 4 4v1M13 20v-1a4 4 0 0 1 4-4h0a4 4 0 0 1 4 4v1',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.6 2.6.7A2 2 0 0 1 22 16.9z',
  repeat: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
  robot: 'M9 9h6v6H9V9zM12 3v3M8 18h8M6 12H4M20 12h-2M9 21h6',
  rocket: 'M5 15c-1 3-2 5-2 5s2-1 5-2l9-9a4 4 0 0 0-3-3L5 15zM15 6l3 3',
  'shield-halved': 'M12 3l8 3v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3zM12 3v16',
  sitemap: 'M12 4v6M6 20v-4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4M12 10h0M9 4h6M4 20h4M16 20h4',
  'solar-panel': 'M4 14h16v6H4v-6zM8 14V9M16 14V9M12 14V6M12 3v1',
  'user-lock': 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 10.2-7.7M17 21v-3a2 2 0 1 1 4 0v3M16 21h6v-1a3 3 0 0 0-3-3h0a3 3 0 0 0-3 3v1z',
  'user-tie': 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0M10 21l2-4 2 4',
  'users-gear': 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16.5 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 20v-1a4 4 0 0 1 4-4h2a4 4 0 0 1 3.5 1.9M19 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0-2v1m0 5v1m-2.1-5.1l.7.7m2.8 2.8l.7.7m-4.9 0l.7-.7m2.8-2.8l.7-.7',
  weixin: 'M9 10a5.5 5.5 0 1 1 5.2 7.2L12 20l-1.8-2.1A5.5 5.5 0 0 1 9 10zM16.5 8A4.5 4.5 0 1 1 20 14l1.2 1.5L19 15',
  xmark: 'M6 6l12 12M18 6L6 18',
};

const ASSET_PATTERNS = [
  [/href=(["'])css\/site\.css(?:\?[^"']*)?\1/g, `href=$1css/site.css?v=${ASSET_V}$1`],
  [/src=(["'])js\/contact-info\.js(?:\?[^"']*)?\1/g, `src=$1js/contact-info.js?v=${ASSET_V}$1`],
  [/src=(["'])js\/script\.js(?:\?[^"']*)?\1/g, `src=$1js/script.js?v=${ASSET_V}$1`],
  [/src=(["'])js\/contact-form\.js(?:\?[^"']*)?\1/g, `src=$1js/contact-form.js?v=${ASSET_V}$1`],
  [/src=(["'])js\/quant\.bundle\.js(?:\?[^"']*)?\1/g, `src=$1js/quant.bundle.js?v=${ASSET_V}$1`],
  [/href=(["'])js\/quant\.bundle\.js(?:\?[^"']*)?\1/g, `href=$1js/quant.bundle.js?v=${ASSET_V}$1`],
];

function iconNameFromClass(cls) {
  const parts = String(cls || '').split(/\s+/);
  for (const p of parts) {
    if (p.startsWith('fa-') && p !== 'fa-solid' && p !== 'fa-brands' && p !== 'fa-regular' && p !== 'fa') {
      return p.slice(3);
    }
  }
  return '';
}

function svgFor(name, className) {
  const d = PATHS[name] || PATHS.check;
  const extra = className
    .replace(/\bfa-solid\b/g, '')
    .replace(/\bfa-brands\b/g, '')
    .replace(/\bfa-regular\b/g, '')
    .replace(new RegExp(`\\bfa-${name}\\b`), '')
    .replace(/\bfa\b/g, '')
    .trim();
  const cls = extra ? `qi ${extra}` : 'qi';
  return `<svg class="${cls}" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><path d="${d}"/></svg>`;
}

function inlineFaIcons(html) {
  let count = 0;
  const out = html.replace(/<i\b([^>]*?)class=(["'])([^"']*)\2([^>]*)><\/i>/gi, (full, pre, q, cls, post) => {
    if (!/fa-/.test(cls)) return full;
    const name = iconNameFromClass(cls);
    if (!name) return full;
    count += 1;
    return svgFor(name, cls);
  });
  return { html: out, count };
}

function cleanPortfolioGarbage(html) {
  // 清理案例图后残留的模板碎片
  return html.replace(
    /(<img\b[^>]*src=["']images\/portfolio-\d+\.webp["'][^>]*\/?>)\s*[^<\n]*<\/span>'\}\}\)?"\s*\//g,
    '$1'
  );
}

function stripSiteIconsScript(html) {
  return html.replace(/<script[^>]*js\/site-icons\.js[^>]*><\/script>\s*/gi, '');
}

function stampAssets(html) {
  let out = html;
  for (const [re, repl] of ASSET_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

function main() {
  let totalIcons = 0;
  for (const page of PAGES) {
    const file = path.join(ROOT, page);
    if (!fs.existsSync(file)) continue;
    let html = fs.readFileSync(file, 'utf8');
    const before = html;

    html = cleanPortfolioGarbage(html);
    const { html: withIcons, count } = inlineFaIcons(html);
    html = withIcons;
    totalIcons += count;
    html = stripSiteIconsScript(html);
    html = stampAssets(html);

    if (html !== before) {
      fs.writeFileSync(file, html, 'utf8');
      console.log(`[optimize] ${page}: icons=${count}`);
    } else {
      console.log(`[optimize] ${page}: unchanged`);
    }
  }
  console.log(`[optimize] done. asset_v=${ASSET_V}, icons_inlined=${totalIcons}`);
}

main();
