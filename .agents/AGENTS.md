# uniCloud 静态托管部署规范与环境配置（注意区别，并不是腾讯云CloudBase）

> quant 页面端到端实现说明（JobId + GitHub 文件单链路）：见 [quant-page-architecture.md](./quant-page-architecture.md)

## 项目部署环境说明
- **云平台/服务商**: uniCloud 支付宝云 (`alipay`)
- **服务空间名称**: `dcloud-basic-20251111`
- **SpaceId**: `env-00jxub78ulva`
- **在线正式域名**: https://nhm.net.cn/

## 静态托管不部署清单
排除规则写在根目录 [`.deployignore`](../.deployignore)，由 [`watch-deploy.js`](../watch-deploy.js) 在上传前过滤；**不要**把仍需进 Git 的工程目录写进 `.gitignore`。

当前排除（完整以 `.deployignore` 为准）：
- `.agents/`、`.github/`、`watch-deploy.js`、`.deployignore`、`.deploy-staging/`
- `hbuilder/`（云函数工程，走云函数上传）
- `scripts/`、`partials/`（运维脚本 / 注入源，非线上资源）
- `node_modules/`、`package.json`、`package-lock.json`、`tailwind.config.js`
- 源样式：`css/site-src.css`、`css/quant-src.css`、`css/quant.css`、`css/style.css`
- 量化源模块：`js/quant.js`、`js/quant-api.js`、`js/quant-config.js`、`js/quant-icons.js`、`js/quant-catalog.js`、`js/quant-progress.js`、`js/quant-report.js`（线上用 bundle）
- `.git/`、IDE 配置、`.DS_Store`、日志与 `.env*`

**应部署的静态资源**：根目录 `*.html`、`css/site.css`、`js/`（含 `quant.bundle.js`、站点脚本、`vendor/`）、`images/`、`assets/`。

## 构建与部署
- 部署前会跑 `npm run build`：`inject`（partials）→ `optimize:html` → `build:css`（Tailwind → `css/site.css`）→ `build:quant`（esbuild → `js/quant.bundle.js`）
- **推荐**（过滤后再 `--source` 临时目录）：
  ```bash
  npm run deploy
  # 或
  node watch-deploy.js --once
  ```
- **HBuilderX CLI (Mac)**: `/Applications/HBuilderX.app/Contents/MacOS/cli`
- **不推荐裸命令**（会把 `hbuilder`、`.agents`、源模块等一并上传）：
  ```bash
  /Applications/HBuilderX.app/Contents/MacOS/cli hosting deploy --provider alipay --space env-00jxub78ulva --source /Users/jyy/Documents/trae_projects/myPage
  ```

## 自动化操作命令
- **`npm run watch`**: 监听网页相关文件；排除项变更不触发；保存后防抖 → `build` → 按 `.deployignore` 部署
- **`npm run deploy`**: 单次 `build` + 部署
- **`npm run build`**: 只构建、不上传
- **`npm run build:quant`** / **`npm run build:css`**: 单独重建 bundle / CSS

## 关联 GitHub Actions 量化分析（路径 3：本仓编排）
- **编排仓库**: `king08723/mhm_net_cn`（本站）
- **上游源码仓**: `king08723/daily_stock_analysis`（默认拉取 **`dev`** 分支；只拉取运行，不在此跑 Workflow）
- **排查分工（重要）**:
  - **分析正确性 / 量比 / 行情 / LLM 报告内容 / 数据源**：查上游 `daily_stock_analysis`（源码 + 本仓 Actions「Run stock analysis」步骤日志，该步骤即在 runner 上执行上游 `main.py`）
  - **编排 / 触发 / 限流 / jobId / 结果发布到 `analysis-results`**：查本仓 `mhm_net_cn`（云函数 + `quant-stock-analysis.yml` + bridge）
  - 页面展示异常先对照 `jobs/{jobId}/report.md`；数值类问题默认按上游库缺陷排查，不要只在编排仓打转
- **Workflow**: `.github/workflows/quant-stock-analysis.yml`
- **API 触发接口**: `POST /repos/king08723/mhm_net_cn/actions/workflows/quant-stock-analysis.yml/dispatches`
- **uniCloud 云函数目录**: `hbuilder/hbuilder/uniCloud-alipay/cloudfunctions/`
  - `trigger-stock-analysis` → `https://f.nhm.net.cn/trigger-stock-analysis`
  - `get-stock-result` → `https://f.nhm.net.cn/get-stock-result`
- **数据库集合**:
  - `analysis_jobs`（触发审计与去重指纹；结果正文以 GitHub 为准，不长期存 Markdown）
  - `analysis_rate_limits`（按 IP 短窗 5 次/5 分钟 + 日配额 20 次）
- **结果中转（唯一路径）**:
  - Actions **只**写入本仓 `analysis-results`：
    - `jobs/{jobId}/report.md`
    - `jobs/{jobId}/market_review.md`
    - `jobs/{jobId}/manifest.json`（建议含 `phase` / `phaseMessage` / `runId`）
    - `jobs/{jobId}/metrics.json`（可选结构化摘要）
  - 可选索引：`docs/{SYMBOL}/latest.json`、`docs/{SYMBOL}/history.json`
  - 前端只轮询 `get-stock-result?jobId=`（可用 `quant.html?product=&jobId=` 刷新恢复；无参打开为产品 Hub）
  - 云函数按 jobId 读 GitHub：默认 `raw` → Contents API → jsDelivr；新报告/metrics 常用 `preferApi`（Contents 优先）；**不再** Actions→uniCloud POST
- **云函数环境变量**:
  - `trigger-stock-analysis`: `GITHUB_PAT`（需能对 `mhm_net_cn` 做 `actions:write`）
  - `get-stock-result`: 建议同样配置 `GITHUB_PAT`（可选但推荐；无 PAT 时用匿名额度）
  - 无需 `JOB_CALLBACK_SECRET`（可删除）
- **云函数上传**（`cloudfunction-config` 不要写 `runtime`）:
  ```bash
  /Applications/HBuilderX.app/Contents/MacOS/cli cloud functions --upload cloudfunction --prj hbuilder --provider alipay --name get-stock-result --force
  /Applications/HBuilderX.app/Contents/MacOS/cli cloud functions --upload cloudfunction --prj hbuilder --provider alipay --name trigger-stock-analysis --force
  ```
- **Actions 侧（路径 3）**: 本仓 workflow 按 `engine` 拉取 DSA 或 TradingAgents → 跑对应入口 → `quant_bridge.sh` 写 phase/终态到本仓 `analysis-results`。LLM/数据源等可用逐条 Secrets，或一条 `QUANT_ENV` / `QUANT_ENV_B64`（`bash scripts/sync_quant_env_secret.sh <上游.env>`）。升级清单见 [quant-upstream-upgrade.md](./quant-upstream-upgrade.md)。
- **触发防护**: 同参数 8 分钟内去重复用 `jobId`；Actions 始终 `force_run=true`（跳过交易日检查）。前端「重新分析」只控制是否绕过短时去重。详情见 [quant-page-architecture.md](./quant-page-architecture.md)。
