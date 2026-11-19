# A股与大类资产每日投研监控看板（双独立网址版）

本项目整合四份参考资料的工程架构、免 Key 数据口径与 SMC 技术分析框架，采用**纯静态前端 + Python 每日自动更新 + 本地内置 ECharts（零外部 CDN 依赖）**设计，并将大类资产/宽基与个股分离为**两个独立网址看板**，开箱满足公网链接分享、局域网分享与微信单文件转发：

- **主市场看板（5大核心项目）**：`index.html`（公网网址 `/`）
  1. 沪深300全收益指数 vs 二级债基指数（波动收敛走势、7次历史跌破红圈与灰带、线性/对数切换）
  2. “国家队”持有全A宽基ETF份额与动向走势（16只重仓宽基ETF总份额、估算净申赎、中信期货净空头、官方持仓基准）
  3. 科创50（`000688.SH`）技术分析走势图（日K + 成交量 + MACD/RSI + SMC聪明钱结构）
  4. 创业板50（`399673.SZ`）技术分析走势图（日K + 成交量 + MACD/RSI + SMC聪明钱结构）
  5. 黄金技术分析走势图（沪金主力连续 `AU0` / 上海金现货 `Au99.99` / 华安黄金ETF `518880` 一键切换）
- **燕东微专属独立看板**：`yandongwei.html`（公网网址 `/yandongwei.html`）
  - 燕东微（`688172.SH`）前复权日K + 科创板量价与市值校准快照（成交量单位「股/万股」、总市值 `f[45]` / 流通市值 `f[44]` / PB `f[46]`）+ SMC 聪明钱结构图 + 活跃订单块 OB / 未补 FVG / 近期 BOS·CHoCH 明细表。

---

## 一、如何分享给别人（三种开箱可用方案）

### 方案 A：公网网址分享 + 每日全自动更新（推荐，完全免费）
适合发给任何外部朋友、微信群或收藏到手机桌面，**无需你电脑开机**，每天自动更新：
1. 在 GitHub 新建一个公开仓库（如 `market-dashboard`），将本目录全部文件推送上去：
   ```powershell
   git init
   git add .
   git commit -m "init: market dashboard"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/market-dashboard.git
   git push -u origin main
   ```
2. 在 GitHub 仓库页面进入 **Settings → Pages → Source 选择 `Deploy from a branch` → Branch 选 `main` / `/ (root)` → Save**。
3. 等待 1 分钟即可获得两个永久 HTTPS 分享网址：
   - **主市场看板（5大项目）**：`https://<你的用户名>.github.io/market-dashboard/`
   - **燕东微独立看板**：`https://<你的用户名>.github.io/market-dashboard/yandongwei.html`
4. 内置的 `.github/workflows/daily-update.yml` 会在每个交易日 **23:05（北京时间）** 自动抓取最新数据并推送更新（也可在 GitHub Actions 页面随时点击 **Run workflow** 手动触发）。
   > *注：如果希望国内访问更快，可将同一个 GitHub 仓库绑定到 **Cloudflare Pages** 或 **Netlify**，同样免费且自动同步更新。*

### 方案 B：微信 / 钉钉 / 邮件直接发单个 HTML 文件（零部署，离线可开）
每次运行 `python scripts/update_daily.py` 时，会自动在 `dist/` 下打包生成两个**完全自包含的单文件离线网页**（内嵌样式、ECharts 引擎与最新数据，无需联网、无需开服务器，对方双击即可交互缩放）：
- `dist/market-dashboard-share.html`（主市场 5 大项目看板）
- `dist/yandongwei-share.html`（燕东微独立看板）

### 方案 C：同 Wi-Fi / 办公室局域网实时分享
无需部署到外网，直接在本机运行：
```powershell
python serve.py 8080 --lan
```
终端会打印你的局域网地址（例如 `http://192.168.x.x:8080/` 和 `http://192.168.x.x:8080/yandongwei.html`），同局域网同事直接打开即可只读浏览（出于安全，仅本机 `127.0.0.1` 允许触发 `/api/refresh` 抓取更新）。

---

## 二、本地运行与 Windows 每日定时更新

```powershell
# 1. 安装依赖（仅 requests）
pip install -r requirements.txt

# 2. 抓取最新数据并生成 JSON/JS 与单文件分享快照
python scripts/update_daily.py

# 3. 启动本地预览
python serve.py 8080
# 主看板:   http://127.0.0.1:8080/
# 燕东微:   http://127.0.0.1:8080/yandongwei.html

# 4. (可选) 一键注册 Windows 每日 23:05 定时任务
.\register_task.ps1
```

---

## 三、目录结构

```text
market-dashboard/
├── index.html                      # 主市场看板（5大项目）
├── yandongwei.html                 # 燕东微独立看板
├── config.json                     # 唯一配置中心（标的、Wind年度锚点、SMC参数）
├── .nojekyll                       # GitHub Pages 静态直出标记
├── assets/
│   ├── styles.css                  # 统一投研看板样式
│   ├── app.js                      # 双页面共享渲染引擎（自动适配静态托管/本机/离线快照）
│   └── vendor/echarts.min.js       # 本地内置 ECharts 5.5.1（零外部 CDN 依赖）
├── scripts/
│   ├── data_sources.py             # 免Key多源数据获取（提炼自 a-stock-data V3.10.4）
│   ├── smc_engine.py               # SMC 聪明钱 + MA/BOLL/MACD/RSI 引擎
│   └── update_daily.py             # 每日自动更新 + 双离线快照打包脚本
├── data/
│   ├── dashboard_data.json         # HTTP 静态站点数据源
│   ├── dashboard_data.js           # file:// 兼容数据源
│   ├── etf_history_cache.json      # 国家队 ETF 历史归档
│   └── cache/                      # 中证长周期历史指数增量缓存
├── dist/
│   ├── market-dashboard-share.html # 单文件离线分享版（主市场5大项目）
│   └── yandongwei-share.html       # 单文件离线分享版（燕东微独立看板）
├── serve.py                        # 本地预览 & --lan 局域网分享服务
├── run_daily_update.bat            # Windows 更新脚本
├── register_task.ps1               # Windows 每日定时任务注册脚本
└── .github/workflows/daily-update.yml  # GitHub Actions 每日定时更新工作流
```
