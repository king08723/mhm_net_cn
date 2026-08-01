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

## Secrets / Variables 迁移（不必逐条重配）

GitHub **无法读出**已写入 Secret 的值，所以不能「从上游仓 API 自动抄到本仓」。

**推荐（一条搞定）**：

1. 找到上游本地 `.env`（或对照原仓 Secrets 名称拼一份仍在用的 `.env`）
2. 一键写入本仓：

```bash
bash scripts/sync_quant_env_secret.sh /path/to/daily_stock_analysis/.env
```

这会设置本仓 Secret `QUANT_ENV_B64`；workflow 启动时由 `inject_quant_env.sh` 注入，**无需**把几十个 Key 在本仓再配一遍。

**更省**：`.env` 里其实只需你真正在用的几项（常见：LLM Key + 可选 Tushare/邮件）。上游 workflow 里那一长串大多是可选兜底。

可选 Variables：

- `UPSTREAM_REPO`（默认 `king08723/daily_stock_analysis`）
- `UPSTREAM_REF`（默认 `main`）
- `UPSTREAM_CHECKOUT_TOKEN`（上游私有时需要）
- `ANALYSIS_TIMEOUT_MINUTES`（默认 `30`）

PAT（uniCloud `GITHUB_PAT`）需对 **`mhm_net_cn`** 具备 `actions:write` + 读结果所需权限。

## 契约（勿破坏）

`analysis-results/jobs/{jobId}/`：

- `manifest.json`（`status` / `phase` / `phaseMessage` / `hasMetrics` …）
- `report.md`、可选 `market_review.md`
- `metrics.json`（成功强制）
