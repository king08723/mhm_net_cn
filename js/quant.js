/**
 * AI 量化投研分析控制脚本 (quant.js) v7.1
 *
 * 单链路（只认 jobId，内部实现细节不对用户展示）：
 *   浏览器 → trigger-stock-analysis → 返回 jobId
 *         → 云端分析流水线
 *         → jobs/{jobId}/*.md + manifest.json + metrics.json
 *         → 前端 GET get-stock-result?jobId= → 消毒渲染
 *
 * v7.1：用户可见文案产品化；诊断链接仅 ?debug=1 显示。
 */

document.addEventListener('DOMContentLoaded', () => {

  // =====================================================================
  // 接口与轮询配置
  // =====================================================================
  const UNICLOUD_TRIGGER_URL = 'https://f.nhm.net.cn/trigger-stock-analysis';
  const UNICLOUD_RESULT_URL  = 'https://f.nhm.net.cn/get-stock-result';
  const HISTORY_RAW_BASE =
    'https://raw.githubusercontent.com/king08723/daily_stock_analysis/analysis-results/docs';

  const COOLDOWN_MS            = 60 * 1000;
  const POLL_INTERVAL_INITIAL = 3000;
  const POLL_INTERVAL_MAX     = 15000;
  const POLL_FAST_WINDOW_MS   = 2 * 60 * 1000;
  const POLL_DEADLINE_MS      = 15 * 60 * 1000;
  const RECENT_JOBS_KEY       = 'quant_recent_jobs_v1';
  const RECENT_JOBS_MAX       = 8;

  const DEFAULT_ANALYSIS_OPTIONS = {
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

  // phase → 步骤索引；无 phase 时退回虚拟时间线
  const PHASE_STEP_INDEX = {
    queued: 0,
    checkout: 1,
    setup: 2,
    fetch: 3,
    analyze: 4,
    publish: 5,
    succeeded: 5,
    failed: -1,
  };

  // 用户可见进度文案（不暴露工程实现细节）
  const STEPS = [
    { id: 'dispatch', phase: 'queued',   icon: 'fa-paper-plane', label: '创建分析任务',  desc: '正在创建 AI 投研分析任务…', duration: 5   },
    { id: 'queue',    phase: 'checkout', icon: 'fa-layer-group', label: '云端算力排队',desc: '云端算力已接受请求，正在排队分配分析资源…', duration: 15  },
    { id: 'env',      phase: 'setup',    icon: 'fa-server',      label: '初始化分析环境', desc: '正在启动分析环境，准备大模型与数据组件…', duration: 45  },
    { id: 'fetch',    phase: 'fetch',    icon: 'fa-database',    label: '拉取行情数据',desc: '正在拉取历史行情、成交量与相关市场信息…', duration: 45  },
    { id: 'compute',  phase: 'analyze',  icon: 'fa-microchip',   label: '大模型综合研判', desc: '正在运行 AI 策略与大模型推理，生成投研观点…', duration: 180 },
    { id: 'output',   phase: 'publish',  icon: 'fa-chart-line',  label: '生成研究报告',desc: '正在整理摘要与正文，生成可阅读的研究报告…', duration: 30  },
  ];
  const TOTAL_DURATION = STEPS.reduce((s, st) => s + st.duration, 0);

  const SOURCE_LABELS = {
    db: '云端缓存',
    'github-job': '云端报告库',
    pending: '等待中',
  };

  const STATUS_LABELS = {
    queued: '排队中',
    running: '分析中',
    succeeded: '完成',
    failed: '失败',
    timeout: '超时',
  };

  const PHASE_LABELS = {
    queued: '排队中',
    checkout: '准备资源',
    setup: '初始化环境',
    fetch: '拉取数据',
    analyze: '大模型研判',
    publish: '生成报告',
    succeeded: '已完成',
    failed: '失败',
  };

  // 须在 bootstrapFromUrlOrStorage / resumeJob 之前初始化，避免 TDZ
  const BADGES = {
    running:  { text: '分析中', cls: 'text-blue-300  border-blue-400/40  bg-blue-500/10'   },
    success:  { text: '完成',   cls: 'text-green-300 border-green-400/40 bg-green-500/10'  },
    error:    { text: '失败',   cls: 'text-red-300   border-red-400/40   bg-red-500/10'    },
  };

  // =====================================================================
  // DOM 引用
  // =====================================================================
  const symbolInput     = document.getElementById('symbol-input');
  const modeSelect      = document.getElementById('mode-select');
  const reportTypeSelect = document.getElementById('report-type-select');
  const reportLanguageSelect = document.getElementById('report-language-select');
  const notificationEmailInput = document.getElementById('notification-email-input');
  const forceRunCheckbox = document.getElementById('force-run-checkbox');
  const optMarketContext = document.getElementById('opt-market-context');
  const optRealtimeQuote = document.getElementById('opt-realtime-quote');
  const optRealtimeTech = document.getElementById('opt-realtime-tech');
  const optChipDist = document.getElementById('opt-chip-dist');
  const btnToggleAdvanced = document.getElementById('btn-toggle-advanced');
  const advancedOptions = document.getElementById('advanced-options');
  const btnResumeLast = document.getElementById('btn-resume-last');
  const btnAnalyze      = document.getElementById('btn-analyze');
  const btnIcon         = document.getElementById('btn-icon');
  const btnLabel        = document.getElementById('btn-label');
  const progressPanel   = document.getElementById('progress-panel');
  const panelSymbol     = document.getElementById('panel-symbol');
  const panelIconEl     = document.getElementById('panel-icon');
  const panelIconWrap   = document.getElementById('panel-icon-wrap');
  const panelBadge      = document.getElementById('panel-badge');
  const panelElapsed    = document.getElementById('panel-elapsed');
  const panelMessage    = document.getElementById('panel-message');
  const progressFill    = document.getElementById('progress-bar-fill');
  const progressPct     = document.getElementById('progress-pct');
  const stepsContainer  = document.getElementById('steps-container');
  const emptyState      = document.getElementById('empty-state');
  const inputHint       = document.getElementById('input-hint');
  const reportContainer = document.getElementById('report-container');
  const reportTitle     = document.getElementById('report-title');
  const reportContent   = document.getElementById('report-content');
  const marketReviewContent = document.getElementById('market-review-content');
  const sectionMarketReview = document.getElementById('section-market-review');
  const sectionStockReport  = document.getElementById('section-stock-report');
  const reportLayout    = document.getElementById('report-layout');
  const reportMeta      = document.getElementById('report-meta');
  const metaSource      = document.getElementById('meta-source');
  const metaGenerated   = document.getElementById('meta-generated');
  const metaRunId       = document.getElementById('meta-runid');
  const metaDegraded    = document.getElementById('meta-degraded');
  const metricsSummary  = document.getElementById('metrics-summary');
  const historyPanel    = document.getElementById('history-panel');
  const historyList     = document.getElementById('history-list');
  const btnToggleHistory = document.getElementById('btn-toggle-history');
  const reportToc       = document.getElementById('report-toc');
  const reportTabs      = document.getElementById('report-tabs');
  const tabMarketBtn    = document.getElementById('tab-market-btn');
  const btnCopyReport   = document.getElementById('btn-copy-report');
  const btnCopyStock    = document.getElementById('btn-copy-stock');
  const btnCopyMarket   = document.getElementById('btn-copy-market');

  // =====================================================================
  // 内部状态
  // =====================================================================
  let lastTriggerTime  = 0;
  let pollTimer        = null;
  let isTriggering     = false;
  let elapsedTimer     = null;
  let progressRafId    = null;
  let currentProgress  = 0;
  let isResultReady    = false;
  /** 当前任务 ID（唯一关联键；也会写入 URL 便于刷新恢复） */
  let currentJobId     = '';
  let lastPhase        = '';
  let usePhaseProgress = false;
  let rawReportText    = '';
  let rawStockText     = '';
  let rawMarketText    = '';
  let lastActionsUrl   = '';
  let lastManifestUrl  = '';

  if (btnAnalyze) {
    btnAnalyze.addEventListener('click', handleAnalyze);
  }
  if (symbolInput) {
    symbolInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleAnalyze(); });
  }
  if (btnCopyReport) {
    btnCopyReport.addEventListener('click', () => copyText(rawReportText, btnCopyReport, '复制报告'));
  }
  if (btnCopyStock) {
    btnCopyStock.addEventListener('click', () => copyText(rawStockText, btnCopyStock, '复制个股分析'));
  }
  if (btnCopyMarket) {
    btnCopyMarket.addEventListener('click', () => copyText(rawMarketText, btnCopyMarket, '复制市场复盘'));
  }
  if (reportTabs) {
    reportTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      switchReportTab(btn.getAttribute('data-tab'));
    });
  }
  if (btnToggleAdvanced && advancedOptions) {
    btnToggleAdvanced.addEventListener('click', () => {
      const open = !advancedOptions.classList.contains('hidden');
      advancedOptions.classList.toggle('hidden', open);
      btnToggleAdvanced.textContent = open ? '高级选项' : '收起高级选项';
    });
  }
  if (btnToggleHistory && historyList) {
    btnToggleHistory.addEventListener('click', () => {
      const open = !historyList.classList.contains('hidden');
      historyList.classList.toggle('hidden', open);
      btnToggleHistory.textContent = open ? '展开' : '收起';
    });
  }
  if (btnResumeLast) {
    btnResumeLast.addEventListener('click', () => {
      const recent = loadRecentJobs();
      if (!recent.length) return;
      resumeJob(recent[0].jobId, recent[0].symbol || '');
    });
  }

  function copyText(text, btn, label) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      if (!btn) return;
      const orig = btn.innerHTML;
      btn.innerHTML = `<i class="fa-solid fa-check text-green-400"></i><span class="text-green-400">已复制</span>`;
      setTimeout(() => {
        btn.innerHTML = orig.includes(label)
          ? orig
          : `<i class="fa-regular fa-copy"></i><span>${label}</span>`;
      }, 2000);
    }).catch(() => {
      showInputHint('复制失败，请手动选择文本复制');
    });
  }

  function isValidSymbol(sym) {
    if (!sym) return false;
    return /^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(sym);
  }

  function isValidEmail(email) {
    if (!email) return true;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function normalizeSymbols(raw) {
    return String(raw || '')
      .trim()
      .toUpperCase()
      .replace(/[，、\s]+/g, ',')
      .split(',')
      .map(item => item.trim())
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
    const notificationEmail = notificationEmailInput
      ? notificationEmailInput.value.trim()
      : DEFAULT_ANALYSIS_OPTIONS.notificationEmail;
    return {
      ...DEFAULT_ANALYSIS_OPTIONS,
      mode: readSelectValue(modeSelect, ['full', 'market-only', 'stocks-only'], DEFAULT_ANALYSIS_OPTIONS.mode),
      reportType: readSelectValue(reportTypeSelect, ['brief', 'simple', 'full'], DEFAULT_ANALYSIS_OPTIONS.reportType),
      reportLanguage: readSelectValue(reportLanguageSelect, ['zh', 'en', 'ko'], DEFAULT_ANALYSIS_OPTIONS.reportLanguage),
      notificationChannels: notificationEmail ? ['email'] : [],
      notificationEmail,
      includeMarketContext: readCheckbox(optMarketContext, DEFAULT_ANALYSIS_OPTIONS.includeMarketContext),
      enableRealtimeQuote: readCheckbox(optRealtimeQuote, DEFAULT_ANALYSIS_OPTIONS.enableRealtimeQuote),
      enableRealtimeTechnicalIndicators: readCheckbox(optRealtimeTech, DEFAULT_ANALYSIS_OPTIONS.enableRealtimeTechnicalIndicators),
      enableChipDistribution: readCheckbox(optChipDist, DEFAULT_ANALYSIS_OPTIONS.enableChipDistribution),
      forceRun: readCheckbox(forceRunCheckbox, false),
    };
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
    btnAnalyze.disabled = (state !== 'idle');
    if (state === 'loading') {
      if (btnIcon)  btnIcon.className  = 'fa-solid fa-circle-notch fa-spin relative z-10';
      if (btnLabel) btnLabel.textContent = '分析中…';
      btnAnalyze.style.opacity = '0.65';
      btnAnalyze.style.cursor  = 'not-allowed';
    } else if (state === 'cooldown') {
      if (btnIcon)  btnIcon.className  = 'fa-solid fa-clock relative z-10 text-orange-300';
      if (btnLabel) btnLabel.textContent = sec ? `${sec}s` : '冷却中';
      btnAnalyze.style.opacity = '0.75';
      btnAnalyze.style.cursor  = 'not-allowed';
    } else {
      if (btnIcon)  btnIcon.className  = 'fa-solid fa-wand-magic-sparkles text-yellow-300 relative z-10';
      if (btnLabel) btnLabel.textContent = '生成 AI 分析报告';
      btnAnalyze.style.opacity = '';
      btnAnalyze.style.cursor  = '';
    }
  }

  function startCooldown() {
    lastTriggerTime = Date.now();
    const iv = setInterval(() => {
      const rem = Math.ceil((COOLDOWN_MS - (Date.now() - lastTriggerTime)) / 1000);
      if (rem <= 0) { clearInterval(iv); setBtnState('idle'); }
      else           { setBtnState('cooldown', rem); }
    }, 500);
  }

  // ---------- 任务恢复：URL + localStorage ----------

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
    const list = loadRecentJobs().filter((item) => item.jobId !== entry.jobId);
    list.unshift({
      jobId: entry.jobId,
      symbol: entry.symbol || '',
      status: entry.status || 'queued',
      requestedAt: entry.requestedAt || Date.now(),
    });
    try {
      localStorage.setItem(RECENT_JOBS_KEY, JSON.stringify(list.slice(0, RECENT_JOBS_MAX)));
    } catch (_) { /* 隐私模式等忽略 */ }
    updateResumeButton();
  }

  function updateResumeButton() {
    if (!btnResumeLast) return;
    const recent = loadRecentJobs();
    if (!recent.length) {
      btnResumeLast.style.display = 'none';
      return;
    }
    // 若 URL 已有当前任务，不必再提示「继续查看」
    const urlJob = new URLSearchParams(window.location.search).get('jobId');
    if (urlJob && recent[0].jobId === urlJob) {
      btnResumeLast.style.display = 'none';
      return;
    }
    btnResumeLast.style.display = '';
    btnResumeLast.textContent = `继续查看上次分析（${recent[0].symbol || '最近一次'}）`;
  }

  /** 把 jobId 写入地址栏，刷新后可继续轮询 / 查看结果 */
  function persistJobIdToUrl(jobId) {
    if (!jobId) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('jobId', jobId);
      window.history.replaceState({}, '', url.toString());
    } catch (_) { /* ignore */ }
  }

  function bootstrapFromUrlOrStorage() {
    updateResumeButton();
    const params = new URLSearchParams(window.location.search);
    const jobId = (params.get('jobId') || '').trim();
    if (jobId) {
      const recent = loadRecentJobs().find((item) => item.jobId === jobId);
      resumeJob(jobId, recent ? recent.symbol : '');
      return;
    }
  }

  function resumeJob(jobId, symbol) {
    if (!jobId) return;
    stopPolling();
    isResultReady = false;
    currentJobId = jobId;
    lastPhase = '';
    usePhaseProgress = false;
    persistJobIdToUrl(jobId);
    saveRecentJob({ jobId, symbol, status: 'queued' });

    buildSteps();
    showPanel();
    if (panelSymbol) panelSymbol.textContent = symbol || '分析中…';
    setBadge('running');
    setPanelIcon('spin');
    applyProgress(Math.max(currentProgress, 5));
    startElapsedTimer();
    activateStep(0);
    if (panelMessage) {
      panelMessage.innerHTML = `<span style="color:#93c5fd">已恢复分析进度，正在同步最新状态…</span>`;
    }
    setBtnState('loading');
    pollJobResult(jobId);
  }

  function showPanel() {
    if (!progressPanel) return;
    progressPanel.style.display = 'block';
    progressPanel.style.animation = 'none';
    void progressPanel.offsetHeight;
    progressPanel.style.animation = '';
  }

  function applyProgress(pct) {
    const v = Math.min(Math.max(pct, 0), 100).toFixed(1);
    if (progressFill) progressFill.style.width = v + '%';
    if (progressPct)  progressPct.textContent  = Math.round(pct) + '%';
  }

  function startVirtualProgress(from, to, durationMs) {
    if (progressRafId) cancelAnimationFrame(progressRafId);
    const start = performance.now();
    const delta = to - from;
    function tick(now) {
      if (isResultReady) return;
      const t     = Math.min((now - start) / durationMs, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      currentProgress = from + delta * eased;
      applyProgress(currentProgress);
      if (t < 1) progressRafId = requestAnimationFrame(tick);
    }
    progressRafId = requestAnimationFrame(tick);
  }

  function getStepStartPct(idx) {
    let elapsed = 0;
    for (let i = 0; i < idx; i++) elapsed += STEPS[i].duration;
    return (elapsed / TOTAL_DURATION) * 94;
  }
  function getStepEndPct(idx) { return getStepStartPct(idx + 1); }

  let startTime = 0;
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

  function setPanelIcon(type) {
    if (!panelIconEl || !panelIconWrap) return;
    const map = {
      spin:  { border: 'rgba(59,130,246,0.4)',  bg: 'rgba(59,130,246,0.1)',  color: '#60a5fa', cls: 'fa-solid fa-circle-notch fa-spin' },
      check: { border: 'rgba(34,197,94,0.4)',   bg: 'rgba(34,197,94,0.1)',   color: '#4ade80', cls: 'fa-solid fa-check'               },
      error: { border: 'rgba(239,68,68,0.4)',   bg: 'rgba(239,68,68,0.1)',   color: '#f87171', cls: 'fa-solid fa-triangle-exclamation' },
    };
    const cfg = map[type] || map.spin;
    panelIconWrap.style.borderColor = cfg.border;
    panelIconWrap.style.background  = cfg.bg;
    panelIconWrap.style.color       = cfg.color;
    panelIconEl.className           = cfg.cls;
  }

  function setBadge(state) {
    if (!panelBadge) return;
    const b = BADGES[state] || BADGES.running;
    panelBadge.textContent = b.text;
    panelBadge.className   = `px-2.5 py-1 rounded-full text-xs font-medium border ${b.cls}`;
  }

  function buildSteps() {
    if (!stepsContainer) return;
    stepsContainer.innerHTML = '';
    STEPS.forEach((step, i) => {
      const isLast = (i === STEPS.length - 1);
      const row = document.createElement('div');
      row.className = 'flex gap-3 items-start';
      row.id = `step-row-${step.id}`;
      row.innerHTML = `
        <div class="flex flex-col items-center" style="min-width:28px">
          <div class="relative w-7 h-7 rounded-full flex items-center justify-center text-xs border"
               id="step-icon-${step.id}"
               style="border-color:rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#4b6a8a;flex-shrink:0">
            <i class="fa-solid ${step.icon}"></i>
          </div>
          ${!isLast ? `<div style="width:1px;flex:1;margin:4px 0;background:rgba(255,255,255,0.08);min-height:16px;position:relative;overflow:hidden">
            <div id="step-conn-${step.id}" style="width:100%;position:absolute;top:0;height:0%;background:linear-gradient(to bottom,#3b82f6,#6366f1);transition:height 0.6s ease"></div>
          </div>` : ''}
        </div>
        <div style="${isLast ? '' : 'padding-bottom:12px'}; flex:1; min-width:0">
          <div style="display:flex;align-items:center;gap:6px">
            <span id="step-label-${step.id}" class="text-xs font-medium" style="color:#4b6a8a">${step.label}</span>
            <span id="step-time-${step.id}"  class="text-xs font-mono"   style="color:#3b82f6;display:none"></span>
          </div>
          <div id="step-desc-${step.id}" class="text-xs mt-1" style="color:#93c5fd;opacity:0.7;display:none;line-height:1.5">${step.desc}</div>
        </div>`;
      stepsContainer.appendChild(row);
    });
  }

  function activateStep(idx) {
    STEPS.forEach((s, i) => {
      const iconEl  = document.getElementById(`step-icon-${s.id}`);
      const labelEl = document.getElementById(`step-label-${s.id}`);
      const descEl  = document.getElementById(`step-desc-${s.id}`);
      const connEl  = document.getElementById(`step-conn-${s.id}`);
      if (!iconEl) return;

      if (i < idx) {
        iconEl.style.borderColor = '#22c55e';
        iconEl.style.background  = 'rgba(34,197,94,0.15)';
        iconEl.style.color       = '#22c55e';
        iconEl.innerHTML         = '<i class="fa-solid fa-check"></i>';
        if (connEl) connEl.style.height = '100%';
        if (labelEl) labelEl.style.color = '#86efac';
        if (descEl)  descEl.style.display = 'none';
      } else if (i === idx) {
        iconEl.style.borderColor = '#3b82f6';
        iconEl.style.background  = 'rgba(59,130,246,0.2)';
        iconEl.style.color       = '#93c5fd';
        iconEl.innerHTML         = `<span style="position:absolute;inset:-4px;border-radius:50%;border:2px solid #3b82f6;opacity:0;animation:pulseRing 1.6s ease-out infinite"></span><i class="fa-solid ${s.icon}"></i>`;
        if (labelEl) labelEl.style.color = '#dbeafe';
        if (descEl)  descEl.style.display = 'block';
        if (panelMessage) panelMessage.textContent = s.desc;
      } else {
        iconEl.style.borderColor = 'rgba(255,255,255,0.12)';
        iconEl.style.background  = 'rgba(255,255,255,0.04)';
        iconEl.style.color       = '#4b6a8a';
        iconEl.innerHTML         = `<i class="fa-solid ${s.icon}"></i>`;
        if (labelEl) labelEl.style.color = '#4b6a8a';
        if (descEl)  descEl.style.display = 'none';
      }
    });
  }

  function completeStep(idx, sec) {
    const step   = STEPS[idx];
    if (!step) return;
    const timeEl = document.getElementById(`step-time-${step.id}`);
    if (timeEl) { timeEl.textContent = `${sec.toFixed(1)}s`; timeEl.style.display = 'inline'; }
  }

  function markAllStepsDone() {
    STEPS.forEach((s) => {
      const iconEl  = document.getElementById(`step-icon-${s.id}`);
      const connEl  = document.getElementById(`step-conn-${s.id}`);
      const labelEl = document.getElementById(`step-label-${s.id}`);
      const descEl  = document.getElementById(`step-desc-${s.id}`);
      if (iconEl) {
        iconEl.style.borderColor = '#22c55e';
        iconEl.style.background  = 'rgba(34,197,94,0.15)';
        iconEl.style.color       = '#22c55e';
        iconEl.innerHTML         = '<i class="fa-solid fa-check"></i>';
      }
      if (connEl)  connEl.style.height  = '100%';
      if (labelEl) labelEl.style.color  = '#86efac';
      if (descEl)  descEl.style.display = 'none';
    });
  }

  /** 用云端写入的 phase 驱动步骤；缺省时保留虚拟进度 */
  function applyPhaseProgress(phase, phaseMessage) {
    if (!phase) return;
    const idx = PHASE_STEP_INDEX[phase];
    if (typeof idx !== 'number' || idx < 0) return;

    const phaseChanged = phase !== lastPhase;
    usePhaseProgress = true;
    lastPhase = phase;

    // 同 phase 只刷新文案；换 phase 时再推进步骤与进度条
    if (phaseChanged) {
      activateStep(idx);
      const from = Math.max(currentProgress, getStepStartPct(idx));
      const to = getStepEndPct(idx);
      if (to > from) {
        startVirtualProgress(from, to, Math.max(STEPS[idx].duration * 400, 2000));
      } else {
        applyProgress(to);
        currentProgress = to;
      }
    }

    const label = PHASE_LABELS[phase] || phase;
    if (panelMessage) {
      const msg = phaseMessage || `当前阶段：${label}`;
      panelMessage.innerHTML = `<span style="color:#93c5fd">${msg}</span>`;
    }
  }

  function handleAnalyze() {
    if (isTriggering) return;
    if (btnAnalyze && btnAnalyze.disabled) return;

    const raw = (symbolInput ? symbolInput.value.trim().toUpperCase() : '');
    const options = collectAnalysisOptions();
    const symbols = normalizeSymbols(raw);
    if (!symbols.length) { showInputHint('请输入股票代码（例如 00700.HK 或 AAPL）'); return; }
    if (!options.multiSymbols && symbols.length > 1) { showInputHint('当前不支持多股票，请只输入一个代码'); return; }
    if (!isValidEmail(options.notificationEmail)) { showInputHint('邮件地址格式不正确，请检查后重试'); return; }
    const invalidSymbol = symbols.find(sym => !isValidSymbol(sym));
    if (invalidSymbol) { showInputHint(`格式不合法：「${invalidSymbol}」，请使用如 00700.HK、AAPL`); return; }

    const normalizedSymbol = symbols.join(',');

    const elapsed = Date.now() - lastTriggerTime;
    if (elapsed < COOLDOWN_MS && lastTriggerTime > 0) {
      showInputHint(`请等待 ${Math.ceil((COOLDOWN_MS - elapsed) / 1000)}s 后再次触发`);
      return;
    }

    isTriggering = true;
    setBtnState('loading');

    startCloudWorkflow(normalizedSymbol, options).catch(err => {
      console.error('[quant] 工作流异常:', err);
      isTriggering = false;
      setBtnState('idle');
    });
  }

  function unwrapGatewayJson(rawResult, httpStatus) {
    let result = rawResult;
    if (rawResult && typeof rawResult === 'object' && ('body' in rawResult || 'statusCode' in rawResult)) {
      if (typeof rawResult.body === 'string') {
        try { result = JSON.parse(rawResult.body); } catch (_) { result = { message: rawResult.body }; }
      } else if (typeof rawResult.body === 'object' && rawResult.body !== null) {
        result = rawResult.body;
      }
    }
    const statusNum = (rawResult && typeof rawResult.statusCode === 'number')
      ? rawResult.statusCode
      : httpStatus;
    return { result, statusNum };
  }

  async function startCloudWorkflow(symbol, options) {
    stopPolling();
    if (progressRafId) { cancelAnimationFrame(progressRafId); progressRafId = null; }

    isResultReady = false;
    currentJobId = '';
    lastPhase = '';
    usePhaseProgress = false;
    lastActionsUrl = '';
    lastManifestUrl = '';
    rawReportText = '';
    rawStockText = '';
    rawMarketText = '';

    if (reportContainer) reportContainer.classList.add('hidden');
    if (emptyState) emptyState.style.display = 'flex';
    if (metricsSummary) {
      metricsSummary.classList.add('hidden');
      metricsSummary.innerHTML = '';
    }

    buildSteps();
    showPanel();
    if (panelSymbol) panelSymbol.textContent = symbol;
    setBadge('running');
    setPanelIcon('spin');
    applyProgress(0);
    currentProgress = 0;
    startElapsedTimer();

    activateStep(0);
    startVirtualProgress(0, getStepEndPct(0), STEPS[0].duration * 1000);

    const t0 = Date.now();
    const { forceRun, ...requestOptions } = options;

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
          forceRun: !!forceRun,
          ...requestOptions,
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
        if (result && result.code === 'PAT_NOT_CONFIGURED') {
          throw new Error(result.message || '分析服务暂未就绪，请稍后再试或联系站长');
        }
        throw new Error((result && result.message) || `创建分析任务失败（HTTP ${statusNum}）`);
      }

      if (!result.jobId) {
        throw new Error('未能创建分析任务，请稍后重试');
      }
      currentJobId = String(result.jobId);
      lastActionsUrl = result.actionsUrl || '';
      // URL 中的 jobId 是任务恢复入口
      persistJobIdToUrl(currentJobId);
      saveRecentJob({
        jobId: currentJobId,
        symbol,
        status: result.status || 'queued',
        requestedAt: result.requestedAt || Date.now(),
      });

      if (result.reused && panelMessage) {
        panelMessage.innerHTML = `<span style="color:#fbbf24">已复用近期同参数分析，直接同步进度…</span>`;
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
      if (panelMessage) {
        panelMessage.innerHTML = `<span style="color:#f87171">⚠ ${err.message || '网络错误，请检查连接后重试'}</span>`;
      }
      const iconEl = document.getElementById(`step-icon-${STEPS[0].id}`);
      if (iconEl) {
        iconEl.style.borderColor = 'rgba(239,68,68,0.5)';
        iconEl.style.background  = 'rgba(239,68,68,0.15)';
        iconEl.style.color       = '#f87171';
        iconEl.innerHTML         = '<i class="fa-solid fa-xmark"></i>';
      }
      return;
    }

    completeStep(0, (Date.now() - t0) / 1000);
    isTriggering = false;
    startCooldown();

    if (panelMessage) {
      panelMessage.innerHTML = `<span style="color:#93c5fd">分析任务已创建，正在等待 AI 研究结果…</span>`;
    }

    if (UNICLOUD_RESULT_URL && currentJobId) {
      pollJobResult(currentJobId);
    }

    // 无 phase 回传前，用虚拟步骤填充体验；一旦收到 phase 则由 applyPhaseProgress 接管
    runVirtualSteps(1);
  }

  async function runVirtualSteps(startIdx) {
    for (let i = startIdx; i < STEPS.length; i++) {
      if (isResultReady || usePhaseProgress) return;
      const to    = getStepEndPct(i);
      const durMs = STEPS[i].duration * 1000;
      activateStep(i);
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
      completeStep(i, (Date.now() - t0) / 1000);
    }

    if (!isResultReady) {
      activateStep(STEPS.length - 1);
      if (panelMessage) {
        panelMessage.innerHTML = `<span style="color:#93c5fd">⏳ 分析仍在进行，请保持页面开启；也可稍后返回继续查看…</span>`;
      }
    }
  }

  function finishWorkflowSuccess(data) {
    if (isResultReady) return;
    isResultReady = true;
    stopPolling();
    if (progressRafId) { cancelAnimationFrame(progressRafId); progressRafId = null; }

    lastActionsUrl = data.actionsUrl || lastActionsUrl;
    lastManifestUrl = data.manifestUrl || (data.resultFiles && data.resultFiles.manifestUrl) || lastManifestUrl;
    saveRecentJob({
      jobId: data.jobId || currentJobId,
      symbol: data.symbol || (panelSymbol && panelSymbol.textContent) || '',
      status: 'succeeded',
      requestedAt: data.requestedAt || Date.now(),
    });

    const startVal = currentProgress;
    const startT   = performance.now();
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
        setBtnState('idle');
        renderReport(data);

        if (panelMessage) {
          const src = SOURCE_LABELS[data.source] || data.source || '';
          const partial = data.errorCode === 'PARTIAL_RESULT'
            ? ' <span style="color:#fbbf24">（部分结果）</span>'
            : '';
          panelMessage.innerHTML = `<span style="color:#4ade80;font-weight:500">AI 投研报告已就绪！</span>${partial}`
            + ` <span style="color:#93c5fd;opacity:0.9">来源：${src || '云端'}，已在下方展示。</span>`;
        }
      }
    }
    requestAnimationFrame(rushTick);
  }

  function finishWorkflowFailure(data) {
    if (isResultReady) return;
    isResultReady = true;
    stopPolling();
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
    if (panelMessage) {
      panelMessage.innerHTML = `<span style="color:#f87171">⚠ ${errMsg}</span>`
        + `<br><span style="color:#93c5fd;opacity:0.8;font-size:0.8rem">分析服务繁忙或任务异常，请稍后重试；也可返回本页继续查看。</span>`;
    }
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

  /**
   * 按 jobId 轮询任务状态（唯一读取路径）
   * @param {string} jobId
   */
  function pollJobResult(jobId) {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    const pollStartedAt = Date.now();

    async function tick() {
      if (isResultReady) return;
      if (jobId !== currentJobId) return;

      if (Date.now() >= deadline) {
        stopPolling();
        if (!isResultReady) {
          stopElapsedTimer();
          setPanelIcon('error');
          setBadge('error');
          setBtnState('idle');
          if (panelMessage) {
            panelMessage.innerHTML = `<span style="color:#fb923c">⏱ 等待超时。任务可能仍在运行，可稍后返回本页继续查看。</span>`
              + ` <button id="btn-re-check" style="margin-left:8px;padding:2px 8px;background:rgba(59,130,246,0.2);border:1px solid #3b82f6;color:#93c5fd;border-radius:4px;cursor:pointer;font-size:0.75rem">手动重新拉取结果</button>`;
            const reCheckBtn = document.getElementById('btn-re-check');
            if (reCheckBtn) {
              reCheckBtn.onclick = () => {
                isResultReady = false;
                setBadge('running');
                setPanelIcon('spin');
                setBtnState('loading');
                startElapsedTimer();
                pollJobResult(jobId);
              };
            }
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

            if (data.phase) {
              applyPhaseProgress(data.phase, data.phaseMessage || '');
            }

            if (status === 'succeeded' && data.ready) {
              finishWorkflowSuccess(data);
              return;
            }
            if (status === 'failed' || status === 'timeout') {
              finishWorkflowFailure(data);
              return;
            }

            if (panelMessage && (status === 'queued' || status === 'running') && !data.phase) {
              const label = STATUS_LABELS[status] || status;
              panelMessage.innerHTML = `<span style="color:#93c5fd">当前状态：${label}，正在同步分析进度…</span>`;
            }
          }
        } else if (res.status === 404) {
          finishWorkflowFailure({ status: 'failed', error: '任务不存在或已被清理', errorCode: 'NOT_FOUND' });
          return;
        }
      } catch (_) { /* 网络抖动静默重试 */ }

      if (isResultReady) return;
      const wait = nextPollInterval(Date.now() - pollStartedAt);
      pollTimer = setTimeout(tick, wait);
    }

    tick();
  }

  function sanitizeHtml(html) {
    if (typeof DOMPurify !== 'undefined' && DOMPurify.sanitize) {
      return DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ['id'],
      });
    }
    return String(html)
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
      .replace(/javascript:/gi, '');
  }

  function parseMd(text) {
    if (!text) return '';
    let html;
    if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
      html = marked.parse(text);
    } else {
      html = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    return sanitizeHtml(html);
  }

  function formatTime(ts) {
    const n = Number(ts);
    if (!n) return '';
    try {
      return new Date(n).toLocaleString('zh-CN', { hour12: false });
    } catch (_) {
      return String(n);
    }
  }

  function slugify(text) {
    return String(text || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\w\u4e00-\u9fff-]/g, '')
      .slice(0, 48) || 'section';
  }

  function switchReportTab(tab) {
    if (!reportTabs) return;
    reportTabs.querySelectorAll('button[data-tab]').forEach((btn) => {
      btn.setAttribute('aria-selected', btn.getAttribute('data-tab') === tab ? 'true' : 'false');
    });
    if (sectionStockReport) {
      sectionStockReport.style.display = tab === 'stock' ? 'block' : 'none';
    }
    if (sectionMarketReview && !sectionMarketReview.classList.contains('hidden')) {
      sectionMarketReview.style.display = tab === 'market' ? 'block' : 'none';
    }
  }

  function escapeText(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderMetricsSummary(metrics) {
    if (!metricsSummary) return;
    if (!metrics || typeof metrics !== 'object') {
      metricsSummary.classList.add('hidden');
      metricsSummary.innerHTML = '';
      return;
    }

    const cards = [
      { label: '综合观点', value: metrics.rating },
      { label: '风险等级', value: metrics.riskLevel },
      { label: '趋势判断', value: metrics.trend },
      {
        label: '置信度（参考）',
        value: metrics.confidence != null ? String(metrics.confidence) : '',
      },
      {
        label: '关键支撑',
        value: Array.isArray(metrics.supportLevels) ? metrics.supportLevels.join(', ') : metrics.supportLevels,
      },
      {
        label: '关键压力',
        value: Array.isArray(metrics.resistanceLevels) ? metrics.resistanceLevels.join(', ') : metrics.resistanceLevels,
      },
      { label: '数据时间', value: metrics.dataAsOf ? formatTime(metrics.dataAsOf) || String(metrics.dataAsOf) : '' },
      {
        label: '实时增强',
        value: metrics.realtimeEnabled === true ? '开' : (metrics.realtimeEnabled === false ? '关' : ''),
      },
    ].filter((c) => c.value !== '' && c.value != null);

    if (!cards.length) {
      metricsSummary.classList.add('hidden');
      metricsSummary.innerHTML = '';
      return;
    }

    metricsSummary.innerHTML = cards.map((c) => `
      <div class="bg-white/5 border border-white/10 rounded-lg px-3 py-2">
        <div class="text-[10px] text-blue-300/60 mb-0.5">${escapeText(c.label)}</div>
        <div class="text-sm text-white font-medium truncate">${escapeText(c.value)}</div>
      </div>`).join('');
    metricsSummary.classList.remove('hidden');
  }

  async function loadSymbolHistory(symbol) {
    if (!historyPanel || !historyList || !symbol) {
      if (historyPanel) historyPanel.classList.add('hidden');
      return;
    }
    // 多代码时取第一个做历史索引
    const primary = String(symbol).split(',')[0].trim().toUpperCase();
    if (!primary) {
      historyPanel.classList.add('hidden');
      return;
    }

    try {
      const url = `${HISTORY_RAW_BASE}/${encodeURIComponent(primary)}/history.json?t=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        historyPanel.classList.add('hidden');
        return;
      }
      const data = await res.json();
      const items = Array.isArray(data)
        ? data
        : (Array.isArray(data.jobs) ? data.jobs : (Array.isArray(data.history) ? data.history : []));
      if (!items.length) {
        historyPanel.classList.add('hidden');
        return;
      }

      historyList.innerHTML = '';
      items.slice(0, 10).forEach((item) => {
        const jobId = item.jobId || item.id || '';
        if (!jobId) return;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'w-full text-left px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-white/5 cursor-pointer';
        const when = formatTime(item.generatedAt || item.requestedAt) || '';
        const rating = item.rating || item.riskLevel || '';
        const title = when || '历史分析';
        row.innerHTML = `<span class="text-sky-300">${escapeText(primary)}</span>`
          + (when ? ` · ${escapeText(when)}` : '')
          + (rating ? ` · ${escapeText(rating)}` : '')
          + (!when && !rating ? ` · ${escapeText(title)}` : '');
        row.addEventListener('click', () => resumeJob(jobId, primary));
        historyList.appendChild(row);
      });
      historyPanel.classList.remove('hidden');
      historyList.classList.add('hidden');
      if (btnToggleHistory) btnToggleHistory.textContent = '展开';
    } catch (_) {
      historyPanel.classList.add('hidden');
    }
  }

  function renderReport(data) {
    if (!data) return;
    const symbol = (data.symbol || (panelSymbol ? panelSymbol.textContent : '') || '').toUpperCase();
    if (panelSymbol && symbol) panelSymbol.textContent = symbol;

    const reportMd = (data.report || '').trim();
    const marketMd = (data.marketReview || '').trim();

    const stockText = reportMd || (data.message || '').trim() || `# 股票 [${symbol}] AI 投研分析已完成\n\n暂无个股分析正文。`;
    rawStockText = stockText;
    rawMarketText = marketMd;
    const parts = [`# 个股分析报告 · ${symbol}\n\n${stockText}`];
    if (marketMd) parts.push(`# 市场复盘\n\n${marketMd}`);
    rawReportText = parts.join('\n\n---\n\n');

    if (reportTitle) {
      reportTitle.textContent = `AI 投研报告 · ${symbol}`;
    }

    renderMetricsSummary(data.metrics);

    if (reportMeta) {
      const srcLabel = SOURCE_LABELS[data.source] || data.source || '云端';
      if (metaSource) metaSource.textContent = `来源：${srcLabel}`;
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
          ? `部分能力已降级：${degraded.join(', ')}`
          : '';
      }
      reportMeta.classList.remove('hidden');
    }

    if (reportContent) {
      reportContent.innerHTML = parseMd(stockText);
    }

    const hasMarket = !!marketMd;
    if (sectionMarketReview && marketReviewContent) {
      if (hasMarket) {
        marketReviewContent.innerHTML = parseMd(marketMd);
        sectionMarketReview.classList.remove('hidden');
        sectionMarketReview.style.display = '';
      } else {
        marketReviewContent.innerHTML = '';
        sectionMarketReview.classList.add('hidden');
      }
    }

    if (reportLayout) {
      reportLayout.classList.toggle('has-market', hasMarket);
    }
    if (tabMarketBtn) {
      tabMarketBtn.classList.toggle('hidden', !hasMarket);
    }
    if (btnCopyMarket) {
      btnCopyMarket.classList.toggle('hidden', !hasMarket);
    }

    buildTocFromCombined();
    switchReportTab('stock');
    loadSymbolHistory(symbol);

    if (emptyState)      emptyState.style.display = 'none';
    if (reportContainer) reportContainer.classList.remove('hidden');
  }

  function buildTocFromCombined() {
    if (!reportToc) return;
    const nodes = [];
    if (reportContent) {
      reportContent.querySelectorAll('h1, h2').forEach((el) => nodes.push(el));
    }
    if (marketReviewContent && sectionMarketReview && !sectionMarketReview.classList.contains('hidden')) {
      marketReviewContent.querySelectorAll('h1, h2').forEach((el) => nodes.push(el));
    }
    if (!nodes.length) {
      reportToc.classList.add('hidden');
      reportToc.innerHTML = '';
      return;
    }

    const frag = document.createDocumentFragment();
    const used = new Set();
    nodes.forEach((el, idx) => {
      let id = el.id || slugify(el.textContent) || `h-${idx}`;
      const base = id;
      let n = 1;
      while (used.has(id) || (document.getElementById(id) && document.getElementById(id) !== el)) {
        id = `${base}-${n++}`;
      }
      used.add(id);
      el.id = id;

      const a = document.createElement('a');
      a.href = `#${id}`;
      a.textContent = el.textContent;
      if (el.tagName === 'H2') a.classList.add('toc-h2');
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const inMarket = marketReviewContent && marketReviewContent.contains(el);
        if (inMarket) switchReportTab('market');
        else switchReportTab('stock');
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      frag.appendChild(a);
    });

    reportToc.innerHTML = '';
    reportToc.appendChild(frag);
    reportToc.classList.remove('hidden');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 页面加载：URL 中的 jobId 是任务恢复入口（须在全部函数/常量就绪后调用）
  bootstrapFromUrlOrStorage();

});
