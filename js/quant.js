/**
 * AI 量化投研分析控制脚本 (quant.js) v7.8
 *
 * 单链路（只认 jobId，内部实现细节不对用户展示）：
 *   浏览器 → trigger-stock-analysis → 返回 jobId
 *         → 云端分析流水线
 *         → jobs/{jobId}/*.md + manifest.json + metrics.json
 *         → 前端 GET get-stock-result?jobId= → 消毒渲染
 *
 * v7.8：历史分析改为本机分析流水（localStorage），不依赖输入股票代码。
 * v7.7：历史分析独立入口；按标的拉取 history.json；点击回看对应报告。
 * v7.6：去掉摘要卡与左侧目录；按股票拆 Tab + 市场复盘 Tab；大气 Tab 样式。
 */

document.addEventListener('DOMContentLoaded', () => {

  // =====================================================================
  // 接口与轮询配置
  // =====================================================================
  const UNICLOUD_TRIGGER_URL = 'https://f.nhm.net.cn/trigger-stock-analysis';
  const UNICLOUD_RESULT_URL  = 'https://f.nhm.net.cn/get-stock-result';
  // 历史回看兜底：云函数不可达时直接读已发布的 jobs/{jobId}
  const JOBS_RAW_BASE =
    'https://raw.githubusercontent.com/king08723/mhm_net_cn/analysis-results/jobs';

  const COOLDOWN_MS            = 60 * 1000;
  const POLL_INTERVAL_INITIAL = 3000;
  const POLL_INTERVAL_MAX     = 15000;
  const POLL_FAST_WINDOW_MS   = 2 * 60 * 1000;
  const POLL_DEADLINE_MS      = 15 * 60 * 1000;
  // 本机分析流水（每次触发/完成写入；报告就绪后展示）
  const RECENT_JOBS_KEY       = 'quant_recent_jobs_v1';
  const RECENT_JOBS_MAX       = 20;

  const DEFAULT_ANALYSIS_OPTIONS = {
    mode: 'stocks-only',
    reportType: 'simple',
    reportLanguage: 'zh',
    notificationChannels: [],
    notificationEmail: '', // 前端已不收集邮件；保留字段兼容云函数
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

  // 尚无云端 phase 时：预估进度推进到「大模型综合研判」并缓行，不越过「生成研究报告」
  // 索引 4 = compute/analyze；上限落在该步中段，避免卡在「初始化分析环境」
  const VIRTUAL_HOLD_STEP_INDEX = 4;
  const VIRTUAL_PROGRESS_CAP = 68;

  // 预估模式下前序步骤加速（秒），尽快进入研判等待态；研判步用更长缓行
  const VIRTUAL_STEP_SECONDS = [3, 6, 10, 12, 150, 20];

  // 停在「大模型综合研判」时轮播的等待文案（真实 analyze 阶段也会用）
  const ANALYZE_SIM_MESSAGES = [
    '正在梳理技术指标与量价关系…',
    '正在结合行业与市场环境交叉验证…',
    '大模型正在生成多空观点与风险提示…',
    '正在校准置信度与关键支撑/压力位…',
    '正在汇总研判结论，请稍候…',
  ];

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

  // 各阶段典型耗时（秒）与剩余预估文案，配合云端 phaseMessage 使用
  const PHASE_ETA = {
    queued:   { typical: '约 10–30 秒', remainMin: 4, remainMax: 8 },
    checkout: { typical: '约 15–30 秒', remainMin: 4, remainMax: 7 },
    setup:    { typical: '约 30–60 秒', remainMin: 3, remainMax: 6 },
    fetch:    { typical: '约 30–90 秒', remainMin: 3, remainMax: 6 },
    analyze:  { typical: '约 2–5 分钟', remainMin: 2, remainMax: 5 },
    publish:  { typical: '约 20–40 秒', remainMin: 0, remainMax: 1 },
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
  const forceRunCheckbox = document.getElementById('force-run-checkbox');
  const optMarketContext = document.getElementById('opt-market-context');
  const optRealtimeQuote = document.getElementById('opt-realtime-quote');
  const optRealtimeTech = document.getElementById('opt-realtime-tech');
  const optChipDist = document.getElementById('opt-chip-dist');
  const btnToggleAdvanced = document.getElementById('btn-toggle-advanced');
  const advancedOptions = document.getElementById('advanced-options');
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
  const progressLabel   = document.getElementById('progress-label');
  const panelPhaseSource = document.getElementById('panel-phase-source');
  const panelDebugInfo  = document.getElementById('panel-debug-info');
  const stepsContainer  = document.getElementById('steps-container');
  const emptyState      = document.getElementById('empty-state');
  const inputHint       = document.getElementById('input-hint');
  const reportContainer = document.getElementById('report-container');
  const reportTitle     = document.getElementById('report-title');
  const reportTabs      = document.getElementById('report-tabs');
  const reportPanels    = document.getElementById('report-panels');
  const reportMeta      = document.getElementById('report-meta');
  const metaGenerated   = document.getElementById('meta-generated');
  const metaRunId       = document.getElementById('meta-runid');
  const metaDegraded    = document.getElementById('meta-degraded');
  const historyPanel    = document.getElementById('history-panel');
  const historyList     = document.getElementById('history-list');
  const historySymbolEl = document.getElementById('history-symbol');
  const historyCountEl  = document.getElementById('history-count');
  const historyEmptyEl  = document.getElementById('history-empty');
  const btnToggleHistory = document.getElementById('btn-toggle-history');

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
  let lastPhaseSource  = 'simulated';
  let lastActionsUrl   = '';
  let lastManifestUrl  = '';
  let lastRunId        = '';
  let lastUpdatedAt    = 0;
  /** 研判阶段等待文案轮播定时器 */
  let analyzeSimTimer  = null;
  let analyzeSimIndex  = 0;

  /** 是否开启诊断模式（URL ?debug=1） */
  function isDebugMode() {
    try {
      return new URLSearchParams(window.location.search).get('debug') === '1';
    } catch (_) {
      return false;
    }
  }

  /** 仅 GitHub manifest 阶段才算「真实进度」 */
  function isRealPhaseSource(phaseSource, source) {
    if (phaseSource === 'github-manifest') return true;
    // 兼容旧云函数：source=github-job 且未带 phaseSource
    if (!phaseSource && source === 'github-job') return true;
    return false;
  }

  function setPhaseSourceHint(phaseSource) {
    // 仅内部状态；不对用户展示「来源 / 模拟 / 底层仓库」等字样
    lastPhaseSource = phaseSource || 'simulated';
    if (panelPhaseSource) {
      panelPhaseSource.textContent = '';
      panelPhaseSource.classList.add('hidden');
    }
  }

  /** debug 文案脱敏：不暴露 github / 虚拟 等实现细节 */
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

  if (btnAnalyze) {
    btnAnalyze.addEventListener('click', handleAnalyze);
  }
  if (symbolInput) {
    symbolInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleAnalyze(); });
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
      setHistoryExpanded(!open);
    });
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
    return {
      ...DEFAULT_ANALYSIS_OPTIONS,
      mode: readSelectValue(modeSelect, ['full', 'market-only', 'stocks-only'], DEFAULT_ANALYSIS_OPTIONS.mode),
      reportType: readSelectValue(reportTypeSelect, ['brief', 'simple', 'full'], DEFAULT_ANALYSIS_OPTIONS.reportType),
      reportLanguage: readSelectValue(reportLanguageSelect, ['zh', 'en', 'ko'], DEFAULT_ANALYSIS_OPTIONS.reportLanguage),
      // 页面已去掉邮件输入，始终不附加邮件通知
      notificationChannels: [],
      notificationEmail: '',
      includeMarketContext: readCheckbox(optMarketContext, DEFAULT_ANALYSIS_OPTIONS.includeMarketContext),
      enableRealtimeQuote: readCheckbox(optRealtimeQuote, DEFAULT_ANALYSIS_OPTIONS.enableRealtimeQuote),
      enableRealtimeTechnicalIndicators: readCheckbox(optRealtimeTech, DEFAULT_ANALYSIS_OPTIONS.enableRealtimeTechnicalIndicators),
      enableChipDistribution: readCheckbox(optChipDist, DEFAULT_ANALYSIS_OPTIONS.enableChipDistribution),
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
    const prev = loadRecentJobs().find((item) => item.jobId === entry.jobId) || {};
    const list = loadRecentJobs().filter((item) => item.jobId !== entry.jobId);
    // 合并更新，保留此前已写入的摘要字段
    list.unshift({
      jobId: entry.jobId,
      symbol: entry.symbol || prev.symbol || '',
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
    } catch (_) { /* 隐私模式等忽略 */ }
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
    stopAnalyzeSimMessages();
    isResultReady = false;
    currentJobId = jobId;
    lastPhase = '';
    usePhaseProgress = false;
    lastPhaseSource = 'simulated';
    lastRunId = '';
    lastUpdatedAt = 0;
    persistJobIdToUrl(jobId);
    saveRecentJob({ jobId, symbol, status: 'queued' });

    buildSteps();
    showPanel();
    if (panelSymbol) panelSymbol.textContent = symbol || '分析中…';
    setBadge('running');
    setPanelIcon('spin');
    setPhaseSourceHint('simulated');
    updateDebugInfo({ source: '' });
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
    // 弱化精确百分比误导：真实阶段时显示阶段名+耗时；模拟时显示约数；完成显示 100%
    if (progressPct) {
      if (pct >= 99.5) {
        progressPct.textContent = '100%';
      } else if (usePhaseProgress && lastPhase) {
        const label = PHASE_LABELS[lastPhase] || lastPhase;
        const tip = (PHASE_ETA[lastPhase] && PHASE_ETA[lastPhase].typical) || '';
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
    // 无真实 phase 时，虚拟进度不得超过上限
    const cappedTo = usePhaseProgress ? to : Math.min(to, VIRTUAL_PROGRESS_CAP);
    const start = performance.now();
    const delta = cappedTo - from;
    if (delta <= 0) {
      applyProgress(from);
      return;
    }
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

  /** 格式化「预计还需」文案 */
  function formatRemainHint(phase) {
    const eta = PHASE_ETA[phase];
    if (!eta) return '';
    if (eta.remainMax <= 0) return '即将完成';
    if (eta.remainMin === eta.remainMax) return `预计还需约 ${eta.remainMin} 分钟`;
    return `预计还需约 ${eta.remainMin}–${eta.remainMax} 分钟`;
  }

  /** 停止研判阶段的模拟文案轮播 */
  function stopAnalyzeSimMessages() {
    if (analyzeSimTimer) {
      clearInterval(analyzeSimTimer);
      analyzeSimTimer = null;
    }
  }

  /**
   * 在「大模型综合研判」停留时轮播模拟文案，提升等待感知
   * @param {string} [baseMessage] 可选基础句（真实 phaseMessage 优先作前缀）
   */
  function startAnalyzeSimMessages(baseMessage) {
    stopAnalyzeSimMessages();
    analyzeSimIndex = 0;
    const remain = formatRemainHint('analyze');
    const remainHtml = remain
      ? ` <span style="color:#7dd3fc;opacity:0.95">· ${remain}</span>`
      : '';

    const paint = () => {
      if (isResultReady) {
        stopAnalyzeSimMessages();
        return;
      }
      // 真实阶段已离开 analyze，停止轮播
      if (usePhaseProgress && lastPhase && lastPhase !== 'analyze') {
        stopAnalyzeSimMessages();
        return;
      }
      const sim = ANALYZE_SIM_MESSAGES[analyzeSimIndex % ANALYZE_SIM_MESSAGES.length];
      analyzeSimIndex += 1;
      if (!panelMessage) return;
      const head = (baseMessage && String(baseMessage).trim())
        ? String(baseMessage).trim()
        : STEPS[VIRTUAL_HOLD_STEP_INDEX].desc;
      panelMessage.innerHTML =
        `<span style="color:#93c5fd">${head}</span>`
        + `<br><span style="color:#7dd3fc;opacity:0.9">${sim}</span>${remainHtml}`;
    };

    paint();
    analyzeSimTimer = setInterval(paint, 8000);
  }

  /**
   * 用云端写入的 phase 驱动步骤；仅 github-manifest 才调用本函数。
   * 早期阶段（setup/fetch）只同步、不掐断虚拟推进；研判及之后才完全接管。
   */
  function applyPhaseProgress(phase, phaseMessage) {
    if (!phase) return;
    const idx = PHASE_STEP_INDEX[phase];
    if (typeof idx !== 'number' || idx < 0) return;

    const phaseChanged = phase !== lastPhase;
    lastPhase = phase;
    setPhaseSourceHint('github-manifest');

    // 尚未到「大模型综合研判」：跟上真实阶段，但允许虚拟进度继续往研判走
    if (idx < VIRTUAL_HOLD_STEP_INDEX) {
      // 虚拟已走到研判（或更前的更高进度）时，勿被迟到的早期 phase 打回
      const alreadyPast = currentProgress >= getStepStartPct(VIRTUAL_HOLD_STEP_INDEX) - 0.5
        || !!analyzeSimTimer;
      if (!alreadyPast && phaseChanged) {
        activateStep(idx);
        const from = Math.max(currentProgress, getStepStartPct(idx));
        // 早期真实阶段不超过研判步起点，留给虚拟缓行
        const to = Math.min(getStepEndPct(idx), getStepStartPct(VIRTUAL_HOLD_STEP_INDEX));
        const durSec = VIRTUAL_STEP_SECONDS[idx] != null
          ? VIRTUAL_STEP_SECONDS[idx]
          : ((STEPS[idx] && STEPS[idx].duration) || 15);
        if (to > from) {
          startVirtualProgress(from, to, Math.max(durSec * 600, 1500));
        }
      }
      // 前序步骤未进入研判模拟时，展示云端文案；已在研判模拟则不打断
      if (panelMessage && !analyzeSimTimer && !alreadyPast) {
        const label = PHASE_LABELS[phase] || phase;
        let msg = (phaseMessage || `当前阶段：${label}`).trim();
        const eta = PHASE_ETA[phase];
        if (eta && eta.typical && !msg.includes('通常') && !msg.includes('约')) {
          msg += `（${eta.typical}）`;
        }
        panelMessage.innerHTML = `<span style="color:#93c5fd">${msg}</span>`;
      }
      return;
    }

    // 研判及之后：完全接管，停止虚拟兜底
    usePhaseProgress = true;

    if (phaseChanged) {
      activateStep(idx);
      if (phase !== 'analyze') stopAnalyzeSimMessages();
      const from = Math.max(currentProgress, getStepStartPct(idx));
      const to = getStepEndPct(idx);
      const durSec = (STEPS[idx] && STEPS[idx].duration) || 30;
      if (to > from) {
        startVirtualProgress(from, to, Math.max(durSec * 800, 3000));
      } else {
        applyProgress(to);
        currentProgress = to;
      }
    }

    const label = PHASE_LABELS[phase] || phase;
    const eta = PHASE_ETA[phase];
    const remain = formatRemainHint(phase);

    // 研判阶段：进入时开启模拟文案轮播（同 phase 轮询不重置）
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
      const remainHtml = remain
        ? ` <span style="color:#7dd3fc;opacity:0.95">· ${remain}</span>`
        : '';
      panelMessage.innerHTML = `<span style="color:#93c5fd">${msg}</span>${remainHtml}`;
    }
    if (progressPct && usePhaseProgress && phase !== 'succeeded') {
      const tip = eta && eta.typical ? eta.typical : '';
      progressPct.textContent = tip ? `${label} · ${tip}` : label;
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

    buildSteps();
    showPanel();
    if (panelSymbol) panelSymbol.textContent = symbol;
    setBadge('running');
    setPanelIcon('spin');
    setPhaseSourceHint('simulated');
    updateDebugInfo({ source: '' });
    applyProgress(0);
    currentProgress = 0;
    startElapsedTimer();

    activateStep(0);
    // 触发阶段加速完成；后续虚拟步骤推进到「大模型综合研判」后缓行
    const firstDurMs = (VIRTUAL_STEP_SECONDS[0] != null ? VIRTUAL_STEP_SECONDS[0] : STEPS[0].duration) * 1000;
    startVirtualProgress(0, Math.min(getStepEndPct(0), VIRTUAL_PROGRESS_CAP), firstDurMs);

    const t0 = Date.now();
    // 「重新分析」控制云函数去重；交易日检查由云函数 dispatch 时始终 force_run=true
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
      panelMessage.innerHTML = `<span style="color:#93c5fd">分析任务已创建，正在等待云端开始同步状态…</span>`;
    }
    setPhaseSourceHint('simulated');
    updateDebugInfo({ source: 'pending' });

    if (UNICLOUD_RESULT_URL && currentJobId) {
      pollJobResult(currentJobId);
    }

    // 无真实 github-manifest 前，用受限虚拟步骤填充体验
    runVirtualSteps(1);
  }

  async function runVirtualSteps(startIdx) {
    const holdIdx = VIRTUAL_HOLD_STEP_INDEX;

    for (let i = startIdx; i <= holdIdx; i++) {
      if (isResultReady || usePhaseProgress) return;

      // 已到上限：保持停在「大模型综合研判」，并开启模拟文案
      if (currentProgress >= VIRTUAL_PROGRESS_CAP - 0.5) {
        activateStep(holdIdx);
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
        ? VIRTUAL_PROGRESS_CAP
        : Math.min(getStepEndPct(i), VIRTUAL_PROGRESS_CAP);
      // 前序加速进入研判；研判步用加长缓行
      const durSec = VIRTUAL_STEP_SECONDS[i] != null
        ? VIRTUAL_STEP_SECONDS[i]
        : STEPS[i].duration;
      const durMs = Math.max(durSec * 1000, isHold ? 8000 : 2000);

      activateStep(i);
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

      if (!isHold) {
        completeStep(i, (Date.now() - t0) / 1000);
      }
    }

    // 缓行结束后仍无真实 phase：继续停在研判步并轮播
    if (!isResultReady && !usePhaseProgress) {
      activateStep(holdIdx);
      applyProgress(VIRTUAL_PROGRESS_CAP);
      currentProgress = VIRTUAL_PROGRESS_CAP;
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
        status: 'succeeded',
        requestedAt: data.requestedAt || Date.now(),
        generatedAt: data.generatedAt || Date.now(),
        rating: m.rating || '',
        riskLevel: m.riskLevel || '',
        trend: m.trend || '',
        confidence: m.confidence,
      });
    }

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
        setPhaseSourceHint(data.phaseSource === 'db-cache' ? 'db-cache' : 'github-manifest');
        updateDebugInfo({ source: data.source || '' });
        setBtnState('idle');
        renderReport(data);

        if (panelMessage) {
          const partial = data.errorCode === 'PARTIAL_RESULT'
            ? ' <span style="color:#fbbf24">（部分结果）</span>'
            : '';
          panelMessage.innerHTML = `<span style="color:#4ade80;font-weight:500">AI 投研报告已就绪！</span>${partial}`
            + ` <span style="color:#93c5fd;opacity:0.9">已在下方展示。</span>`;
        }
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
   * 历史回看兜底：云函数不可达时，直接读已发布的 jobs/{jobId} 终态产物。
   * 仅处理 succeeded / failed；进行中任务仍走云函数轮询。
   */
  async function fetchJobFromGithubRaw(jobId) {
    if (!jobId) return null;
    const base = `${JOBS_RAW_BASE}/${encodeURIComponent(jobId)}`;
    const stamp = Date.now();
    try {
      const manifestRes = await fetch(`${base}/manifest.json?t=${stamp}`, { cache: 'no-store' });
      if (!manifestRes.ok) return null;
      const manifest = await manifestRes.json();
      if (!manifest || typeof manifest !== 'object') return null;

      const status = manifest.status || manifest.phase || '';
      lastManifestUrl = `${base}/manifest.json`;
      if (manifest.runId) lastRunId = String(manifest.runId);
      if (manifest.updatedAt) lastUpdatedAt = Number(manifest.updatedAt) || 0;

      if (status === 'failed' || status === 'timeout') {
        return {
          success: true,
          ready: false,
          status,
          jobId: manifest.jobId || jobId,
          symbol: manifest.symbol || '',
          error: manifest.error || '分析失败',
          errorCode: manifest.errorCode || 'ANALYSIS_FAILED',
          phase: manifest.phase || status,
          phaseMessage: manifest.phaseMessage || '',
          phaseSource: 'github-manifest',
          source: 'github-job',
          generatedAt: manifest.generatedAt || manifest.finishedAt || 0,
          manifestUrl: lastManifestUrl,
        };
      }

      if (status !== 'succeeded') return null;

      const [reportRes, metricsRes, marketRes] = await Promise.all([
        fetch(`${base}/report.md?t=${stamp}`, { cache: 'no-store' }),
        manifest.hasMetrics === false
          ? Promise.resolve(null)
          : fetch(`${base}/metrics.json?t=${stamp}`, { cache: 'no-store' }),
        (manifest.marketReviewLength > 0 || manifest.marketReviewSha)
          ? fetch(`${base}/market_review.md?t=${stamp}`, { cache: 'no-store' })
          : Promise.resolve(null),
      ]);

      const report = reportRes && reportRes.ok ? await reportRes.text() : '';
      if (!report.trim()) return null;

      let metrics = null;
      if (metricsRes && metricsRes.ok) {
        try { metrics = await metricsRes.json(); } catch (_) { metrics = null; }
      }
      const marketReview = marketRes && marketRes.ok ? await marketRes.text() : '';

      return {
        success: true,
        ready: true,
        status: 'succeeded',
        jobId: manifest.jobId || jobId,
        symbol: manifest.symbol || '',
        report,
        marketReview: marketReview || '',
        metrics,
        phase: 'succeeded',
        phaseMessage: manifest.phaseMessage || '分析已完成',
        phaseSource: 'github-manifest',
        source: 'github-job',
        generatedAt: manifest.generatedAt || manifest.finishedAt || 0,
        runId: manifest.runId || '',
        updatedAt: manifest.updatedAt || 0,
        manifestUrl: lastManifestUrl,
        resultFiles: {
          manifestUrl: lastManifestUrl,
          reportUrl: `${base}/report.md`,
          metricsUrl: `${base}/metrics.json`,
        },
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * 按 jobId 轮询任务状态；云函数失败时对已发布终态走 GitHub raw 兜底。
   * @param {string} jobId
   */
  function pollJobResult(jobId) {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    const pollStartedAt = Date.now();
    let rawFallbackTried = false;

    async function tryRawFallback() {
      if (rawFallbackTried || isResultReady) return false;
      rawFallbackTried = true;
      const fallback = await fetchJobFromGithubRaw(jobId);
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
        // 超时前再尝试一次公开结果库，便于历史回看
        if (await tryRawFallback()) return;
        stopPolling();
        if (!isResultReady) {
          stopElapsedTimer();
          setPanelIcon('error');
          setBadge('error');
          setBtnState('idle');
          if (panelMessage) {
            panelMessage.innerHTML = `<span style="color:#fb923c">⏱ 等待超时。任务可能仍在运行，可稍后返回本页继续查看（已保留任务 ID）。</span>`
              + ` <button id="btn-re-check" style="margin-left:8px;padding:2px 8px;background:rgba(59,130,246,0.2);border:1px solid #3b82f6;color:#93c5fd;border-radius:4px;cursor:pointer;font-size:0.75rem">手动重新拉取结果</button>`;
            const reCheckBtn = document.getElementById('btn-re-check');
            if (reCheckBtn) {
              reCheckBtn.onclick = () => {
                isResultReady = false;
                rawFallbackTried = false;
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
            if (data.runId) lastRunId = String(data.runId);
            if (data.updatedAt) lastUpdatedAt = Number(data.updatedAt) || 0;

            const phaseSource = data.phaseSource || '';
            const realPhase = isRealPhaseSource(phaseSource, data.source);

            // 仅 GitHub manifest 真实阶段才接管进度；DB queued 不终止虚拟兜底
            if (realPhase && data.phase) {
              applyPhaseProgress(data.phase, data.phaseMessage || '');
            } else if (phaseSource === 'db' || phaseSource === 'pending' || data.source === 'db' || data.source === 'pending') {
              setPhaseSourceHint(phaseSource || data.source || 'db');
              // 已进入研判模拟轮播时勿覆盖文案（否则会打回「同步中」）
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
                panelMessage.innerHTML = `<span style="color:#93c5fd">${waitHint}</span>`;
              }
            } else if (
              panelMessage
              && (status === 'queued' || status === 'running')
              && !data.phase
              && !usePhaseProgress
              && !analyzeSimTimer
            ) {
              const label = STATUS_LABELS[status] || status;
              panelMessage.innerHTML = `<span style="color:#93c5fd">当前状态：${label}，正在同步分析进度…</span>`;
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

            // 云函数拿不到正文时，对已成功任务走公开结果库兜底
            if (
              (data.errorCode === 'EMPTY_REPORT' || data.errorCode === 'FETCH_FAILED')
              && await tryRawFallback()
            ) {
              return;
            }

            // FETCH_FAILED：manifest 已声明报告，正文读取中 — 保持 publish 阶段重试
            if (data.errorCode === 'FETCH_FAILED' && realPhase) {
              if (panelMessage) {
                panelMessage.innerHTML = `<span style="color:#fbbf24">${data.error || data.phaseMessage || '报告已发布，正在重试读取…'}</span>`;
              }
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
        // 网关抖动：优先尝试公开结果库（历史回看场景）
        if (await tryRawFallback()) return;
      }

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

  /**
   * 上游报告常见「**标签**: 内容」连续单行；CommonMark 会并成一段导致不换行。
   * 在标签行前补空行，强制分成独立段落（修复「📊 业绩预期」挤在上一行后的问题）。
   */
  function normalizeReportMarkdown(md) {
    return String(md || '')
      .replace(/\r\n/g, '\n')
      .replace(/\n(\*\*[^*\n]{1,48}\*\*\s*[:：])/g, '\n\n$1');
  }

  function parseMd(text) {
    if (!text) return '';
    const normalized = normalizeReportMarkdown(text);
    let html;
    if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
      html = marked.parse(normalized);
    } else {
      html = normalized.replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  function escapeText(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 把整份个股报告按「## … (股票代码)」拆成多页。
   * 仪表盘 / 分析结果摘要等前置内容并入第一只股票页。
   */
  function splitStockReportSections(reportMd, fallbackSymbol) {
    const text = String(reportMd || '').replace(/\r\n/g, '\n').trim();
    if (!text) return [];

    const headingRe = /^##\s+(.+?)\s*\(([A-Z0-9][A-Z0-9.\-]{0,19})\)\s*$/gm;
    const matches = [];
    let m;
    while ((m = headingRe.exec(text)) !== null) {
      const titleLine = m[1].trim();
      // 跳过「分析结果摘要」这类非个股标题
      if (/分析结果摘要/.test(titleLine)) continue;
      const name = titleLine
        .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\s]+/u, '')
        .replace(/^[🟠🟢🟡🔴⚪⚫]+/u, '')
        .trim() || m[2];
      matches.push({
        index: m.index,
        end: m.index + m[0].length,
        code: String(m[2] || '').toUpperCase(),
        name,
        heading: m[0],
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
      // 第一只股票带上仪表盘等前置内容，避免丢失总览信息
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

  function switchReportTab(tabId) {
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
      if (active) pane.removeAttribute('hidden');
      else pane.setAttribute('hidden', '');
    });
  }

  function buildReportTabs(stockSections, marketMd) {
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
      if (tab.kind === 'market') {
        btn.innerHTML = `<span>${escapeText(tab.label)}</span>`;
      } else {
        btn.innerHTML = `<span>${escapeText(tab.label)}</span>`
          + (tab.code && tab.code !== tab.label
            ? `<span class="tab-code">${escapeText(tab.code)}</span>`
            : '');
      }
      reportTabs.appendChild(btn);

      const pane = document.createElement('section');
      pane.className = 'report-pane';
      pane.setAttribute('data-pane', tab.id);
      pane.setAttribute('role', 'tabpanel');
      if (idx !== 0) pane.setAttribute('hidden', '');
      pane.innerHTML = `<div class="markdown-body">${parseMd(tab.markdown)}</div>`;
      reportPanels.appendChild(pane);
    });

    reportTabs.classList.remove('hidden');
    switchReportTab(tabs[0].id);
  }

  /** 展开/收起分析流水列表 */
  function setHistoryExpanded(expanded) {
    if (!historyList) return;
    historyList.classList.toggle('hidden', !expanded);
    if (btnToggleHistory) btnToggleHistory.textContent = expanded ? '收起' : '展开';
  }

  /** 置信度统一为百分比文案 */
  function formatConfidence(value) {
    if (value == null || value === '') return '';
    const n = Number(value);
    if (Number.isNaN(n)) return String(value);
    return n <= 1 ? `${Math.round(n * 100)}%` : `${Math.round(n)}%`;
  }

  /** 状态短标签 */
  function formatJobStatus(status) {
    return STATUS_LABELS[status] || (status ? String(status) : '');
  }

  /** 渲染本机分析流水行 */
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
      const rating = item.rating || '';
      const trend = item.trend || '';
      const risk = item.riskLevel || '';
      const conf = formatConfidence(item.confidence);
      const metaParts = [
        statusText ? `状态 ${statusText}` : '',
        rating ? `观点 ${rating}` : '',
        trend ? `趋势 ${trend}` : '',
        risk ? `风险 ${risk}` : '',
        conf ? `置信度 ${conf}` : '',
      ].filter(Boolean);

      row.innerHTML = `<div class="hist-title">`
        + `<span class="hist-badge">#${items.length - index}</span>`
        + `<span class="font-mono text-sky-300">${escapeText(sym)}</span>`
        + `<span>${escapeText(when)}</span>`
        + (isCurrent ? '<span class="hist-badge">当前</span>' : '')
        + `</div>`
        + (metaParts.length
          ? `<div class="hist-meta">${escapeText(metaParts.join(' · '))}</div>`
          : `<div class="hist-meta">点击回看该次分析报告</div>`);

      row.addEventListener('click', () => {
        if (isCurrent && isResultReady) {
          if (reportContainer) {
            reportContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return;
        }
        resumeJob(jobId, sym);
      });
      historyList.appendChild(row);
    });
  }

  /**
   * 展示本机分析流水（localStorage 中此前触发的任务）。
   * @param {{ expand?: boolean, allowEmpty?: boolean, scrollIntoView?: boolean }} options
   */
  function showJobHistory(options = {}) {
    const {
      expand = true,
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

  function renderReport(data) {
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

    const stockSections = splitStockReportSections(stockText, symbol);
    buildReportTabs(stockSections, marketMd);
    // 报告就绪后刷新本机分析流水，默认折叠并标出当前任务
    showJobHistory({ expand: false, allowEmpty: false });

    if (emptyState) emptyState.style.display = 'none';
    if (reportContainer) reportContainer.classList.remove('hidden');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 页面加载：URL 中的 jobId 是任务恢复入口（须在全部函数/常量就绪后调用）
  bootstrapFromUrlOrStorage();

});
