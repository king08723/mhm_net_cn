/**
 * Markdown 消毒、报告拆分、Tab 渲染与工具条
 */
import { ensureMarkdownLibs } from './quant-api.js';
import { STATUS_LABELS } from './quant-config.js';

export function escapeText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatTime(ts) {
  const n = Number(ts);
  if (!n) return '';
  try {
    return new Date(n).toLocaleString('zh-CN', { hour12: false });
  } catch (_) {
    return String(n);
  }
}

export function formatConfidence(value) {
  if (value == null || value === '') return '';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return n <= 1 ? `${Math.round(n * 100)}%` : `${Math.round(n)}%`;
}

export function formatJobStatus(status) {
  return STATUS_LABELS[status] || (status ? String(status) : '');
}

function sanitizeHtml(html) {
  if (typeof window.DOMPurify !== 'undefined' && window.DOMPurify.sanitize) {
    return window.DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['id'],
    });
  }
  return String(html)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/javascript:/gi, '');
}

/** 上游「**标签**: 内容」连续单行强制成段 */
function normalizeReportMarkdown(md) {
  return String(md || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n(\*\*[^*\n]{1,48}\*\*\s*[:：])/g, '\n\n$1');
}

export function parseMd(text) {
  if (!text) return '';
  const normalized = normalizeReportMarkdown(text);
  let html;
  if (typeof window.marked !== 'undefined' && typeof window.marked.parse === 'function') {
    html = window.marked.parse(normalized);
  } else {
    html = normalized.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return sanitizeHtml(html);
}

/**
 * 把整份个股报告按「## … (股票代码)」拆成多页
 */
export function splitStockReportSections(reportMd, fallbackSymbol) {
  const text = String(reportMd || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const headingRe = /^##\s+(.+?)\s*\(([A-Z0-9][A-Z0-9.\-]{0,19})\)\s*$/gm;
  const matches = [];
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    const titleLine = m[1].trim();
    if (/分析结果摘要/.test(titleLine)) continue;
    const name = titleLine
      .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\s]+/u, '')
      .replace(/^[🟠🟢🟡🔴⚪⚫]+/u, '')
      .trim() || m[2];
    matches.push({
      index: m.index,
      code: String(m[2] || '').toUpperCase(),
      name,
    });
  }

  if (!matches.length) {
    const code = String(fallbackSymbol || '').split(',')[0].trim().toUpperCase() || 'REPORT';
    return [{
      id: `stock-${code}`,
      code,
      name: code,
      markdown: text,
    }];
  }

  return matches.map((item, idx) => {
    const bodyStart = item.index;
    const bodyEnd = idx + 1 < matches.length ? matches[idx + 1].index : text.length;
    let markdown = text.slice(bodyStart, bodyEnd).trim();
    if (idx === 0 && item.index > 0) {
      const preamble = text.slice(0, item.index).trim();
      if (preamble) markdown = `${preamble}\n\n${markdown}`;
    }
    return {
      id: `stock-${item.code}-${idx}`,
      code: item.code,
      name: item.name,
      markdown,
    };
  });
}

/** 待渲染 Markdown（避免把长文塞进 data-* 属性） */
const pendingPaneMarkdown = new WeakMap();

/** 惰性面板：首次显示时再 parse Markdown，减轻长报告主线程尖峰 */
function ensurePaneRendered(pane) {
  if (!pane || pane.dataset.rendered === '1') return;
  const body = pane.querySelector('.markdown-body');
  if (!body) return;
  const md = pendingPaneMarkdown.get(pane) || '';
  body.innerHTML = parseMd(md);
  pendingPaneMarkdown.delete(pane);
  pane.dataset.rendered = '1';
}

export function switchReportTab(reportTabs, reportPanels, tabId) {
  if (!reportTabs || !reportPanels) return;
  const buttons = Array.from(reportTabs.querySelectorAll('button[data-tab]'));
  if (!buttons.length) return;
  const ids = buttons.map((btn) => btn.getAttribute('data-tab'));
  const next = ids.includes(tabId) ? tabId : ids[0];

  buttons.forEach((btn) => {
    const active = btn.getAttribute('data-tab') === next;
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
  });

  reportPanels.querySelectorAll('.report-pane').forEach((pane) => {
    const active = pane.getAttribute('data-pane') === next;
    if (active) {
      ensurePaneRendered(pane);
      pane.removeAttribute('hidden');
    } else {
      pane.setAttribute('hidden', '');
    }
  });
}

/** 构建 Tab + Markdown 面板（调用前请 ensureMarkdownLibs） */
export function buildReportTabs(reportTabs, reportPanels, stockSections, marketMd) {
  if (!reportTabs || !reportPanels) return;

  reportTabs.innerHTML = '';
  reportPanels.innerHTML = '';

  const tabs = stockSections.map((s) => ({
    id: s.id,
    label: s.name || s.code,
    code: s.code,
    kind: 'stock',
    markdown: s.markdown,
  }));
  if (marketMd) {
    tabs.push({
      id: 'market',
      label: '市场复盘',
      code: '',
      kind: 'market',
      markdown: marketMd,
    });
  }

  if (!tabs.length) {
    reportTabs.classList.add('hidden');
    return;
  }

  tabs.forEach((tab, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('data-tab', tab.id);
    btn.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
    btn.tabIndex = idx === 0 ? 0 : -1;

    const label = document.createElement('span');
    label.textContent = tab.label;
    btn.appendChild(label);
    if (tab.kind !== 'market' && tab.code && tab.code !== tab.label) {
      const codeEl = document.createElement('span');
      codeEl.className = 'tab-code';
      codeEl.textContent = tab.code;
      btn.appendChild(codeEl);
    }
    reportTabs.appendChild(btn);

    const pane = document.createElement('section');
    pane.className = 'report-pane';
    pane.setAttribute('data-pane', tab.id);
    pane.setAttribute('role', 'tabpanel');
    if (idx !== 0) pane.setAttribute('hidden', '');
    const body = document.createElement('div');
    body.className = 'markdown-body';
    // 仅首个 Tab 立即渲染；其余保留原文，切换时再解析
    if (idx === 0) {
      body.innerHTML = parseMd(tab.markdown);
      pane.dataset.rendered = '1';
    } else {
      pendingPaneMarkdown.set(pane, tab.markdown);
      pane.dataset.rendered = '0';
    }
    pane.appendChild(body);
    reportPanels.appendChild(pane);
  });

  reportTabs.classList.remove('hidden');
  switchReportTab(reportTabs, reportPanels, tabs[0].id);
}

/** 复制当前可见报告正文（纯文本） */
export async function copyActiveReportText(reportPanels) {
  if (!reportPanels) return false;
  const pane = reportPanels.querySelector('.report-pane:not([hidden]) .markdown-body')
    || reportPanels.querySelector('.markdown-body');
  if (!pane) return false;
  const text = pane.innerText || pane.textContent || '';
  if (!text.trim()) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }
}

export { ensureMarkdownLibs };
