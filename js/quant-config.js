/**
 * 量化页常量配置（无 DOM 依赖）
 */

export const UNICLOUD_TRIGGER_URL = 'https://f.nhm.net.cn/trigger-stock-analysis';
export const UNICLOUD_RESULT_URL = 'https://f.nhm.net.cn/get-stock-result';
/** 历史回看兜底：云函数不可达时直接读已发布的 jobs/{jobId} */
export const JOBS_RAW_BASE =
  'https://raw.githubusercontent.com/king08723/mhm_net_cn/analysis-results/jobs';

export const COOLDOWN_MS = 60 * 1000;
export const POLL_INTERVAL_INITIAL = 3000;
export const POLL_INTERVAL_MAX = 15000;
export const POLL_FAST_WINDOW_MS = 2 * 60 * 1000;
export const POLL_DEADLINE_MS = 15 * 60 * 1000;

export const RECENT_JOBS_KEY = 'quant_recent_jobs_v1';
export const RECENT_JOBS_MAX = 20;

/** 报告渲染用 Markdown 栈：同源自托管，避免第三方 CDN RTT */
export const MARKED_SRC = 'js/vendor/marked.min.js';
export const DOMPURIFY_SRC = 'js/vendor/purify.min.js';

export const DEFAULT_ANALYSIS_OPTIONS = {
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

/** phase → 步骤索引；无 phase 时退回虚拟时间线 */
export const PHASE_STEP_INDEX = {
  queued: 0,
  checkout: 1,
  setup: 2,
  fetch: 3,
  analyze: 4,
  publish: 5,
  succeeded: 5,
  failed: -1,
};

/** 用户可见进度文案（不暴露工程实现细节）；icon 为 quant-icons 键名 */
export const STEPS = [
  { id: 'dispatch', phase: 'queued', icon: 'paperPlane', label: '创建分析任务', desc: '正在创建 AI 投研分析任务…', duration: 5 },
  { id: 'queue', phase: 'checkout', icon: 'layers', label: '云端算力排队', desc: '云端算力已接受请求，正在排队分配分析资源…', duration: 15 },
  { id: 'env', phase: 'setup', icon: 'server', label: '初始化分析环境', desc: '正在启动分析环境，准备大模型与数据组件…', duration: 45 },
  { id: 'fetch', phase: 'fetch', icon: 'database', label: '拉取行情数据', desc: '正在拉取历史行情、成交量与相关市场信息…', duration: 45 },
  { id: 'compute', phase: 'analyze', icon: 'cpu', label: '大模型综合研判', desc: '正在运行 AI 策略与大模型推理，生成投研观点…', duration: 180 },
  { id: 'output', phase: 'publish', icon: 'chart', label: '生成研究报告', desc: '正在整理摘要与正文，生成可阅读的研究报告…', duration: 30 },
];

export const TOTAL_DURATION = STEPS.reduce((s, st) => s + st.duration, 0);

export const VIRTUAL_HOLD_STEP_INDEX = 4;
export const VIRTUAL_PROGRESS_CAP = 68;
export const VIRTUAL_STEP_SECONDS = [3, 6, 10, 12, 150, 20];

/** 分析阶段轮播文案；间隔拉长并配合洗牌，避免短时重复 */
export const ANALYZE_SIM_INTERVAL_MS = 14000;

export const ANALYZE_SIM_MESSAGES = [
  '正在梳理技术指标与量价关系…',
  '正在结合行业与市场环境交叉验证…',
  '大模型正在生成多空观点与风险提示…',
  '正在校准置信度与关键支撑/压力位…',
  '正在比对历史波动区间与当前价位偏离…',
  '正在评估资金流向与成交密集区…',
  '正在解析均线结构与动量拐点信号…',
  '正在核对估值分位与同业相对强弱…',
  '正在推演情景假设下的收益风险比…',
  '正在融合宏观情绪与微观盘口线索…',
  '正在甄别异常放量与假突破形态…',
  '正在对齐多周期趋势一致性…',
  '正在量化回撤缓冲与止损参考带…',
  '正在交叉比对财报预期与价格反应…',
  '正在评估流动性与冲击成本约束…',
  '正在合成技术面与基本面一致性评分…',
  '正在标记高不确定性区间与观察清单…',
  '正在复核关键结论的证据链完整性…',
  '正在提炼报告摘要与核心投资逻辑…',
  '正在汇总研判结论，请稍候…',
];

export const STATUS_LABELS = {
  queued: '排队中',
  running: '分析中',
  succeeded: '完成',
  failed: '失败',
  timeout: '超时',
};

export const PHASE_LABELS = {
  queued: '排队中',
  checkout: '准备资源',
  setup: '初始化环境',
  fetch: '拉取数据',
  analyze: '大模型研判',
  publish: '生成报告',
  succeeded: '已完成',
  failed: '失败',
};

export const PHASE_ETA = {
  queued: { typical: '约 10–30 秒', remainMin: 4, remainMax: 8 },
  checkout: { typical: '约 15–30 秒', remainMin: 4, remainMax: 7 },
  setup: { typical: '约 30–60 秒', remainMin: 3, remainMax: 6 },
  fetch: { typical: '约 30–90 秒', remainMin: 3, remainMax: 6 },
  analyze: { typical: '约 2–5 分钟', remainMin: 2, remainMax: 5 },
  publish: { typical: '约 20–40 秒', remainMin: 0, remainMax: 1 },
};

export const BADGES = {
  running: { text: '分析中', cls: 'text-blue-300  border-blue-400/40  bg-blue-500/10' },
  success: { text: '完成', cls: 'text-green-300 border-green-400/40 bg-green-500/10' },
  error: { text: '失败', cls: 'text-red-300   border-red-400/40   bg-red-500/10' },
};
