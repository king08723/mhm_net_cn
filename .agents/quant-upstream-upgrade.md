# 分析仓上游升级说明（路径 3：本仓编排）

## 解耦边界

| 能解耦的 | 说明 |
|----------|------|
| 上游 `daily_stock_analysis` **零改动** | 不改其 workflow、不插胶水挂点 |
| Phase / metrics / history | 全部在本仓 `scripts/` + `.github/workflows/` |
| 前端 / 云函数契约 | 仍只认 `jobs/{jobId}/*` |

**结论**：编排与结果归属 `king08723/mhm_net_cn`；上游只提供可执行源码。

## 本仓职责（仅两件）

1. **拉取**上游源码（`actions/checkout` → `analysis/`）
2. **运行并保存结果**（`main.py` → `push_unicloud_result.py` 写本仓 `analysis-results`）

相关文件：

| 路径 | 作用 |
|------|------|
| `.github/workflows/quant-stock-analysis.yml` | 编排 workflow |
| `scripts/run_quant_analysis.sh` | 解析 quant_params + 调上游 `main.py` |
| `scripts/quant_bridge.sh` | 执行期 phase / 终态挂点 |
| `scripts/push_unicloud_result.py` | 写 `jobs/{jobId}/*` |

## 从上游升级 checklist

1. 默认每次 run 拉取 `vars.UPSTREAM_REF`（或 input `upstream_ref`，默认 `main`）
2. 若上游改了 CLI / 环境变量名：只改本仓 `run_quant_analysis.sh` 与 workflow 的 `env:` 映射
3. 冒烟：quant 页触发 → `phaseSource=github-manifest` → 成功有 `metrics.json`
4. 结果路径：`https://raw.githubusercontent.com/king08723/mhm_net_cn/analysis-results/jobs/{jobId}/manifest.json`

## Secrets / Variables 迁移

GitHub **不能**让 `mhm_net_cn` 的 Actions 直接读取 `daily_stock_analysis` 里的 Secrets。  
本仓跑分析时，必须在 **本仓 Settings** 再有一份配置。

### 你这种「只在 GitHub Settings 里配过、没有本地 .env」的情况

打开两个页面对照：

1. 旧仓：https://github.com/king08723/daily_stock_analysis/settings/secrets/actions  
2. 新仓：https://github.com/king08723/mhm_net_cn/settings/secrets/actions  

对旧仓里**你实际添加的那约 26 项**：

| 类型 | 怎么迁 |
|------|--------|
| **Variables** | 值可见 → 在新仓同名新建，直接复制粘贴 |
| **Secrets** | 值不可见、也无法导出 → 用你当初申请 Key 的地方（Gemini / AIHubMix / Tushare…）再贴一次到新仓**同名** Secret |

workflow 已按旧仓同名映射；**没配的项就是空，不用刻意凑齐上游 YAML 里那上百个名字**。  
若旧仓还用了 Environment（例如 `STOCK_LIST`），也要看 Environment 里有没有额外变量。

### 可选：一条 QUANT_ENV_B64

若你后来自己整理出一份 `KEY=VALUE` 文件，也可用 `scripts/sync_quant_env_secret.sh` 写成一条 Secret；与逐条配置可并存。

可选 Variables：`UPSTREAM_REPO` / `UPSTREAM_REF` / `ANALYSIS_TIMEOUT_MINUTES`。  
uniCloud `GITHUB_PAT` 需对 **`mhm_net_cn`** 有 `actions:write`。

## 契约（勿破坏）

`analysis-results/jobs/{jobId}/`：

- `manifest.json`（`status` / `phase` / `phaseMessage` / `hasMetrics` …）
- `report.md`、可选 `market_review.md`
- `metrics.json`（成功强制）
