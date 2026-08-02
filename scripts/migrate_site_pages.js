/**
 * 一次性/可重复：把营销页与 403 对齐到全站 CSS + inject 标记。
 * quant.html 单独处理 head/header 标记。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const META = {
  'index.html': {
    nav: 'index',
    canonical: 'https://nhm.net.cn/index.html',
    ogImage: 'https://nhm.net.cn/assets/og-default.svg',
    keepContactScript: true,
  },
  'services.html': {
    nav: 'services',
    canonical: 'https://nhm.net.cn/services.html',
    ogImage: 'https://nhm.net.cn/assets/og-default.svg',
    keepContactScript: true,
  },
  'portfolio.html': {
    nav: 'portfolio',
    canonical: 'https://nhm.net.cn/portfolio.html',
    ogImage: 'https://nhm.net.cn/assets/og-default.svg',
    keepContactScript: true,
  },
  'contact.html': {
    nav: 'contact',
    canonical: 'https://nhm.net.cn/contact.html',
    ogImage: 'https://nhm.net.cn/assets/og-default.svg',
    keepContactScript: true,
    extraScripts: ['js/contact-form.js'],
  },
  '403.html': {
    nav: 'none',
    canonical: 'https://nhm.net.cn/403.html',
    ogImage: 'https://nhm.net.cn/assets/og-default.svg',
    keepContactScript: true,
    noindex: true,
  },
};

function stripCdn(headInner) {
  return headInner
    .replace(/<!--[\s\S]*?Tailwind[\s\S]*?-->\s*/gi, '')
    .replace(/<!--[\s\S]*?FontAwesome[\s\S]*?-->\s*/gi, '')
    .replace(/<!--[\s\S]*?Font Awesome[\s\S]*?-->\s*/gi, '')
    .replace(/<!--[\s\S]*?勿加错误 integrity[\s\S]*?-->\s*/gi, '')
    .replace(/<script[^>]*cdn\.tailwindcss\.com[^>]*><\/script>\s*/gi, '')
    .replace(/<link[^>]*font-awesome[^>]*>\s*/gi, '')
    .replace(/<link[^>]*css\/style\.css[^>]*>\s*/gi, '')
    .replace(/<link[^>]*css\/quant\.css[^>]*>\s*/gi, '');
}

function ensureHeadAssets(html, cfg) {
  // html 标签加 data-nav
  if (!/data-nav=/.test(html)) {
    html = html.replace(/<html([^>]*)>/i, `<html$1 data-nav="${cfg.nav}">`.replace('html data-nav', 'html lang="zh-CN" data-nav').replace(/lang="zh-CN"\s+lang="zh-CN"/, 'lang="zh-CN"'));
  } else {
    html = html.replace(/data-nav=["'][^"']*["']/, `data-nav="${cfg.nav}"`);
  }
  // 修正可能的重复 lang
  html = html.replace(/<html([^>]*)>/i, (m, attrs) => {
    let a = attrs;
    if (!/lang=/.test(a)) a = ` lang="zh-CN"${a}`;
    if (!/data-nav=/.test(a)) a = `${a} data-nav="${cfg.nav}"`;
    else a = a.replace(/data-nav=["'][^"']*["']/, `data-nav="${cfg.nav}"`);
    return `<html${a}>`;
  });

  // canonical / og
  html = html.replace(
    /<link\s+rel="canonical"[^>]*>/i,
    `<link rel="canonical" href="${cfg.canonical}" />`
  );
  html = html.replace(
    /<meta\s+property="og:url"[^>]*>/i,
    `<meta property="og:url" content="${cfg.canonical}" />`
  );
  html = html.replace(
    /<meta\s+property="og:image"[^>]*>/i,
    `<meta property="og:image" content="${cfg.ogImage}" />`
  );

  if (cfg.noindex) {
    html = html.replace(
      /<meta\s+name="robots"[^>]*>/i,
      '<meta name="robots" content="noindex,follow" />'
    );
  }

  // 替换 head 内 CDN
  html = html.replace(/<head>([\s\S]*?)<\/head>/i, (m, inner) => {
    let h = stripCdn(inner);
    if (!/css\/site\.css/.test(h)) {
      h = h.replace(
        /<\/head>/i,
        ''
      );
      // inner only
      if (!/rel="icon"/.test(h)) {
        h += `\n    <link rel="icon" href="./assets/logo.svg" type="image/svg+xml" />\n`;
      }
      h += `    <link rel="stylesheet" href="css/site.css" />\n  `;
      return `<head>${h}</head>`;
    }
    if (!/rel="icon"/.test(h)) {
      h = h.replace(
        /<link rel="stylesheet" href="css\/site\.css"\s*\/>/,
        `<link rel="icon" href="./assets/logo.svg" type="image/svg+xml" />\n    <link rel="stylesheet" href="css/site.css" />`
      );
    }
    return `<head>${h}</head>`;
  });

  // 去掉 placehold logo（页眉将由 inject 替换）
  html = html.replace(/https:\/\/placehold\.co\/[^"'\s]+/g, './assets/logo.svg');

  return html;
}

function replaceHeaderFooter(html) {
  // header ... </header>
  html = html.replace(
    /<header[\s\S]*?<\/header>/i,
    '<!-- inject:header:start -->\n<!-- inject:header:end -->'
  );
  // footer
  if (/<footer[\s\S]*?<\/footer>/i.test(html)) {
    html = html.replace(
      /<footer[\s\S]*?<\/footer>/i,
      '<!-- inject:footer:start -->\n<!-- inject:footer:end -->'
    );
  } else if (!/inject:footer/.test(html)) {
    html = html.replace(
      /<\/body>/i,
      '<!-- inject:footer:start -->\n<!-- inject:footer:end -->\n</body>'
    );
  }
  return html;
}

function ensureScripts(html, cfg) {
  // 移除旧的 script.js 无 defer 的重复，统一底部脚本
  // 图标已构建期内联为 SVG，不再依赖 site-icons.js
  const scripts = [
    'js/script.js',
    ...(cfg.extraScripts || []),
  ];

  // 去掉已有的 site-icons / script.js 引用以便重建
  html = html.replace(/<script[^>]*js\/site-icons\.js[^>]*><\/script>\s*/gi, '');
  html = html.replace(/<script[^>]*js\/script\.js[^>]*><\/script>\s*/gi, '');
  html = html.replace(/<script[^>]*js\/contact-form\.js[^>]*><\/script>\s*/gi, '');

  const tags = scripts
    .map((s) => `    <script src="${s}" defer></script>`)
    .join('\n');

  if (html.includes('</body>')) {
    html = html.replace(/<\/body>/i, `${tags}\n  </body>`);
  }
  return html;
}

function fixContactForm(html) {
  if (!html.includes('id="contact-form"') && !html.includes('contact-form')) return html;

  // 修双 class 的 form
  html = html.replace(
    /<form([\s\S]*?)action="#"\s+class="email-link-main"([\s\S]*?)>/i,
    '<form id="site-contact-form" class="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 email-link-main" action="#" method="POST" data-mailto="">'
  );

  // 若仍是旧 form 开标签
  html = html.replace(
    /<form\s+class="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6"\s+action="#"\s+class="email-link-main"\s+method="POST"\s+enctype="text\/plain"\s*>/i,
    '<form id="site-contact-form" class="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 email-link-main" action="#" method="POST" data-mailto="">'
  );

  // 提交按钮 id
  html = html.replace(
    /<button type="submit" class="inline-flex items-center gap-2 px-5 py-3 rounded-md bg-blue-600[^"]*">/,
    '<button type="submit" id="btn-contact-submit" class="inline-flex items-center gap-2 px-5 py-3 rounded-md bg-blue-600 hover:bg-blue-500 font-medium btn-primary" aria-busy="false">'
  );

  // 状态区
  if (!html.includes('id="form-status"')) {
    html = html.replace(
      /(<div class="md:col-span-2 flex flex-wrap gap-4">)/,
      '<p id="form-status" class="form-status md:col-span-2" role="status" aria-live="polite"></p>\n            $1'
    );
  }
  return html;
}

function processMarketing(filename, cfg) {
  const filePath = path.join(ROOT, filename);
  let html = fs.readFileSync(filePath, 'utf8');
  html = ensureHeadAssets(html, cfg);
  html = replaceHeaderFooter(html);
  html = ensureScripts(html, cfg);
  if (filename === 'contact.html') html = fixContactForm(html);
  fs.writeFileSync(filePath, html, 'utf8');
  console.log('[migrate]', filename);
}

function processQuant() {
  const filePath = path.join(ROOT, 'quant.html');
  let html = fs.readFileSync(filePath, 'utf8');
  html = html.replace(/<html([^>]*)>/i, (m, attrs) => {
    let a = attrs;
    if (!/lang=/.test(a)) a += ' lang="zh-CN"';
    if (!/data-nav=/.test(a)) a += ' data-nav="quant"';
    else a = a.replace(/data-nav=["'][^"']*["']/, 'data-nav="quant"');
    return `<html${a}>`;
  });
  html = html.replace(/css\/quant\.css/g, 'css/site.css');
  html = html.replace(
    /<header[\s\S]*?<\/header>/i,
    '<!-- inject:header:start -->\n<!-- inject:header:end -->'
  );
  if (!/inject:footer/.test(html)) {
    // quant 原先可能无 footer
    html = html.replace(
      /(<script src="js\/script\.js"[^>]*><\/script>)/i,
      '<!-- inject:footer:start -->\n<!-- inject:footer:end -->\n  $1'
    );
  }
  // 确保 script defer；量化模块稍后由 bundle 替换
  html = html.replace(
    /<script src="js\/script\.js"><\/script>/,
    '<script src="js/script.js" defer></script>'
  );
  fs.writeFileSync(filePath, html, 'utf8');
  console.log('[migrate] quant.html');
}

for (const [file, cfg] of Object.entries(META)) {
  processMarketing(file, cfg);
}
processQuant();
console.log('[migrate] 完成，请接着运行 inject_partials.js');
