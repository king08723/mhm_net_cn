/**
 * 进度步骤 UI、文案节点构建（避免任意 HTML 注入）
 */
import { STEPS, TOTAL_DURATION, BADGES } from './quant-config.js';
import { iconHtml, setIcon } from './quant-icons.js';

/**
 * 安全写入状态文案：[{ text, tone?, br? }]
 * tone: muted | info | warn | error | success
 */
export function setStatusMessage(el, parts) {
  if (!el) return;
  el.replaceChildren();
  const list = Array.isArray(parts) ? parts : [{ text: String(parts || '') }];
  list.forEach((part) => {
    if (!part) return;
    if (part.br) {
      el.appendChild(document.createElement('br'));
      return;
    }
    const span = document.createElement('span');
    const tone = part.tone || 'info';
    const colors = {
      info: '#93c5fd',
      muted: '#7dd3fc',
      warn: '#fbbf24',
      error: '#f87171',
      success: '#4ade80',
      orange: '#fb923c',
    };
    span.style.color = colors[tone] || colors.info;
    if (part.weight) span.style.fontWeight = part.weight;
    if (part.opacity) span.style.opacity = String(part.opacity);
    if (part.size) span.style.fontSize = part.size;
    span.textContent = part.text || '';
    el.appendChild(span);
  });
}

export function getStepStartPct(idx) {
  let elapsed = 0;
  for (let i = 0; i < idx; i++) elapsed += STEPS[i].duration;
  return (elapsed / TOTAL_DURATION) * 94;
}

export function getStepEndPct(idx) {
  return getStepStartPct(idx + 1);
}

export function buildSteps(stepsContainer) {
  if (!stepsContainer) return;
  stepsContainer.innerHTML = '';
  STEPS.forEach((step, i) => {
    const isLast = i === STEPS.length - 1;
    const row = document.createElement('div');
    row.className = 'flex gap-3 items-start';
    row.id = `step-row-${step.id}`;

    const col = document.createElement('div');
    col.className = 'flex flex-col items-center';
    col.style.minWidth = '28px';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'relative w-7 h-7 rounded-full flex items-center justify-center text-xs border';
    iconWrap.id = `step-icon-${step.id}`;
    iconWrap.style.cssText = 'border-color:rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#4b6a8a;flex-shrink:0';
    iconWrap.innerHTML = iconHtml(step.icon, { size: 12 });
    col.appendChild(iconWrap);

    if (!isLast) {
      const connOuter = document.createElement('div');
      connOuter.style.cssText = 'width:1px;flex:1;margin:4px 0;background:rgba(255,255,255,0.08);min-height:16px;position:relative;overflow:hidden';
      const conn = document.createElement('div');
      conn.id = `step-conn-${step.id}`;
      conn.style.cssText = 'width:100%;position:absolute;top:0;height:0%;background:linear-gradient(to bottom,#3b82f6,#38bdf8);transition:height 0.6s ease';
      connOuter.appendChild(conn);
      col.appendChild(connOuter);
    }

    const body = document.createElement('div');
    body.style.cssText = `${isLast ? '' : 'padding-bottom:12px;'}flex:1;min-width:0`;

    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;gap:6px';

    const label = document.createElement('span');
    label.id = `step-label-${step.id}`;
    label.className = 'text-xs font-medium';
    label.style.color = '#4b6a8a';
    label.textContent = step.label;

    const time = document.createElement('span');
    time.id = `step-time-${step.id}`;
    time.className = 'text-xs font-mono';
    time.style.cssText = 'color:#3b82f6;display:none';

    titleRow.appendChild(label);
    titleRow.appendChild(time);

    const desc = document.createElement('div');
    desc.id = `step-desc-${step.id}`;
    desc.className = 'text-xs mt-1';
    desc.style.cssText = 'color:#93c5fd;opacity:0.7;display:none;line-height:1.5';
    desc.textContent = step.desc;

    body.appendChild(titleRow);
    body.appendChild(desc);
    row.appendChild(col);
    row.appendChild(body);
    stepsContainer.appendChild(row);
  });
}

export function activateStep(idx, panelMessage) {
  STEPS.forEach((s, i) => {
    const iconEl = document.getElementById(`step-icon-${s.id}`);
    const labelEl = document.getElementById(`step-label-${s.id}`);
    const descEl = document.getElementById(`step-desc-${s.id}`);
    const connEl = document.getElementById(`step-conn-${s.id}`);
    if (!iconEl) return;

    if (i < idx) {
      iconEl.style.borderColor = '#22c55e';
      iconEl.style.background = 'rgba(34,197,94,0.15)';
      iconEl.style.color = '#22c55e';
      iconEl.innerHTML = iconHtml('check', { size: 12 });
      if (connEl) connEl.style.height = '100%';
      if (labelEl) labelEl.style.color = '#86efac';
      if (descEl) descEl.style.display = 'none';
    } else if (i === idx) {
      iconEl.style.borderColor = '#3b82f6';
      iconEl.style.background = 'rgba(59,130,246,0.2)';
      iconEl.style.color = '#93c5fd';
      iconEl.innerHTML = `<span class="step-pulse-ring"></span>${iconHtml(s.icon, { size: 12 })}`;
      if (labelEl) labelEl.style.color = '#dbeafe';
      if (descEl) descEl.style.display = 'block';
      if (panelMessage) panelMessage.textContent = s.desc;
    } else {
      iconEl.style.borderColor = 'rgba(255,255,255,0.12)';
      iconEl.style.background = 'rgba(255,255,255,0.04)';
      iconEl.style.color = '#4b6a8a';
      iconEl.innerHTML = iconHtml(s.icon, { size: 12 });
      if (labelEl) labelEl.style.color = '#4b6a8a';
      if (descEl) descEl.style.display = 'none';
    }
  });
}

export function completeStep(idx, sec) {
  const step = STEPS[idx];
  if (!step) return;
  const timeEl = document.getElementById(`step-time-${step.id}`);
  if (timeEl) {
    timeEl.textContent = `${sec.toFixed(1)}s`;
    timeEl.style.display = 'inline';
  }
}

export function markAllStepsDone() {
  STEPS.forEach((s) => {
    const iconEl = document.getElementById(`step-icon-${s.id}`);
    const connEl = document.getElementById(`step-conn-${s.id}`);
    const labelEl = document.getElementById(`step-label-${s.id}`);
    const descEl = document.getElementById(`step-desc-${s.id}`);
    if (iconEl) {
      iconEl.style.borderColor = '#22c55e';
      iconEl.style.background = 'rgba(34,197,94,0.15)';
      iconEl.style.color = '#22c55e';
      iconEl.innerHTML = iconHtml('check', { size: 12 });
    }
    if (connEl) connEl.style.height = '100%';
    if (labelEl) labelEl.style.color = '#86efac';
    if (descEl) descEl.style.display = 'none';
  });
}

export function setPanelIcon(panelIconEl, panelIconWrap, type) {
  if (!panelIconEl || !panelIconWrap) return;
  const map = {
    spin: { border: 'rgba(59,130,246,0.4)', bg: 'rgba(59,130,246,0.1)', color: '#60a5fa', icon: 'spinner', spin: true },
    check: { border: 'rgba(34,197,94,0.4)', bg: 'rgba(34,197,94,0.1)', color: '#4ade80', icon: 'check', spin: false },
    error: { border: 'rgba(239,68,68,0.4)', bg: 'rgba(239,68,68,0.1)', color: '#f87171', icon: 'warning', spin: false },
  };
  const cfg = map[type] || map.spin;
  panelIconWrap.style.borderColor = cfg.border;
  panelIconWrap.style.background = cfg.bg;
  panelIconWrap.style.color = cfg.color;
  setIcon(panelIconEl, cfg.icon, { spin: cfg.spin, size: 18 });
}

export function setBadge(panelBadge, state) {
  if (!panelBadge) return;
  const b = BADGES[state] || BADGES.running;
  panelBadge.textContent = b.text;
  panelBadge.className = `px-2.5 py-1 rounded-full text-xs font-medium border ${b.cls}`;
}

export function markFirstStepError() {
  const iconEl = document.getElementById(`step-icon-${STEPS[0].id}`);
  if (!iconEl) return;
  iconEl.style.borderColor = 'rgba(239,68,68,0.5)';
  iconEl.style.background = 'rgba(239,68,68,0.15)';
  iconEl.style.color = '#f87171';
  iconEl.innerHTML = iconHtml('xmark', { size: 12 });
}

/** 分析中隐藏营销；完成后折叠进度详情 */
export function setQuantFocus(active) {
  document.body.classList.toggle('is-quant-focused', !!active);
}

export function setProgressCollapsed(progressPanel, btnToggle, collapsed) {
  if (!progressPanel) return;
  progressPanel.classList.toggle('is-collapsed', !!collapsed);
  if (btnToggle) {
    btnToggle.classList.remove('hidden');
    btnToggle.textContent = collapsed ? '展开详情' : '收起详情';
  }
}
