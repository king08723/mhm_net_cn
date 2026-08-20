/**
 * AI 量化投研分析控制脚本 (quant.js) v8.0
 *
 * 模块拆分：config / icons / api / progress / report；本文件负责 DOM 编排与状态机。
 * 单链路：trigger → jobId → 轮询 get-stock-result → 消毒渲染。
 */

import {
  UNICLOUD_TRIGGER_URL,
  UNICLOUD_RESULT_URL,
  COOLDOWN_MS,
  POLL_INTERVAL_INITIAL,
  POLL_INTERVAL_MAX,
  POLL_FAST_WINDOW_MS,
  POLL_DEADLINE_MS,
  RECENT_JOBS_KEY,
  RECENT_JOBS_MAX,
  DEFAULT_ANALYSIS_OPTIONS,
  PHASE_STEP_INDEX,
  STEPS,
  VIRTUAL_HOLD_STEP_INDEX,
  VIRTUAL_PROGRESS_CAP,
  VIRTUAL_STEP_SECONDS,
  ANALYZE_SIM_MESSAGES,
  ANALYZE_SIM_INTERVAL_MS,
  STATUS_LABELS,
  PHASE_LABELS,
  PHASE_ETA,
} from './quant-config.js';

import {
  QUANT_PRODUCTS,
  DEFAULT_PRODUCT_ID,
  resolveEntitlements,
  assertProductAllowed,
  getProduct,
  getProgressProfile,
} from './quant-catalog.js';

import { setIcon } from './quant-icons.js';
import {
  unwrapGatewayJson,
  ensureMarkdownLibs,
  fetchJobFromGithubRaw,
  sleep,
} from './quant-api.js';
import {
  setStatusMessage,
  getStepStartPct,
  getStepEndPct,
  buildSteps,
  activateStep,
  completeStep,
  markAllStepsDone,
  setPanelIcon as setPanelIconUi,
  setBadge as setBadgeUi,
  markFirstStepError,
  setQuantFocus,
  setProgressCollapsed,
  setActiveSteps,
  getActiveSteps,
} from './quant-progress.js';
import {
  formatTime,
  formatConfidence,
  formatJobStatus,
  splitStockReportSections,
  switchReportTab,
  buildReportTabs,
  copyActiveReportText,
} from './quant-report.js';

document.addEventListener('DOMContentLoaded', () => {
  // =====================================================================
  // DOM 引用
  // =====================================================================
  const productHub = document.getElementById('product-hub');
  const productHubCards = document.getElementById('product-hub-cards');
  const toolHero = document.getElementById('tool-hero');
  const btnBackHub = document.getElementById('btn-back-hub');
  const productBadge = document.getElementById('product-badge');
  const workspaceTitle = document.getElementById('workspace-title');
  const workspaceDesc = document.getElementById('workspace-desc');
  const workspaceLock = document.getElementById('workspace-lock');
  const workspaceLockMsg = document.getElementById('workspace-lock-msg');
  const symbolHint = document.getElementById('symbol-hint');
  const modeSelectWrap = document.getElementById('mode-select-wrap');
  const optMarketContextWrap = document.getElementById('opt-market-context-wrap');
  const optRealtimeQuoteWrap = document.getElementById('opt-realtime-quote-wrap');
  const optRealtimeTechWrap = document.getElementById('opt-realtime-tech-wrap');
  const optChipDistWrap = document.getElementById('opt-chip-dist-wrap');
  const advancedHint = document.getElementById('advanced-hint');

  const symbolInput = document.getElementById('symbol-input');
  const modeSelect = document.getElementById('mode-select');
  const reportTypeSelect = document.getElementById('report-type-select');
  const reportLanguageSelect = document.getElementById('report-language-select');
  const forceRunCheckbox = document.getElementById('force-run-checkbox');
  const optMarketContext = document.getElementById('opt-market-context');
  const optRealtimeQuote = document.getElementById('opt-realtime-quote');
  const optRealtimeTech = document.getElementById('opt-realtime-tech');
  const optChipDist = document.getElementById('opt-chip-dist');
  const btnToggleAdvanced = document.getElementById('btn-toggle-advanced');
  const advancedOptions = document.getElementById('advanced-options');
  const btnAnalyze = document.getElementById('btn-analyze');
  const btnIcon = document.getElementById('btn-icon');
  const btnLabel = document.getElementById('btn-label');
  const progressPanel = document.getElementById('progress-panel');
  const panelSymbol = document.getElementById('panel-symbol');
  const panelIconEl = document.getElementById('panel-icon');
  const panelIconWrap = document.getElementById('panel-icon-wrap');
  const panelBadge = document.getElementById('panel-badge');
  const panelElapsed = document.getElementById('panel-elapsed');
  const panelMessage = document.getElementById('panel-message');
  const progressFill = document.getElementById('progress-bar-fill');
  const progressPct = document.getElementById('progress-pct');
  const progressLabel = document.getElementById('progress-label');
  const panelPhaseSource = document.getElementById('panel-phase-source');
  const panelDebugInfo = document.getElementById('panel-debug-info');
  const stepsContainer = document.getElementById('steps-container');
  const emptyState = document.getElementById('empty-state');
  const inputHint = document.getElementById('input-hint');
  const reportContainer = document.getElementById('report-container');
  const reportTitle = document.getElementById('report-title');
  const reportTabs = document.getElementById('report-tabs');
  const reportPanels = document.getElementById('report-panels');
  const reportMeta = document.getElementById('report-meta');
  const metaGenerated = document.getElementById('meta-generated');
  const metaRunId = document.getElementById('meta-runid');
  const metaDegraded = document.getElementById('meta-degraded');
  const historyPanel = document.getElementById('history-panel');
  const historyList = document.getElementById('history-list');
  const historySymbolEl = document.getElementById('history-symbol');
  const historyCountEl = document.getElementById('history-count');
  const historyEmptyEl = document.getElementById('history-empty');
  const btnToggleHistory = document.getElementById('btn-toggle-history');
  const btnToggleHistoryBar = document.getElementById('btn-toggle-history-bar');
  const btnToggleProgress = document.getElementById('btn-toggle-progress');
  const btnCopyReport = document.getElementById('btn-copy-report');
  const btnPrintReport = document.getElementById('btn-print-report');

  // =====================================================================
  // 内部状态
  // =====================================================================
  let lastTriggerTime = 0;
  let pollTimer = null;
  let isTriggering = false;
  let elapsedTimer = null;
  let progressRafId = null;
  let currentProgress = 0;
  let isResultReady = false;
  let currentJobId = '';
  let currentProductId = '';
  let lastPhase = '';
  let usePhaseProgress = false;
  let lastPhaseSource = 'simulated';
  let lastActionsUrl = '';
  let lastManifestUrl = '';
  let lastRunId = '';
  let lastUpdatedAt = 0;
  let analyzeSimTimer = null;
  let analyzeSimQueue = [];
  let analyzeSimLast = '';
  let startTime = 0;
  /** 当前产品进度配置（由 getProgressProfile 填充） */
  let progressProfile = getProgressProfile(DEFAULT_PRODUCT_ID);
  const entitlements = resolveEntitlements(null);

  function activePhaseEta() {
    return progressProfile.phaseEta || PHASE_ETA;
  }

  function activeProgressCap() {
    return progressProfile.virtualProgressCap != null
      ? progressProfile.virtualProgressCap
      : VIRTUAL_PROGRESS_CAP;
  }

  function activeVirtualStepSeconds() {
    return progressProfile.virtualStepSeconds || VIRTUAL_STEP_SECONDS;
  }

  function activeAnalyzeMessages() {
    return progressProfile.analyzeMessages || ANALYZE_SIM_MESSAGES;
  }

  function activePollDeadlineMs() {
    return progressProfile.pollDeadlineMs || POLL_DEADLINE_MS;
  }

  function activeStepsList() {
    return getActiveSteps() || progressProfile.steps || STEPS;
  }

  function isDebugMode() {
    try {
      return new URLSearchParams(window.location.search).get('debug') === '1';
    } catch (_) {
      return false;
    }
  }

  function isRealPhaseSource(phaseSource, source) {
    if (phaseSource === 'github-manifest') return true;
    if (!phaseSource && source === 'github-job') return true;
    return false;
  }

  function setPhaseSourceHint(phaseSource) {
    lastPhaseSource = phaseSource || 'simulated';
    if (panelPhaseSource) {
      panelPhaseSource.textContent = '';
      panelPhaseSource.classList.add('hidden');
    }
  }

  function scrubDebugToken(value) {
    return String(value || '')
      .replace(/github-manifest/gi, 'live')
      .replace(/github-job/gi, 'cloud')
      .replace(/db-cache/gi, 'cache')
      .replace(/simulated/gi, 'waiting')
      .replace(/https?:\/\/raw\.githubusercontent\.com\/\S+/gi, '(report)')
      .replace(/https?:\/\/github\.com\/\S+/gi, '(run)')
      .replace(/虚拟|模拟/g, '');
  }

  function updateDebugInfo(extra) {
    if (!panelDebugInfo) return;
    if (!isDebugMode()) {
      panelDebugInfo.classList.add('hidden');
      panelDebugInfo.textContent = '';
      return;
    }
    const parts = [
      currentJobId ? `jobId=${currentJobId}` : '',
      lastRunId ? `runId=${lastRunId}` : '',
      lastPhaseSource ? `phase=${scrubDebugToken(lastPhaseSource)}` : '',
      extra && extra.source ? `source=${scrubDebugToken(extra.source)}` : '',
      lastUpdatedAt ? `updatedAt=${formatTime(lastUpdatedAt) || lastUpdatedAt}` : '',
      lastManifestUrl ? `manifest=${scrubDebugToken(lastManifestUrl)}` : '',
      lastActionsUrl ? `actions=${scrubDebugToken(lastActionsUrl)}` : '',
    ].filter(Boolean);
    panelDebugInfo.textContent = parts.join(' · ');
    panelDebugInfo.classList.remove('hidden');
  }

  function setPanelIcon(type) {
    setPanelIconUi(panelIconEl, panelIconWrap, type);
  }

  function setBadge(state) {
    setBadgeUi(panelBadge, state);
  }

  // ---------- 事件绑定 ----------
  if (btnAnalyze) btnAnalyze.addEventListener('click', handleAnalyze);
  if (btnBackHub) btnBackHub.addEventListener('click', () => showHub({ keepJob: true }));
  if (symbolInput) {
    symbolInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAnalyze(); });
  }
  if (reportTabs) {
    reportTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      switchReportTab(reportTabs, reportPanels, btn.getAttribute('data-tab'));
    });
  }
  if (btnToggleAdvanced && advancedOptions) {
    btnToggleAdvanced.addEventListener('click', () => {
      const open = !advancedOptions.classList.contains('hidden');
      advancedOptions.classList.toggle('hidden', open);
      btnToggleAdvanced.textContent = open ? '高级选项' : '收起高级选项';
    });
  }
  // 仅标题栏切换展开，避免点流水行误折叠
  if (btnToggleHistoryBar) {
    btnToggleHistoryBar.addEventListener('click', () => {
      const open = historyPanel && historyPanel.getAttribute('aria-expanded') !== 'false';
      setHistoryExpanded(!open);
    });
  }
  if (btnToggleProgress && progressPanel) {
    btnToggleProgress.addEventListener('click', () => {
      const collapsed = !progressPanel.classList.contains('is-collapsed');
      setProgressCollapsed(progressPanel, btnToggleProgress, collapsed);
    });
  }
  if (btnCopyReport) {
    btnCopyReport.addEventListener('click', async () => {
      const ok = await copyActiveReportText(reportPanels);
      const prev = btnCopyReport.textContent;
      btnCopyReport.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { btnCopyReport.textContent = prev; }, 1600);
    });
  }
  if (btnPrintReport) {
    btnPrintReport.addEventListener('click', () => window.print());
  }

  function isValidSymbol(sym) {
    if (!sym) return false;
    return /^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(sym);
  }

  function normalizeSymbols(raw) {
    return String(raw || '')
      .trim()
      .toUpperCase()
      .replace(/[，、\s]+/g, ',')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function readSelectValue(el, allowed, fallback) {
    const value = el && typeof el.value === 'string' ? el.value : fallback;
    return allowed.includes(value) ? value : fallback;
  }

  function readCheckbox(el, fallback) {
    if (!el) return fallback;
    return !!el.checked;
  }

  function collectAnalysisOptions() {
    const product = getProduct(currentProductId) || getProduct(DEFAULT_PRODUCT_ID);
    const caps = (product && product.capabilities) || {};
    const options = {
      ...DEFAULT_ANALYSIS_OPTIONS,
      product: product ? product.id : DEFAULT_PRODUCT_ID,
      engine: product ? product.engine : 'dsa',
      mode: readSelectValue(modeSelect, ['full', 'market-only', 'stocks-only'], DEFAULT_ANALYSIS_OPTIONS.mode),
      reportType: readSelectValue(reportTypeSelect, ['brief', 'simple', 'full'], DEFAULT_ANALYSIS_OPTIONS.reportType),
      reportLanguage: readSelectValue(reportLanguageSelect, ['zh', 'en', 'ko'], DEFAULT_ANALYSIS_OPTIONS.reportLanguage),
      notificationChannels: [],
      notificationEmail: '',
      includeMarketContext: readCheckbox(optMarketContext, DEFAULT_ANALYSIS_OPTIONS.includeMarketContext),
      enableRealtimeQuote: readCheckbox(optRealtimeQuote, DEFAULT_ANALYSIS_OPTIONS.enableRealtimeQuote),
      enableRealtimeTechnicalIndicators: readCheckbox(optRealtimeTech, DEFAULT_ANALYSIS_OPTIONS.enableRealtimeTechnicalIndicators),
      enableChipDistribution: readCheckbox(optChipDist, DEFAULT_ANALYSIS_OPTIONS.enableChipDistribution),
      multiSymbols: !!caps.multiSymbols,
    };

    // TradingAgents：强制单标的、仅个股、关闭 DSA 专属增强
    if (product && product.id === 'tradingagents') {
      options.multiSymbols = false;
      options.mode = 'stocks-only';
      options.includeMarketContext = false;
      options.enableRealtimeQuote = false;
      options.enableRealtimeTechnicalIndicators = false;
      options.enableChipDistribution = false;
    }
    return options;
  }

  /**
   * 渲染产品入口卡片
   */
  function renderProductHub() {
    if (!productHubCards) return;
    productHubCards.replaceChildren();
    QUANT_PRODUCTS.forEach((product) => {
      const gate = assertProductAllowed(product.id, entitlements);
      const locked = !product.enabled || !gate.ok;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = [
        'text-left rounded-xl border p-4 transition-colors',
        locked
          ? 'border-white/10 bg-[#081624]/50 opacity-70 cursor-not-allowed'
          : 'border-blue-500/25 bg-[#081624]/70 hover:border-sky-400/50 hover:bg-[#0a1c2e] cursor-pointer',
      ].join(' ');
      card.setAttribute('data-product', product.id);
      // 占位卡可点（跳转咨询）；无权限的已上线产品进入锁态工作区
      card.disabled = false;

      const badge = document.createElement('span');
      badge.className = 'inline-block text-[10px] px-2 py-0.5 rounded-full border border-sky-400/35 text-sky-200/90 bg-sky-500/10 mb-2';
      badge.textContent = locked && !product.enabled ? (product.badge || '会员预留') : product.badge;

      const title = document.createElement('div');
      title.className = 'text-base font-semibold text-white';
      title.textContent = product.title;

      const sub = document.createElement('div');
      sub.className = 'text-xs text-blue-300/70 mt-0.5';
      sub.textContent = product.subtitle;

      const desc = document.createElement('p');
      desc.className = 'mt-2 text-xs text-blue-200/80 leading-relaxed';
      desc.textContent = product.description;

      const eta = document.createElement('p');
      eta.className = 'mt-3 text-[11px] text-blue-300/50';
      eta.textContent = product.etaHint || (locked ? '后续按会员等级开放' : '');

      card.appendChild(badge);
      card.appendChild(title);
      card.appendChild(sub);
      card.appendChild(desc);
      if (eta.textContent) card.appendChild(eta);

      card.addEventListener('click', () => {
        if (!product.enabled) {
          // 占位产品：引导咨询，不发分析
          window.location.href = './contact.html#contact-form';
          return;
        }
        const check = assertProductAllowed(product.id, entitlements);
        if (!check.ok) {
          enterProduct(product.id, { locked: true, lockMessage: check.message });
          return;
        }
        enterProduct(product.id);
      });

      productHubCards.appendChild(card);
    });
  }

  function setProductInUrl(productId, { clearJob = false } = {}) {
    try {
      const url = new URL(window.location.href);
      if (productId) url.searchParams.set('product', productId);
      else url.searchParams.delete('product');
      if (clearJob) url.searchParams.delete('jobId');
      window.history.replaceState({}, '', url.toString());
    } catch (_) { /* ignore */ }
  }

  function showHub({ keepJob = false } = {}) {
    currentProductId = '';
    if (productHub) productHub.classList.remove('hidden');
    if (toolHero) toolHero.classList.add('hidden');
    if (workspaceLock) workspaceLock.classList.add('hidden');
    setProductInUrl('', { clearJob: !keepJob && !currentJobId });
    // 回到 Hub 时若仍在轮询，保留进度面板；否则不强制隐藏
  }

  /**
   * 进入产品工作区
   * @param {string} productId
   * @param {{ locked?: boolean, lockMessage?: string, skipUrl?: boolean }} opts
   */
  function enterProduct(productId, opts = {}) {
    const product = getProduct(productId);
    if (!product) {
      showHub();
      return;
    }
    currentProductId = product.id;
    progressProfile = getProgressProfile(product.id);
    setActiveSteps(progressProfile.steps);

    if (productHub) productHub.classList.add('hidden');
    if (toolHero) toolHero.classList.remove('hidden');

    if (workspaceTitle) workspaceTitle.textContent = product.title;
    if (workspaceDesc) workspaceDesc.textContent = product.description;
    if (productBadge) {
      productBadge.textContent = product.badge || product.engine;
      productBadge.classList.remove('hidden');
    }
    if (symbolInput) symbolInput.placeholder = product.symbolPlaceholder || '';
    if (symbolHint) symbolHint.textContent = product.symbolHint || '';

    const caps = product.capabilities || {};
    const setWrap = (el, show) => {
      if (!el) return;
      el.classList.toggle('hidden', !show);
    };
    setWrap(modeSelectWrap, !!(caps.multiSymbols || caps.marketOnly));
    // 模式选择：无 marketOnly 时去掉「仅大盘」并强制 stocks-only
    if (modeSelect) {
      const marketOpt = modeSelect.querySelector('option[value="market-only"]');
      if (marketOpt) marketOpt.hidden = !caps.marketOnly;
      if (!caps.marketOnly && !caps.multiSymbols) {
        modeSelect.value = 'stocks-only';
      }
    }
    setWrap(optMarketContextWrap, !!caps.marketContext);
    setWrap(optRealtimeQuoteWrap, !!caps.realtimeQuote);
    setWrap(optRealtimeTechWrap, !!caps.realtimeTech);
    setWrap(optChipDistWrap, !!caps.chipDistribution);
    if (advancedHint) {
      advancedHint.textContent = product.id === 'tradingagents'
        ? '多智能体模式耗时更长，请耐心等待；报告结构与标准投研略有不同。'
        : '开启实时增强可能增加分析耗时；关闭后仍可生成基础报告。';
    }

    const locked = !!opts.locked;
    if (workspaceLock) {
      workspaceLock.classList.toggle('hidden', !locked);
      if (workspaceLockMsg && opts.lockMessage) workspaceLockMsg.textContent = opts.lockMessage;
    }
    if (btnAnalyze) btnAnalyze.disabled = locked;

    if (!opts.skipUrl) setProductInUrl(product.id);
  }

  function readProductFromUrl() {
    try {
      return (new URLSearchParams(window.location.search).get('product') || '').trim().toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function showInputHint(msg) {
    if (!inputHint) return;
    inputHint.textContent = msg;
    inputHint.style.opacity = '1';
    clearTimeout(inputHint._t);
    inputHint._t = setTimeout(() => { inputHint.style.opacity = '0'; }, 3500);
  }

  function setBtnState(state, sec) {
    if (!btnAnalyze) return;
    btnAnalyze.disabled = state !== 'idle';
    btnAnalyze.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
    if (state === 'loading') {
      setIcon(btnIcon, 'spinner', { spin: true, className: 'relative z-10', size: 16 });
      if (btnLabel) btnLabel.textContent = '分析中…';
      btnAnalyze.style.opacity = '0.65';
      btnAnalyze.style.cursor = 'not-allowed';
    } else if (state === 'cooldown') {
      setIcon(btnIcon, 'clock', { className: 'relative z-10 text-orange-300', size: 16 });
      if (btnLabel) btnLabel.textContent = sec ? `${sec}s` : '冷却中';
      btnAnalyze.style.opacity = '0.75';
      btnAnalyze.style.cursor = 'not-allowed';
    } else {
      setIcon(btnIcon, 'sparkles', { className: 'text-yellow-300 relative z-10', size: 16 });
      if (btnLabel) btnLabel.textContent = '生成 AI 分析报告';
      btnAnalyze.style.opacity = '';
      btnAnalyze.style.cursor = '';
    }
  }

  function startCooldown() {
    lastTriggerTime = Date.now();
    const iv = setInterval(() => {
      const rem = Math.ceil((COOLDOWN_MS - (Date.now() - lastTriggerTime)) / 1000);
      if (rem <= 0) { clearInterval(iv); setBtnState('idle'); }
      else { setBtnState('cooldown', rem); }
    }, 500);
  }

  function loadRecentJobs() {
    try {
      const raw = localStorage.getItem(RECENT_JOBS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function saveRecentJob(entry) {
    if (!entry || !entry.jobId) return;
    const prev = loadRecentJobs().find((item) => item.jobId === entry.jobId) || {};
    const list = loadRecentJobs().filter((item) => item.jobId !== entry.jobId);
    list.unshift({
      jobId: entry.jobId,
      symbol: entry.symbol || prev.symbol || '',
      product: entry.product || prev.product || currentProductId || DEFAULT_PRODUCT_ID,
      engine: entry.engine || prev.engine || '',
      status: entry.status || prev.status || 'queued',
      requestedAt: entry.requestedAt || prev.requestedAt || Date.now(),
      generatedAt: entry.generatedAt || prev.generatedAt || 0,
      rating: entry.rating != null ? entry.rating : (prev.rating || ''),
      riskLevel: entry.riskLevel != null ? entry.riskLevel : (prev.riskLevel || ''),
      trend: entry.trend != null ? entry.trend : (prev.trend || ''),
      confidence: entry.confidence != null ? entry.confidence : prev.confidence,
    });
    try {
      localStorage.setItem(RECENT_JOBS_KEY, JSON.stringify(list.slice(0, RECENT_JOBS_MAX)));
    } catch (_) { /* ignore */ }
  }

  function persistJobIdToUrl(jobId) {
    if (!jobId) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('jobId', jobId);
      if (currentProductId) url.searchParams.set('product', currentProductId);
      window.history.replaceState({}, '', url.toString());
    } catch (_) { /* ignore */ }
  }

  function bootstrapFromUrlOrStorage() {
    const params = new URLSearchParams(window.location.search);
    const jobId = (params.get('jobId') || '').trim();
    const productFromUrl = (params.get('product') || '').trim().toLowerCase();

    if (jobId) {
      const recent = loadRecentJobs().find((item) => item.jobId === jobId);
      const productId = productFromUrl
        || (recent && recent.product)
        || DEFAULT_PRODUCT_ID;
      const gate = assertProductAllowed(productId, entitlements);
      if (gate.ok) enterProduct(productId, { skipUrl: true });
      else enterProduct(productId, { skipUrl: true, locked: true, lockMessage: gate.message });
      resumeJob(jobId, recent ? recent.symbol : '', productId);
      return;
    }

    if (productFromUrl) {
      const gate = assertProductAllowed(productFromUrl, entitlements);
      if (getProduct(productFromUrl)) {
        enterProduct(productFromUrl, gate.ok ? {} : { locked: true, lockMessage: gate.message });
        return;
      }
    }

    showHub();
  }

  function resumeJob(jobId, symbol, productId) {
    if (!jobId) return;
    stopPolling();
    stopAnalyzeSimMessages();
    isResultReady = false;
    currentJobId = jobId;
    if (productId) {
      currentProductId = productId;
      progressProfile = getProgressProfile(productId);
      setActiveSteps(progressProfile.steps);
    }
    lastPhase = '';
    usePhaseProgress = false;
    lastPhaseSource = 'simulated';
    lastRunId = '';
    lastUpdatedAt = 0;
    persistJobIdToUrl(jobId);
    saveRecentJob({
      jobId,
      symbol,
      product: currentProductId || productId || DEFAULT_PRODUCT_ID,
      status: 'queued',
    });

    buildSteps(stepsContainer);
    showPanel();
    setProgressCollapsed(progressPanel, btnToggleProgress, false);
    if (panelSymbol) panelSymbol.textContent = symbol || '分析中…';
    setBadge('running');
    setPanelIcon('spin');
    setPhaseSourceHint('simulated');
    updateDebugInfo({ source: '' });
    applyProgress(Math.max(currentProgress, 5));
    startElapsedTimer();
    activateStep(0, panelMessage);
    setStatusMessage(panelMessage, [{ text: '已恢复分析进度，正在同步最新状态…', tone: 'info' }]);
    setBtnState('loading');
    pollJobResult(jobId);
  }

  function showPanel() {
    if (!progressPanel) return;
    progressPanel.style.display = 'block';
    progressPanel.style.animation = 'none';
    void progressPanel.offsetHeight;
    progressPanel.style.animation = '';
    setQuantFocus(true);
  }

  function applyProgress(pct) {
    const v = Math.min(Math.max(pct, 0), 100).toFixed(1);
    if (progressFill) progressFill.style.width = `${v}%`;
    if (progressPct) {
      if (pct >= 99.5) {
        progressPct.textContent = '100%';
      } else if (usePhaseProgress && lastPhase) {
        const label = PHASE_LABELS[lastPhase] || lastPhase;
        const tip = (activePhaseEta()[lastPhase] && activePhaseEta()[lastPhase].typical) || '';
        progressPct.textContent = tip ? `${label} · ${tip}` : label;
      } else {
        progressPct.textContent = `约 ${Math.round(pct)}%`;
      }
    }
    if (progressLabel) {
      if (pct >= 99.5) progressLabel.textContent = '总体进度';
      else progressLabel.textContent = usePhaseProgress ? '当前阶段' : '预估进度';
    }
  }

  function startVirtualProgress(from, to, durationMs) {
    if (progressRafId) cancelAnimationFrame(progressRafId);
    const cappedTo = usePhaseProgress ? to : Math.min(to, activeProgressCap());
    const start = performance.now();
    const delta = cappedTo - from;
    if (delta <= 0) {
      applyProgress(from);
      return;
    }
    function tick(now) {
      if (isResultReady) return;
      const t = Math.min((now - start) / durationMs, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      currentProgress = from + delta * eased;
      applyProgress(currentProgress);
      if (t < 1) progressRafId = requestAnimationFrame(tick);
    }
    progressRafId = requestAnimationFrame(tick);
  }

  function startElapsedTimer() {
    startTime = Date.now();
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      if (!panelElapsed) return;
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      panelElapsed.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopElapsedTimer() { clearInterval(elapsedTimer); }

  function formatRemainHint(phase) {
    const eta = activePhaseEta()[phase];
    if (!eta) return '';
    if (eta.remainMax <= 0) return '即将完成';
    // 研判阶段耗时已在进度条旁「阶段名 · 约 2–5 分钟」展示，底部不再重复「预计还需」
    if (phase === 'analyze') return '';
    if (eta.remainMin === eta.remainMax) return `预计还需约 ${eta.remainMin} 分钟`;
    return `预计还需约 ${eta.remainMin}–${eta.remainMax} 分钟`;
  }

  function stopAnalyzeSimMessages() {
    if (analyzeSimTimer) {
      clearInterval(analyzeSimTimer);
      analyzeSimTimer = null;
    }
  }

  /** Fisher–Yates 洗牌；尽量避免与上一轮末条首尾相接造成「刚看过又出现」 */
  function shuffleAnalyzeMessages(excludeLast) {
    const pool = activeAnalyzeMessages().slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    if (excludeLast && pool.length > 1 && pool[0] === excludeLast) {
      const swapAt = 1 + Math.floor(Math.random() * (pool.length - 1));
      const tmp = pool[0];
      pool[0] = pool[swapAt];
      pool[swapAt] = tmp;
    }
    return pool;
  }

  function nextAnalyzeSimMessage() {
    if (!analyzeSimQueue.length) {
      analyzeSimQueue = shuffleAnalyzeMessages(analyzeSimLast);
    }
    const sim = analyzeSimQueue.shift();
    analyzeSimLast = sim;
    return sim;
  }

  function startAnalyzeSimMessages(baseMessage) {
    stopAnalyzeSimMessages();
    analyzeSimQueue = shuffleAnalyzeMessages(analyzeSimLast);
    const remain = formatRemainHint('analyze');

    const paint = () => {
      if (isResultReady) {
        stopAnalyzeSimMessages();
        return;
      }
      if (usePhaseProgress && lastPhase && lastPhase !== 'analyze') {
        stopAnalyzeSimMessages();
        return;
      }
      const sim = nextAnalyzeSimMessage();
      if (!panelMessage) return;
      const head = (baseMessage && String(baseMessage).trim())
        ? String(baseMessage).trim()
        : activeStepsList()[VIRTUAL_HOLD_STEP_INDEX].desc;
      const parts = [
        { text: head, tone: 'info' },
        { br: true },
        { text: sim, tone: 'muted', opacity: 0.9 },
      ];
      if (remain) parts.push({ text: ` · ${remain}`, tone: 'muted', opacity: 0.95 });
      setStatusMessage(panelMessage, parts);
    };

    paint();
    // 拉长间隔，配合更大文案池，分析阶段内基本不会循环重复
    analyzeSimTimer = setInterval(paint, ANALYZE_SIM_INTERVAL_MS);
  }

  function applyPhaseProgress(phase, phaseMessage) {
    if (!phase) return;
    const idx = PHASE_STEP_INDEX[phase];
    if (typeof idx !== 'number' || idx < 0) return;

    const phaseChanged = phase !== lastPhase;
    lastPhase = phase;
    setPhaseSourceHint('github-manifest');

    if (idx < VIRTUAL_HOLD_STEP_INDEX) {
      const alreadyPast = currentProgress >= getStepStartPct(VIRTUAL_HOLD_STEP_INDEX) - 0.5
        || !!analyzeSimTimer;
      if (!alreadyPast && phaseChanged) {
        activateStep(idx, panelMessage);
        const from = Math.max(currentProgress, getStepStartPct(idx));
        const to = Math.min(getStepEndPct(idx), getStepStartPct(VIRTUAL_HOLD_STEP_INDEX));
        const durSec = activeVirtualStepSeconds()[idx] != null
          ? activeVirtualStepSeconds()[idx]
          : ((activeStepsList()[idx] && activeStepsList()[idx].duration) || 15);
        if (to > from) {
          startVirtualProgress(from, to, Math.max(durSec * 600, 1500));
        }
      }
      if (panelMessage && !analyzeSimTimer && !alreadyPast) {
        const label = PHASE_LABELS[phase] || phase;
        let msg = (phaseMessage || `当前阶段：${label}`).trim();
        const eta = activePhaseEta()[phase];
        if (eta && eta.typical && !msg.includes('通常') && !msg.includes('约')) {
          msg += `（${eta.typical}）`;
        }
        setStatusMessage(panelMessage, [{ text: msg, tone: 'info' }]);
      }
      return;
    }

    usePhaseProgress = true;

    if (phaseChanged) {
      activateStep(idx, panelMessage);
      if (phase !== 'analyze') stopAnalyzeSimMessages();
      const from = Math.max(currentProgress, getStepStartPct(idx));
      const to = getStepEndPct(idx);
      const durSec = (activeStepsList()[idx] && activeStepsList()[idx].duration) || 30;
      if (to > from) {
        startVirtualProgress(from, to, Math.max(durSec * 800, 3000));
      } else {
        applyProgress(to);
        currentProgress = to;
      }
    }

    const label = PHASE_LABELS[phase] || phase;
    const eta = activePhaseEta()[phase];
    const remain = formatRemainHint(phase);

    if (phase === 'analyze') {
      if (phaseChanged || !analyzeSimTimer) {
        const base = (phaseMessage || `当前阶段：${label}`).trim();
        startAnalyzeSimMessages(base);
      }
    } else if (panelMessage) {
      let msg = (phaseMessage || `当前阶段：${label}`).trim();
      if (eta && eta.typical && !msg.includes('通常') && !msg.includes('约')) {
        msg += `（${eta.typical}）`;
      }
      const parts = [{ text: msg, tone: 'info' }];
      if (remain) parts.push({ text: ` · ${remain}`, tone: 'muted', opacity: 0.95 });
      setStatusMessage(panelMessage, parts);
    }
    if (progressPct && usePhaseProgress && phase !== 'succeeded') {
      const tip = eta && eta.typical ? eta.typical : '';
      progressPct.textContent = tip ? `${label} · ${tip}` : label;
    }
  }

  function handleAnalyze() {
    if (isTriggering) return;
    if (btnAnalyze && btnAnalyze.disabled) return;
    if (!currentProductId) {
      showInputHint('请先选择分析产品');
      showHub();
      return;
    }
    const gate = assertProductAllowed(currentProductId, entitlements);
    if (!gate.ok) {
      showInputHint(gate.message || '当前产品暂不可用');
      return;
    }

    const raw = (symbolInput ? symbolInput.value.trim().toUpperCase() : '');
    const options = collectAnalysisOptions();
    const symbols = normalizeSymbols(raw);
    if (!symbols.length) { showInputHint('请输入股票代码（例如 00700.HK 或 AAPL）'); return; }
    if (!options.multiSymbols && symbols.length > 1) { showInputHint('当前不支持多股票，请只输入一个代码'); return; }
    const invalidSymbol = symbols.find((sym) => !isValidSymbol(sym));
    if (invalidSymbol) { showInputHint(`格式不合法：「${invalidSymbol}」，请使用如 00700.HK、AAPL`); return; }

    const normalizedSymbol = symbols.join(',');
    const elapsed = Date.now() - lastTriggerTime;
    if (elapsed < COOLDOWN_MS && lastTriggerTime > 0) {
      showInputHint(`请等待 ${Math.ceil((COOLDOWN_MS - elapsed) / 1000)}s 后再次触发`);
      return;
    }

    isTriggering = true;
    setBtnState('loading');

    startCloudWorkflow(normalizedSymbol, options).catch((err) => {
      console.error('[quant] 工作流异常:', err);
      isTriggering = false;
      setBtnState('idle');
    });
  }

  async function startCloudWorkflow(symbol, options) {
    stopPolling();
    stopAnalyzeSimMessages();
    if (progressRafId) { cancelAnimationFrame(progressRafId); progressRafId = null; }

    isResultReady = false;
    currentJobId = '';
    lastPhase = '';
    usePhaseProgress = false;
    lastPhaseSource = 'simulated';
    lastActionsUrl = '';
    lastManifestUrl = '';
    lastRunId = '';
    lastUpdatedAt = 0;
    if (reportContainer) reportContainer.classList.add('hidden');
    if (emptyState) emptyState.style.display = 'flex';
    if (reportTabs) {
      reportTabs.innerHTML = '';
      reportTabs.classList.add('hidden');
    }
    if (reportPanels) reportPanels.innerHTML = '';

    buildSteps(stepsContainer);
    showPanel();
    setProgressCollapsed(progressPanel, btnToggleProgress, false);
    if (panelSymbol) panelSymbol.textContent = symbol;
    setBadge('running');
    setPanelIcon('spin');
    setPhaseSourceHint('simulated');
    updateDebugInfo({ source: '' });
    applyProgress(0);
    currentProgress = 0;
    startElapsedTimer();

    activateStep(0, panelMessage);
    const firstDurMs = (activeVirtualStepSeconds()[0] != null ? activeVirtualStepSeconds()[0] : activeStepsList()[0].duration) * 1000;
    startVirtualProgress(0, Math.min(getStepEndPct(0), activeProgressCap()), firstDurMs);

    const t0 = Date.now();
    const forceRunForDedupe = forceRunCheckbox ? !!forceRunCheckbox.checked : true;

    try {
      let signal;
      try { signal = AbortSignal.timeout(15000); } catch (_) {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 15000);
        signal = ctrl.signal;
      }

      const res = await fetch(UNICLOUD_TRIGGER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          forceRun: forceRunForDedupe,
          ...options,
        }),
        signal,
      });

      let rawResult;
      try { rawResult = await res.json(); } catch { throw new Error(`服务端响应格式异常（HTTP ${res.status}）`); }

      const { result, statusNum } = unwrapGatewayJson(rawResult, res.status);

      if (!res.ok || statusNum >= 400 || !result || !result.success) {
        if (statusNum === 429 || (result && (result.code === 'RATE_LIMITED' || result.code === 'DAILY_QUOTA_EXCEEDED'))) {
          throw new Error((result && result.message) || `触发频率过高，请 ${(result && result.resetIn) || 300} 秒后重试`);
        }
        if (result && (result.code === 'PRODUCT_NOT_ALLOWED' || result.code === 'PRODUCT_NOT_FOUND')) {
          throw new Error((result && result.message) || '当前产品暂不可用');
        }
        if (result && result.code === 'PAT_NOT_CONFIGURED') {
          throw new Error(result.message || '分析服务暂未就绪，请稍后再试或联系站长');
        }
        throw new Error((result && result.message) || `创建分析任务失败（HTTP ${statusNum}）`);
      }

      if (!result.jobId) {
        throw new Error('未能创建分析任务，请稍后重试');
      }
      currentJobId = String(result.jobId);
      if (result.product) currentProductId = String(result.product);
      lastActionsUrl = result.actionsUrl || '';
      persistJobIdToUrl(currentJobId);
      saveRecentJob({
        jobId: currentJobId,
        symbol,
        product: currentProductId || options.product || DEFAULT_PRODUCT_ID,
        engine: options.engine || '',
        status: result.status || 'queued',
        requestedAt: result.requestedAt || Date.now(),
      });

      if (result.reused) {
        setStatusMessage(panelMessage, [{ text: '已复用近期同参数分析，直接同步进度…', tone: 'warn' }]);
      }
    } catch (err) {
      console.error('[quant] 派发失败:', err);
      if (progressRafId) { cancelAnimationFrame(progressRafId); progressRafId = null; }
      stopElapsedTimer();
      isTriggering = false;
      setBtnState('idle');
      setPanelIcon('error');
      setBadge('error');
      applyProgress(0);
      setStatusMessage(panelMessage, [{ text: err.message || '网络错误，请检查连接后重试', tone: 'error' }]);
      markFirstStepError();
      return;
    }

    completeStep(0, (Date.now() - t0) / 1000);
    isTriggering = false;
    startCooldown();

    setStatusMessage(panelMessage, [{ text: '分析任务已创建，正在等待云端开始同步状态…', tone: 'info' }]);
    setPhaseSourceHint('simulated');
    updateDebugInfo({ source: 'pending' });

    if (UNICLOUD_RESULT_URL && currentJobId) {
      pollJobResult(currentJobId);
    }

    runVirtualSteps(1);
  }

  async function runVirtualSteps(startIdx) {
    const holdIdx = VIRTUAL_HOLD_STEP_INDEX;

    for (let i = startIdx; i <= holdIdx; i++) {
      if (isResultReady || usePhaseProgress) return;

      if (currentProgress >= activeProgressCap() - 0.5) {
        activateStep(holdIdx, panelMessage);
        setPhaseSourceHint(
          lastPhaseSource === 'db' || lastPhaseSource === 'pending'
            ? lastPhaseSource
            : 'simulated'
        );
        startAnalyzeSimMessages('云端大模型综合研判进行中，请保持页面开启…');
        return;
      }

      const isHold = (i === holdIdx);
      const to = isHold
        ? activeProgressCap()
        : Math.min(getStepEndPct(i), activeProgressCap());
      const durSec = activeVirtualStepSeconds()[i] != null
        ? activeVirtualStepSeconds()[i]
        : activeStepsList()[i].duration;
      const durMs = Math.max(durSec * 1000, isHold ? 8000 : 2000);

      activateStep(i, panelMessage);
      if (isHold) {
        setPhaseSourceHint(
          lastPhaseSource === 'db' || lastPhaseSource === 'pending'
            ? lastPhaseSource
            : 'simulated'
        );
        startAnalyzeSimMessages('正在运行 AI 策略与大模型推理，生成投研观点…');
      }

      startVirtualProgress(currentProgress, to, durMs);
      const t0 = Date.now();

      const checkInterval = 200;
      let slept = 0;
      while (slept < durMs) {
        if (isResultReady || usePhaseProgress) return;
        await sleep(checkInterval);
        slept += checkInterval;
      }

      if (isResultReady || usePhaseProgress) return;
      if (!isHold) completeStep(i, (Date.now() - t0) / 1000);
    }

    if (!isResultReady && !usePhaseProgress) {
      activateStep(holdIdx, panelMessage);
      applyProgress(activeProgressCap());
      currentProgress = activeProgressCap();
      setPhaseSourceHint(
        lastPhaseSource === 'db' || lastPhaseSource === 'pending'
          ? lastPhaseSource
          : 'simulated'
      );
      startAnalyzeSimMessages('云端大模型综合研判进行中，请保持页面开启…');
    }
  }

  function finishWorkflowSuccess(data) {
    if (isResultReady) return;
    isResultReady = true;
    stopPolling();
    stopAnalyzeSimMessages();
    if (progressRafId) { cancelAnimationFrame(progressRafId); progressRafId = null; }

    lastActionsUrl = data.actionsUrl || lastActionsUrl;
    lastManifestUrl = data.manifestUrl || (data.resultFiles && data.resultFiles.manifestUrl) || lastManifestUrl;
    {
      const m = (data && data.metrics && typeof data.metrics === 'object') ? data.metrics : {};
      saveRecentJob({
        jobId: data.jobId || currentJobId,
        symbol: data.symbol || (panelSymbol && panelSymbol.textContent) || '',
        product: data.product || currentProductId || DEFAULT_PRODUCT_ID,
        engine: data.engine || '',
        status: 'succeeded',
        requestedAt: data.requestedAt || Date.now(),
        generatedAt: data.generatedAt || Date.now(),
        rating: m.rating || '',
        riskLevel: m.riskLevel || '',
        trend: m.trend || '',
        confidence: m.confidence,
      });
      if (data.product && data.product !== currentProductId) {
        currentProductId = data.product;
        progressProfile = getProgressProfile(currentProductId);
        setActiveSteps(progressProfile.steps);
      }
    }

    const startVal = currentProgress;
    const startT = performance.now();
    function rushTick(now) {
      const t = Math.min((now - startT) / 500, 1);
      currentProgress = startVal + (100 - startVal) * t;
      applyProgress(currentProgress);
      if (t < 1) {
        requestAnimationFrame(rushTick);
      } else {
        applyProgress(100);
        markAllStepsDone();
        stopElapsedTimer();
        setPanelIcon('check');
        setBadge('success');
        setPhaseSourceHint(data.phaseSource === 'db-cache' ? 'db-cache' : 'github-manifest');
        updateDebugInfo({ source: data.source || '' });
        setBtnState('idle');
        renderReport(data);
        // 完成后折叠进度详情，报告成为主舞台
        setProgressCollapsed(progressPanel, btnToggleProgress, true);

        const parts = [
          { text: 'AI 投研报告已就绪！', tone: 'success', weight: '500' },
        ];
        if (data.errorCode === 'PARTIAL_RESULT') {
          parts.push({ text: '（部分结果）', tone: 'warn' });
        }
        parts.push({ text: ' 已在下方展示。', tone: 'info', opacity: 0.9 });
        setStatusMessage(panelMessage, parts);
      }
    }
    requestAnimationFrame(rushTick);
  }

  function finishWorkflowFailure(data) {
    if (isResultReady) return;
    isResultReady = true;
    stopPolling();
    stopAnalyzeSimMessages();
    if (progressRafId) { cancelAnimationFrame(progressRafId); progressRafId = null; }
    stopElapsedTimer();
    setPanelIcon('error');
    setBadge('error');
    setBtnState('idle');
    applyProgress(currentProgress);

    lastActionsUrl = (data && data.actionsUrl) || lastActionsUrl;
    lastManifestUrl = (data && (data.manifestUrl || (data.resultFiles && data.resultFiles.manifestUrl))) || lastManifestUrl;
    saveRecentJob({
      jobId: (data && data.jobId) || currentJobId,
      symbol: (data && data.symbol) || (panelSymbol && panelSymbol.textContent) || '',
      status: (data && data.status) || 'failed',
      requestedAt: (data && data.requestedAt) || Date.now(),
    });

    const statusLabel = STATUS_LABELS[data && data.status] || '失败';
    const errMsg = (data && data.error) || `分析${statusLabel}`;
    setStatusMessage(panelMessage, [
      { text: errMsg, tone: 'error' },
      { br: true },
      { text: '分析服务繁忙或任务异常，请稍后重试；也可返回本页继续查看。', tone: 'info', opacity: 0.8, size: '0.8rem' },
    ]);
  }

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function nextPollInterval(elapsedMs) {
    if (elapsedMs < POLL_FAST_WINDOW_MS) return POLL_INTERVAL_INITIAL;
    const steps = Math.floor((elapsedMs - POLL_FAST_WINDOW_MS) / 60000);
    return Math.min(POLL_INTERVAL_INITIAL * Math.pow(2, steps + 1), POLL_INTERVAL_MAX);
  }

  function pollJobResult(jobId) {
    const deadline = Date.now() + activePollDeadlineMs();
    const pollStartedAt = Date.now();
    let rawFallbackTried = false;

    async function tryRawFallback() {
      if (rawFallbackTried || isResultReady) return false;
      rawFallbackTried = true;
      const fallback = await fetchJobFromGithubRaw(jobId, {
        onManifest({ manifestUrl, runId, updatedAt }) {
          lastManifestUrl = manifestUrl || lastManifestUrl;
          if (runId) lastRunId = String(runId);
          if (updatedAt) lastUpdatedAt = Number(updatedAt) || 0;
        },
      });
      if (!fallback) return false;
      if (fallback.status === 'succeeded' && fallback.ready) {
        finishWorkflowSuccess(fallback);
        return true;
      }
      if (fallback.status === 'failed' || fallback.status === 'timeout') {
        finishWorkflowFailure(fallback);
        return true;
      }
      return false;
    }

    async function tick() {
      if (isResultReady) return;
      if (jobId !== currentJobId) return;

      if (Date.now() >= deadline) {
        if (await tryRawFallback()) return;
        stopPolling();
        if (!isResultReady) {
          stopElapsedTimer();
          setPanelIcon('error');
          setBadge('error');
          setBtnState('idle');
          if (panelMessage) {
            panelMessage.replaceChildren();
            const span = document.createElement('span');
            span.style.color = '#fb923c';
            span.textContent = '等待超时。任务可能仍在运行，可稍后返回本页继续查看（已保留任务 ID）。';
            panelMessage.appendChild(span);
            const reCheckBtn = document.createElement('button');
            reCheckBtn.type = 'button';
            reCheckBtn.id = 'btn-re-check';
            reCheckBtn.textContent = '手动重新拉取结果';
            reCheckBtn.style.cssText = 'margin-left:8px;padding:2px 8px;background:rgba(59,130,246,0.2);border:1px solid #3b82f6;color:#93c5fd;border-radius:4px;cursor:pointer;font-size:0.75rem';
            reCheckBtn.onclick = () => {
              isResultReady = false;
              rawFallbackTried = false;
              setBadge('running');
              setPanelIcon('spin');
              setBtnState('loading');
              startElapsedTimer();
              pollJobResult(jobId);
            };
            panelMessage.appendChild(reCheckBtn);
          }
        }
        return;
      }

      try {
        const url = `${UNICLOUD_RESULT_URL}?jobId=${encodeURIComponent(jobId)}&t=${Date.now()}`;
        const res = await fetch(url);
        if (res.ok) {
          const rawData = await res.json();
          const { result: data } = unwrapGatewayJson(rawData, res.status);

          if (data && data.success !== false) {
            const status = data.status || '';
            if (data.actionsUrl) lastActionsUrl = data.actionsUrl;
            if (data.manifestUrl) lastManifestUrl = data.manifestUrl;
            else if (data.resultFiles && data.resultFiles.manifestUrl) lastManifestUrl = data.resultFiles.manifestUrl;
            if (data.runId) lastRunId = String(data.runId);
            if (data.updatedAt) lastUpdatedAt = Number(data.updatedAt) || 0;

            const phaseSource = data.phaseSource || '';
            const realPhase = isRealPhaseSource(phaseSource, data.source);

            if (realPhase && data.phase) {
              applyPhaseProgress(data.phase, data.phaseMessage || '');
            } else if (phaseSource === 'db' || phaseSource === 'pending' || data.source === 'db' || data.source === 'pending') {
              setPhaseSourceHint(phaseSource || data.source || 'db');
              if (
                panelMessage
                && (status === 'queued' || status === 'running')
                && !usePhaseProgress
                && !analyzeSimTimer
                && currentProgress < getStepStartPct(VIRTUAL_HOLD_STEP_INDEX)
              ) {
                const waitHint = phaseSource === 'pending'
                  ? '任务已提交，云端状态同步中…'
                  : '任务已创建，等待云端开始同步阶段…';
                setStatusMessage(panelMessage, [{ text: waitHint, tone: 'info' }]);
              }
            } else if (
              panelMessage
              && (status === 'queued' || status === 'running')
              && !data.phase
              && !usePhaseProgress
              && !analyzeSimTimer
            ) {
              const label = STATUS_LABELS[status] || status;
              setStatusMessage(panelMessage, [{ text: `当前状态：${label}，正在同步分析进度…`, tone: 'info' }]);
            }

            updateDebugInfo({ source: data.source || '' });

            if (status === 'succeeded' && data.ready) {
              finishWorkflowSuccess(data);
              return;
            }
            if (status === 'failed' || status === 'timeout') {
              finishWorkflowFailure(data);
              return;
            }

            if (
              (data.errorCode === 'EMPTY_REPORT' || data.errorCode === 'FETCH_FAILED')
              && await tryRawFallback()
            ) {
              return;
            }

            if (data.errorCode === 'FETCH_FAILED' && realPhase) {
              setStatusMessage(panelMessage, [{
                text: data.error || data.phaseMessage || '报告已发布，正在重试读取…',
                tone: 'warn',
              }]);
            }
          }
        } else if (res.status === 404) {
          if (await tryRawFallback()) return;
          finishWorkflowFailure({ status: 'failed', error: '任务不存在或已被清理', errorCode: 'NOT_FOUND' });
          return;
        } else if (await tryRawFallback()) {
          return;
        }
      } catch (_) {
        if (await tryRawFallback()) return;
      }

      if (isResultReady) return;
      const wait = nextPollInterval(Date.now() - pollStartedAt);
      pollTimer = setTimeout(tick, wait);
    }

    tick();
  }

  function setHistoryExpanded(expanded) {
    if (!historyList) return;
    const hasRows = historyList.children.length > 0;
    historyList.classList.toggle('hidden', !expanded || !hasRows);
    if (historyEmptyEl) {
      historyEmptyEl.classList.toggle('hidden', !expanded || hasRows);
    }
    if (btnToggleHistory) btnToggleHistory.textContent = expanded ? '收起' : '展开';
    if (historyPanel) historyPanel.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function renderJobHistoryRows(items) {
    if (!historyList) return;
    historyList.innerHTML = '';

    items.forEach((item, index) => {
      const jobId = item.jobId || '';
      if (!jobId) return;

      const row = document.createElement('button');
      row.type = 'button';
      const isCurrent = !!(currentJobId && jobId === currentJobId);
      row.className = isCurrent ? 'is-current' : '';

      const when = formatTime(item.generatedAt || item.requestedAt) || '时间未知';
      const sym = String(item.symbol || '').toUpperCase() || '未知标的';
      const statusText = formatJobStatus(item.status);
      const metaParts = [
        statusText ? `状态 ${statusText}` : '',
        item.rating ? `观点 ${item.rating}` : '',
        item.trend ? `趋势 ${item.trend}` : '',
        item.riskLevel ? `风险 ${item.riskLevel}` : '',
        formatConfidence(item.confidence) ? `置信度 ${formatConfidence(item.confidence)}` : '',
      ].filter(Boolean);

      const title = document.createElement('div');
      title.className = 'hist-title';
      const badge = document.createElement('span');
      badge.className = 'hist-badge';
      badge.textContent = `#${items.length - index}`;
      const symEl = document.createElement('span');
      symEl.className = 'font-mono text-sky-300';
      symEl.textContent = sym;
      const whenEl = document.createElement('span');
      whenEl.textContent = when;
      title.appendChild(badge);
      title.appendChild(symEl);
      title.appendChild(whenEl);
      if (isCurrent) {
        const cur = document.createElement('span');
        cur.className = 'hist-badge';
        cur.textContent = '当前';
        title.appendChild(cur);
      }

      const meta = document.createElement('div');
      meta.className = 'hist-meta';
      meta.textContent = metaParts.length ? metaParts.join(' · ') : '点击回看该次分析报告';

      row.appendChild(title);
      row.appendChild(meta);
      row.addEventListener('click', () => {
        if (isCurrent && isResultReady) {
          if (reportContainer) {
            reportContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return;
        }
        resumeJob(jobId, sym, item.product || currentProductId || DEFAULT_PRODUCT_ID);
      });
      historyList.appendChild(row);
    });
  }

  function showJobHistory(options = {}) {
    const {
      expand = false,
      allowEmpty = true,
      scrollIntoView = false,
    } = options;

    if (!historyPanel || !historyList) return;

    const items = loadRecentJobs().filter((item) => item && item.jobId);
    if (historySymbolEl) historySymbolEl.textContent = '本机最近记录';

    if (!items.length) {
      if (!allowEmpty) {
        historyPanel.classList.add('hidden');
        return;
      }
      historyPanel.classList.remove('hidden');
      if (historyCountEl) historyCountEl.textContent = '0 条';
      historyList.innerHTML = '';
      if (historyEmptyEl) historyEmptyEl.classList.remove('hidden');
      setHistoryExpanded(true);
      if (scrollIntoView) {
        historyPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }

    if (historyEmptyEl) historyEmptyEl.classList.add('hidden');
    if (historyCountEl) historyCountEl.textContent = `共 ${items.length} 次`;
    renderJobHistoryRows(items);
    historyPanel.classList.remove('hidden');
    setHistoryExpanded(expand);
    if (scrollIntoView) {
      historyPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  async function renderReport(data) {
    if (!data) return;
    const symbol = (data.symbol || (panelSymbol ? panelSymbol.textContent : '') || '').toUpperCase();
    if (panelSymbol && symbol) panelSymbol.textContent = symbol;

    const reportMd = (data.report || '').trim();
    const marketMd = (data.marketReview || '').trim();
    const stockText = reportMd || (data.message || '').trim() || `# 股票 [${symbol}] AI 投研分析已完成\n\n暂无个股分析正文。`;

    if (reportTitle) {
      reportTitle.textContent = `AI 投研报告 · ${symbol}`;
    }

    if (reportMeta) {
      if (metaGenerated) {
        const t = formatTime(data.generatedAt);
        metaGenerated.textContent = t ? `生成于 ${t}` : '';
      }
      if (metaRunId) {
        metaRunId.textContent = data.errorCode === 'PARTIAL_RESULT' ? '部分结果' : '';
      }
      if (metaDegraded) {
        const degraded = data.metrics && Array.isArray(data.metrics.degradedFeatures)
          ? data.metrics.degradedFeatures.filter(Boolean)
          : [];
        metaDegraded.textContent = degraded.length
          ? `部分能力已降级：${degraded.join('、')}`
          : '';
      }
      const hasMeta = !!(
        (metaGenerated && metaGenerated.textContent)
        || (metaRunId && metaRunId.textContent)
        || (metaDegraded && metaDegraded.textContent)
      );
      reportMeta.classList.toggle('hidden', !hasMeta);
    }

    try {
      await ensureMarkdownLibs();
    } catch (err) {
      console.warn('[quant] Markdown 库加载失败，将降级为纯文本', err);
    }

    const stockSections = splitStockReportSections(stockText, symbol);
    buildReportTabs(reportTabs, reportPanels, stockSections, marketMd);
    showJobHistory({ expand: false, allowEmpty: false });

    if (emptyState) emptyState.style.display = 'none';
    if (reportContainer) reportContainer.classList.remove('hidden');
    setQuantFocus(true);
  }

  // 初始按钮图标（无 Font Awesome）
  setIcon(btnIcon, 'sparkles', { className: 'text-yellow-300 relative z-10', size: 16 });

  // 产品入口卡片 + URL/历史恢复
  renderProductHub();
  showJobHistory({ expand: false, allowEmpty: false });
  bootstrapFromUrlOrStorage();
});
