# uniCloud 静态托管部署规范与环境配置（注意区别，并不是腾讯云CloudBase）

> quant 页面端到端实现说明（JobId + GitHub 文件单链路）：见 [quant-page-architecture.md](./quant-page-architecture.md)

## 项目部署环境说明
- **云平台/服务商**: uniCloud 支付宝云 (`alipay`)
- **服务空间名称**: `dcloud-basic-20251111`
- **SpaceId**: `env-00jxub78ulva`
- **在线正式域名**: https://nhm.net.cn/

## 静态托管不部署清单
排除规则写在根目录 [`.deployignore`](file:///Users/jyy/Documents/trae_projects/myPage/.deployignore)，由 [`watch-deploy.js`](file:///Users/jyy/Documents/trae_projects/myPage/watch-deploy.js) 在上传前过滤；**不要**把仍需进 Git 的工程目录写进 `.gitignore`。

当前排除（完整以 `.deployignore` 为准）：
- `.agents/`、`.github/`、`watch-deploy.js`、`.deployignore`（本地 Agent / Actions / 部署工具）
- `hbuilder/`（HBuilderX 与 uniCloud 云函数工程，走云函数上传）
- `scripts/`（运维/回传脚本，非前端资源）
- `node_modules/`、`package.json`、`package-lock.json`
- `.git/`、IDE 配置、`.DS_Store`、日志与 `.env*`

**应部署的静态资源**：根目录 `*.html`、`css/`、`js/`、`images/`。

## 本地 HBuilderX CLI 命令行部署说明
- **HBuilderX CLI 路径 (Mac)**: `/Applications/HBuilderX.app/Contents/MacOS/cli`
- **推荐**：始终通过脚本部署（会按 `.deployignore` 过滤后再 `--source` 临时目录），勿直接把整个项目根目录作为 `--source`：
  ```bash
  npm run deploy
  # 或
  node watch-deploy.js --once
  ```
- **不推荐的裸命令**（会把 `hbuilder`、`.agents` 等一并上传）：
  ```bash
  /Applications/HBuilderX.app/Contents/MacOS/cli hosting deploy --provider alipay --space env-00jxub78ulva --source /Users/jyy/Documents/trae_projects/myPage
  ```

## 自动化操作命令
项目根目录已配置 [watch-deploy.js](file:///Users/jyy/Documents/trae_projects/myPage/watch-deploy.js)：
- **`npm run watch`**: 启动文件实时监听；排除项变更不触发；保存网页相关文件后防抖，过滤后自动部署上线。
- **`npm run deploy`**: 手动执行单次一键部署（同样走 `.deployignore`）。

## 关联 GitHub Actions 量化分析（路径 3：本仓编排）
- **编排仓库**: `king08723/mhm_net_cn`（本站）
- **上游源码仓**: `king08723/daily_stock_analysis`（只拉取运行，不在此跑 Workflow）
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
  - 前端只轮询 `get-stock-result?jobId=`（可用 `quant.html?jobId=` 刷新恢复）
  - 云函数按 jobId 读 GitHub 文件返回（顺序：Contents API → raw → jsDelivr；**不再** Actions→uniCloud POST）
- **云函数环境变量**:
  - `trigger-stock-analysis`: `GITHUB_PAT`（需能对 `mhm_net_cn` 做 `actions:write`）
  - `get-stock-result`: 建议同样配置 `GITHUB_PAT`（可选但推荐，Contents API 更稳；无 PAT 时用匿名额度）
  - 无需 `JOB_CALLBACK_SECRET`（可删除）
- **云函数上传**（`cloudfunction-config` 不要写 `runtime`）:
  ```bash
  /Applications/HBuilderX.app/Contents/MacOS/cli cloud functions --upload cloudfunction --prj hbuilder --provider alipay --name get-stock-result --force
  /Applications/HBuilderX.app/Contents/MacOS/cli cloud functions --upload cloudfunction --prj hbuilder --provider alipay --name trigger-stock-analysis --force
  ```
- **Actions 侧（路径 3）**: 本仓 workflow 拉取上游 → 跑 `main.py` → `quant_bridge.sh` 写 phase/终态到本仓 `analysis-results`。LLM/数据源等推荐只配一条 Secret `QUANT_ENV_B64`（`bash scripts/sync_quant_env_secret.sh <上游.env>`）。升级清单见 [quant-upstream-upgrade.md](./quant-upstream-upgrade.md)。
- **触发防护**: 同参数 8 分钟内去重复用 `jobId`；Actions 始终 `force_run=true`（跳过交易日检查）。前端「重新分析」只控制是否绕过短时去重。详情见 [quant-page-architecture.md](./quant-page-architecture.md)。
