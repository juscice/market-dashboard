(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const COLORS = {
    red: "#d94442",
    green: "#1d9a63",
    blue: "#2563eb",
    purple: "#6d4aff",
    amber: "#d97706",
    teal: "#0d9488",
    ink: "#1e293b",
    sub: "#64748b",
    grid: "#eef2f7",
  };

  const allCharts = [];
  let DATA = null;

  function registerChart(el) {
    const existing = echarts.getInstanceByDom(el);
    if (existing) existing.dispose();
    const ch = echarts.init(el);
    allCharts.push(ch);
    return ch;
  }

  function fmt(v, d = 2, sign = false) {
    if (v == null || Number.isNaN(v)) return "—";
    const s = sign && v > 0 ? "+" : "";
    return s + Number(v).toLocaleString("zh-CN", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  }

  function cls(v) {
    if (v == null || Number.isNaN(v)) return "";
    return v > 0 ? "pos" : v < 0 ? "neg" : "";
  }

  function trendBadge(trend) {
    if (trend === 1) return '<span class="badge bull">偏多 Bullish</span>';
    if (trend === -1) return '<span class="badge bear">偏空 Bearish</span>';
    return '<span class="badge neutral">震荡 Neutral</span>';
  }

  function showBanner(msg, isErr = false) {
    const b = $("banner");
    b.textContent = msg;
    b.className = isErr ? "banner err" : "banner";
    b.style.display = "block";
  }

  function hideBanner() {
    $("banner").style.display = "none";
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  let BASE_DATA = null;
  let canServerRefresh = false;
  let liveSyncInFlight = false;
  let autoPollTimer = null;
  const isFileMode = location.protocol === "file:";
  const isLocalHost = ["127.0.0.1", "localhost", "::1"].includes(location.hostname);
  const PAGE_MODE = (document.body && document.body.dataset && document.body.dataset.page) || "market";

  async function detectHostCapabilities() {
    const shareBtn = $("shareBtn");
    if (isFileMode) {
      if (shareBtn) {
        shareBtn.textContent = "📄 单文件版";
        shareBtn.title = "当前为单文件网页，联网时同样支持自动拉取实时行情";
      }
      return;
    }
    if (isLocalHost) {
      try {
        const r = await fetch("/api/status", { cache: "no-store" });
        if (r.ok) {
          const st = await r.json();
          if (st && st.can_refresh) canServerRefresh = true;
        }
      } catch (_) {
        canServerRefresh = false;
      }
    }
  }

  async function runLiveSync(silent = false) {
    if (!BASE_DATA || !window.LiveMarketEngine || liveSyncInFlight) return false;
    liveSyncInFlight = true;
    const btn = $("refreshBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "同步中…";
    }
    try {
      const updated = await window.LiveMarketEngine.syncLiveMarketData(BASE_DATA, PAGE_MODE);
      DATA = updated;
      renderAll(DATA);
      const ls = DATA.meta && DATA.meta.live_sync;
      if (!silent && ls && ls.ok) {
        showToast(`实时行情已同步（${ls.synced_at.slice(11)} · ${ls.synced_items.length}项直连）`);
      }
      return !!(ls && ls.ok);
    } catch (err) {
      if (!silent) showToast("实时拉取受限，已展示最新归档基线");
      return false;
    } finally {
      liveSyncInFlight = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = "↻ 实时刷新";
      }
    }
  }

  async function loadDashboard() {
    hideBanner();
    // 1. Fast first paint from static baseline (file:// or HTTP JSON)
    if (isFileMode && window.__DASHBOARD_DATA__) {
      BASE_DATA = window.__DASHBOARD_DATA__;
      DATA = BASE_DATA;
      renderAll(DATA);
      // Still attempt live browser sync when online!
      await runLiveSync(true);
      return;
    }
    try {
      const resp = await fetch("data/dashboard_data.json?t=" + Date.now(), { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      BASE_DATA = await resp.json();
      DATA = BASE_DATA;
      renderAll(DATA);
      // 2. Automatically sync real-time quotes, K-lines, and SMC live in browser on EVERY page open!
      await runLiveSync(true);
    } catch (err) {
      if (window.__DASHBOARD_DATA__) {
        BASE_DATA = window.__DASHBOARD_DATA__;
        DATA = BASE_DATA;
        renderAll(DATA);
        await runLiveSync(true);
        return;
      }
      const msg =
        "数据加载失败（" + err.message + "）。请先运行 python scripts/update_daily.py 生成数据文件。";
      showBanner(msg, true);
      $("metaLine").textContent = "数据未就绪";
    }
  }

  // Auto 60s polling toggle
  if ($("autoPollBtn")) {
    $("autoPollBtn").addEventListener("click", () => {
      const btn = $("autoPollBtn");
      if (autoPollTimer) {
        clearInterval(autoPollTimer);
        autoPollTimer = null;
        btn.classList.remove("active");
        btn.textContent = "⏱ 60s: 关";
        showToast("已关闭每 60 秒自动实时刷新");
      } else {
        autoPollTimer = setInterval(() => runLiveSync(true), 60000);
        btn.classList.add("active");
        btn.textContent = "⏱ 60s: 开";
        showToast("已开启每 60 秒自动实时刷新");
        runLiveSync(false);
      }
    });
  }

  // Share link button
  if ($("shareBtn")) {
    $("shareBtn").addEventListener("click", async () => {
      if (isFileMode) {
        showToast("当前为独立单文件网页，可直接转发给他人双击打开（联网自动实时更新）");
        return;
      }
      const shareUrl = location.href.split("#")[0];
      if (isLocalHost) {
        showToast("当前为本机预览地址；请分享公网 GitHub Pages 链接");
        return;
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(shareUrl);
        } else {
          const ta = document.createElement("textarea");
          ta.value = shareUrl;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        showToast("已复制分享链接：" + shareUrl);
      } catch (_) {
        showToast("请直接复制浏览器地址栏链接分享");
      }
    });
  }

  // Manual live refresh button: pulls live market feeds directly in browser in <1.5s!
  $("refreshBtn").addEventListener("click", async () => {
    if (BASE_DATA && window.LiveMarketEngine) {
      await runLiveSync(false);
      return;
    }
    await loadDashboard();
  });

  function renderAll(D) {
    // Clear previous chart registry
    while (allCharts.length) {
      const c = allCharts.pop();
      if (c && !c.isDisposed()) c.dispose();
    }

    if (PAGE_MODE === "market") {
      $("pageTitle").textContent = D.meta.title || "A股与大类资产每日投研监控看板";
    } else {
      $("pageTitle").textContent = "燕东微（688172.SH）每日技术分析看板";
    }
    const statusVals = Object.values(D.meta.status || {});
    const allOk = statusVals.every((s) => s.ok);
    const ls = D.meta.live_sync;
    if (ls && ls.ok) {
      $("metaLine").innerHTML =
        `<span class="status-dot live"></span>` +
        `实时直连：<b class="num">${ls.synced_at}</b>　|　最新行情：<b class="num">${D.meta.latest_market_date}</b>　|　每日 09:00 / 11:30 / 15:00 / 22:30 自动更新`;
    } else {
      $("metaLine").innerHTML =
        `<span class="status-dot ${allOk ? "" : "warn"}"></span>` +
        `基线：<b class="num">${D.meta.updated_at}</b>　|　最新行情：<b class="num">${D.meta.latest_market_date}</b>　|　每日 09:00 / 11:30 / 15:00 / 22:30 自动更新`;
    }

    if (!allOk) {
      const warns = statusVals.filter((s) => !s.ok).map((s) => s.note).join("；");
      showBanner("部分数据源存在降级或沿用缓存：" + warns, false);
    }

    if (PAGE_MODE === "yandongwei") {
      renderYandongwei(D.technical.yandongwei);
    } else {
      renderKpiStrip(D);
      renderMorningBriefing(D.morning_briefing);
      renderConvergence(D.convergence);
      renderNationalTeam(D.national_team);
      renderSingleTechSection("star50", D.technical.star50);
      renderSingleTechSection("cyb", D.technical.cyb);
      renderGold(D.technical);
    }
  }

  /* ==================== Top Overview KPI Strip (5 Market Modules) ==================== */
  function renderKpiStrip(D) {
    const cs = D.convergence.summary;
    const gs = D.national_team.summary;
    const t = D.technical;

    const cards = [
      {
        href: "#sec-convergence",
        accent: "#0f172a",
        title: "1. 300全收益 − 二级债基",
        tag: cs.is_currently_below ? "跌破区间" : "溢价区间",
        val: fmt(cs.spread_pct, 1, true) + " pct",
        valCls: cls(cs.spread_pct),
        subL: `300: ${fmt(cs.csi300_cum_pct, 1, true)}%`,
        subR: `历史跌破 ${cs.episode_count} 次`,
      },
      {
        href: "#sec-gjd",
        accent: "#2563eb",
        title: "2. 国家队监控ETF份额",
        tag: gs.latest_date,
        val: fmt(gs.total_shares_yi, 1) + " 亿份",
        valCls: "",
        subL: `当日净流 ${fmt(gs.flow_1d_yi, 1, true)}亿`,
        subR: `规模 ${fmt(gs.total_aum_yi, 0)}亿`,
        subCls: cls(gs.flow_1d_yi),
      },
      { ...makeTechKpi("#sec-star50", "3. 科创50", t.star50), accent: "#6d4aff" },
      { ...makeTechKpi("#sec-cyb", "4. 创业板指", t.cyb), accent: "#0d9488" },
      { ...makeTechKpi("#sec-gold", "5. 伦敦金现 XAU", t.gold_xau), accent: "#d97706" },
    ];

    $("kpiStrip").innerHTML = cards
      .map(
        (c) => `
      <a class="kpi-card" href="${c.href}" style="--accent:${c.accent}">
        <div class="k-head"><span>${c.title}</span><span class="num">${c.tag}</span></div>
        <div class="k-val num ${c.valCls}">${c.val}</div>
        <div class="k-sub">
          <span class="num ${c.subCls || ""}">${c.subL}</span>
          <span>${c.subR}</span>
        </div>
      </a>`
      )
      .join("");
  }

  /* ==================== 09:00 Morning Briefing (Wave + Channel) ==================== */
  function renderMorningBriefing(B) {
    const sec = $("sec-briefing");
    if (!sec) return;
    if (!B || !B.items || !B.items.length) {
      sec.style.display = "none";
      return;
    }
    sec.style.display = "";
    $("briefingEditionPill").textContent = `${B.edition_date} · 每日 09:00 自动生成`;
    $("briefingHeadline").textContent = B.headline || "";

    const biasBadge = (bias) => {
      if (bias === "bullish") return '<span class="badge bull">偏多信号</span>';
      if (bias === "bearish") return '<span class="badge bear">偏空/承压</span>';
      return '<span class="badge neutral">震荡观察</span>';
    };

    $("briefingGrid").innerHTML = B.items
      .map((it, idx) => {
        const isWide = idx < 2; // Top row: 2 macro cards; bottom row: 3 technical wave/channel cards
        const lv = it.key_levels || {};
        const chgHtml =
          it.change_pct != null
            ? `<span class="num ${cls(it.change_pct)}" style="font-size:12px;font-weight:700;">${fmt(it.change_pct, 2, true)}%</span>`
            : "";
        return `
        <div class="b-card ${isWide ? "wide" : ""}">
          <div class="b-card-head">
            <a class="b-card-title" href="${it.href}">
              <span class="b-num-dot">${it.index}</span>
              <span>${it.title}</span>
              <span class="code-tag num">${it.code}</span>
            </a>
            <div style="display:flex;align-items:center;gap:6px;">
              ${chgHtml}
              ${biasBadge(it.bias)}
            </div>
          </div>
          <div class="b-tags">
            <span class="b-tag"><b>${isWide ? "周期" : "波浪"}</b>${it.wave_stage}</span>
            <span class="b-tag"><b>${isWide ? "状态" : "通道"}</b>${it.channel_stage}</span>
          </div>
          <div class="b-levels num">
            <div><span>${isWide ? "基准/近期" : "下轨支撑"}</span><strong>${lv.support || "—"}</strong></div>
            <div><span>${isWide ? "核心读数" : "通道中轨"}</span><strong>${lv.mid || "—"}</strong></div>
            <div><span>${isWide ? "对比/规模" : "上轨压力"}</span><strong>${lv.resistance || "—"}</strong></div>
          </div>
          <div class="b-view">${it.view}</div>
        </div>`;
      })
      .join("");

    $("briefingFoot").innerHTML =
      `<span>简报生成时间：<b class="num">${B.generated_at}</b>（每日 09:00 自动刷新晨报；盘中图表仍实时直连更新）</span>` +
      `<span>方法论：自适应 ZigZag 波浪划分 + 60日线性回归通道 + 斐波那契关键位，仅供参考不构成投资建议</span>`;

    const copyBtn = $("copyBriefingBtn");
    if (copyBtn) {
      copyBtn.onclick = async () => {
        const txt = B.plain_text || B.headline || "";
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(txt);
          } else {
            const ta = document.createElement("textarea");
            ta.value = txt;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
          }
          showToast("已复制今日 09:00 晨间简报文本，可直接粘贴至微信/群聊");
        } catch (_) {
          showToast("复制失败，请手动选中复制");
        }
      };
    }

    const toggleBtn = $("toggleBriefingBtn");
    const bodyEl = $("briefingBody");
    if (toggleBtn && bodyEl) {
      toggleBtn.onclick = () => {
        const hidden = bodyEl.style.display === "none";
        bodyEl.style.display = hidden ? "" : "none";
        toggleBtn.textContent = hidden ? "收起" : "展开";
      };
    }
  }

  function makeTechKpi(href, label, item) {
    const s = item.summary;
    const d = item.meta.decimals;
    const tr = item.smc.swing_trend;
    const trTxt = tr === 1 ? "SMC偏多" : tr === -1 ? "SMC偏空" : "SMC震荡";
    return {
      href,
      title: label,
      tag: s.latest_date.slice(5),
      val: fmt(s.close, d),
      valCls: cls(s.change_pct),
      subL: `日涨跌 ${fmt(s.change_pct, 2, true)}%`,
      subR: trTxt,
      subCls: cls(s.change_pct),
    };
  }

  /* ==================== Module 1: Convergence ==================== */
  function renderConvergence(C) {
    const S = C.summary;
    $("convDateBadge").textContent = `最新交易日：${C.latest_date}（共 ${C.dates.length} 个交易日）`;
    $("convEpisodeHint").textContent =
      `红圈 = 300全收益跌破二级债基指数的时点（共 ${S.episode_count} 次）；灰带 = 处于跌破状态的区间`;

    $("convStats").innerHTML = [
      ["沪深300全收益累计", fmt(S.csi300_cum_pct, 1, true) + "%", `年化 ${fmt(S.csi300_cagr_pct, 2)}% · 波动率 ${fmt(S.csi300_vol_pct, 1)}%`, cls(S.csi300_cum_pct)],
      ["二级债基指数(重建)", fmt(S.bond2_cum_pct, 1, true) + "%", `年化 ${fmt(S.bond2_cagr_pct, 2)}% · 波动率 ${fmt(S.bond2_vol_pct, 1)}%`, ""],
      ["当前相对剪刀差", fmt(S.spread_pct, 1, true) + " pct", `300 / 二级债基净值比 ${fmt(S.ratio_300_to_bond2, 2)}x`, cls(S.spread_pct)],
      ["历史最大回撤对比", `${fmt(S.csi300_max_dd_pct, 1)}% / ${fmt(S.bond2_max_dd_pct, 1)}%`, `近1年波动率 ${fmt(S.csi300_vol_1y_pct, 1)}% vs ${fmt(S.bond2_vol_1y_pct, 1)}%`, ""],
      ["历史跌破次数", `${S.episode_count} 次`, `最近一次低点：${S.last_episode_date}`, S.is_currently_below ? "pos" : ""],
    ]
      .map(
        (x) =>
          `<div class="stat-box"><div class="sk">${x[0]}</div><div class="sv num ${x[3]}">${x[1]}</div><div class="sd num">${x[2]}</div></div>`
      )
      .join("");

    $("convEpisodes").innerHTML = C.episodes
      .map(
        (ep, i) =>
          `<span class="ep-chip num">#${i + 1} ${ep.trough_date}（300全收益 ${fmt(ep.trough_300_pct, 1, true)}%，较二级债基 ${fmt(ep.min_spread_pct, 1, true)}pct，持续${ep.trading_days}日）</span>`
      )
      .join("");

    $("convFootnote").innerHTML =
      `<b>数据口径</b>：纵轴为相对 <code>${C.base_date}</code> 的累计涨幅。${C.source_note}。中证基金指数最新归档日为 ${C.bond_latest_date}。`;

    let scaleMode = "linear";
    let showCsiBond = false;
    let showSpread = true;

    const chMain = registerChart($("chartConv"));
    const chSpread = registerChart($("chartConvSpread"));

    function draw() {
      const isLog = scaleMode === "log";
      const s300 = isLog ? C.csi300_tri_nav : C.csi300_tri_pct;
      const sb2 = isLog ? C.bond2_nav : C.bond2_pct;
      const scsi = isLog ? C.csi_bond_nav : C.csi_bond_pct;

      const bands = C.episodes.map((ep) => [{ xAxis: ep.start_date }, { xAxis: ep.end_date }]);
      const circles = C.episodes.map((ep, idx) => ({
        name: `第${idx + 1}次跌破`,
        value: [ep.trough_date, isLog ? ep.trough_300_nav : ep.trough_300_pct],
        ep,
      }));

      const series = [
        {
          name: "沪深300全收益",
          type: "line",
          data: s300,
          symbol: "none",
          lineStyle: { color: "#1e293b", width: 1.45 },
          itemStyle: { color: "#1e293b" },
          markArea: {
            silent: true,
            itemStyle: { color: "rgba(148, 163, 184, 0.22)" },
            data: bands,
          },
          z: 3,
        },
        {
          name: "二级债基指数（重建）",
          type: "line",
          data: sb2,
          symbol: "none",
          lineStyle: { color: COLORS.purple, width: 2.0 },
          itemStyle: { color: COLORS.purple },
          z: 4,
        },
        {
          name: "跌破时点",
          type: "scatter",
          data: circles,
          symbol: "circle",
          symbolSize: 16,
          itemStyle: {
            color: "rgba(217, 68, 66, 0.14)",
            borderColor: COLORS.red,
            borderWidth: 2,
          },
          z: 6,
        },
      ];

      if (showCsiBond) {
        series.push({
          name: "中证债基指数 H11023",
          type: "line",
          data: scsi,
          symbol: "none",
          lineStyle: { color: COLORS.teal, width: 1.4, type: "dashed" },
          itemStyle: { color: COLORS.teal },
          z: 2,
        });
      }

      chMain.setOption(
        {
          animationDuration: 300,
          tooltip: {
            trigger: "axis",
            axisPointer: { type: "cross" },
            formatter: (params) => {
              if (!params || !params.length) return "";
              const idx = params[0].dataIndex;
              const dt = C.dates[idx];
              const p300 = C.csi300_tri_pct[idx];
              const pb2 = C.bond2_pct[idx];
              const sp = C.spread_pct[idx];
              let html = `<div style="font-weight:700;margin-bottom:4px">${dt}</div>`;
              html += `<div>沪深300全收益：<b>${fmt(p300, 2, true)}%</b>（${fmt(C.csi300_tri_nav[idx], 2)}x）</div>`;
              html += `<div>二级债基(重建)：<b>${fmt(pb2, 2, true)}%</b>（${fmt(C.bond2_nav[idx], 2)}x）</div>`;
              if (showCsiBond) {
                html += `<div>中证债基 H11023：<b>${fmt(C.csi_bond_pct[idx], 2, true)}%</b></div>`;
              }
              html += `<div style="margin-top:3px;border-top:1px solid #eee;padding-top:3px">相对剪刀差：<b style="color:${sp < 0 ? COLORS.red : COLORS.ink}">${fmt(sp, 2, true)} pct</b>${sp < 0 ? "（处于跌破区间）" : ""}</div>`;
              return html;
            },
          },
          legend: {
            top: 0,
            right: 8,
            data: ["沪深300全收益", "二级债基指数（重建）", ...(showCsiBond ? ["中证债基指数 H11023"] : [])],
          },
          grid: { left: 16, right: 20, top: 34, bottom: 52, containLabel: true },
          xAxis: {
            type: "category",
            data: C.dates,
            boundaryGap: false,
            axisLabel: {
              fontSize: 11,
              color: COLORS.sub,
              formatter: (v) => v.slice(0, 4),
            },
            axisLine: { lineStyle: { color: "#cbd5e1" } },
          },
          yAxis: {
            type: isLog ? "log" : "value",
            logBase: 10,
            min: isLog ? 0.7 : undefined,
            splitLine: { lineStyle: { color: COLORS.grid } },
            axisLabel: {
              fontSize: 11,
              color: COLORS.sub,
              formatter: (v) => (isLog ? fmt((v - 1) * 100, 0, true) + "%" : fmt(v, 0) + "%"),
            },
          },
          dataZoom: [
            { type: "inside", start: 0, end: 100 },
            { type: "slider", height: 20, bottom: 8, start: 0, end: 100 },
          ],
          series,
        },
        true
      );

      $("chartConvSpread").style.display = showSpread ? "block" : "none";
      if (showSpread) {
        chSpread.setOption(
          {
            animationDuration: 250,
            tooltip: {
              trigger: "axis",
              valueFormatter: (v) => fmt(v, 2, true) + " pct",
            },
            grid: { left: 16, right: 20, top: 22, bottom: 24, containLabel: true },
            xAxis: {
              type: "category",
              data: C.dates,
              boundaryGap: false,
              axisLabel: { fontSize: 10.5, color: COLORS.sub, formatter: (v) => v.slice(0, 4) },
              axisLine: { lineStyle: { color: "#cbd5e1" } },
            },
            yAxis: {
              type: "value",
              name: "相对剪刀差(pct)",
              nameTextStyle: { fontSize: 11, color: COLORS.sub },
              splitLine: { lineStyle: { color: COLORS.grid } },
              axisLabel: { fontSize: 10.5, color: COLORS.sub },
            },
            series: [
              {
                name: "300全收益 − 二级债基",
                type: "line",
                data: C.spread_pct,
                symbol: "none",
                lineStyle: { width: 1.3, color: COLORS.blue },
                areaStyle: { color: "rgba(37, 99, 235, 0.08)" },
                markLine: {
                  silent: true,
                  symbol: "none",
                  lineStyle: { color: COLORS.red, type: "dashed", width: 1.2 },
                  label: { formatter: "0% 跌破线", position: "insideEndTop", color: COLORS.red, fontSize: 10.5 },
                  data: [{ yAxis: 0 }],
                },
              },
            ],
          },
          true
        );
        chSpread.resize();
      }
    }

    $("convScaleGroup").querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => {
        $("convScaleGroup").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        scaleMode = btn.dataset.scale;
        draw();
      };
    });
    $("toggleCsiBond").onclick = (e) => {
      showCsiBond = !showCsiBond;
      e.target.classList.toggle("active", showCsiBond);
      draw();
    };
    $("toggleSpreadChart").onclick = (e) => {
      showSpread = !showSpread;
      e.target.classList.toggle("active", showSpread);
      draw();
    };

    draw();
  }

  /* ==================== Module 2: National Team ETFs ==================== */
  function renderNationalTeam(G) {
    const S = G.summary;
    const dates = G.dates;
    const agg = G.aggregate;
    $("gjdDateBadge").textContent =
      `份额截至：${G.latest_date}（${S.etf_count}只宽基ETF${G.live_price_synced ? " · 价格/规模已实时直连" : G.sse_verified_date ? " · 上交所已核验" : ""}）`;

    $("gjdStats").innerHTML = [
      ["监控组合总份额", fmt(S.total_shares_yi, 2) + " 亿份", `较上日 ${fmt(S.d_total_shares_yi, 2, true)} 亿份`, cls(S.d_total_shares_yi)],
      ["监控组合总规模", fmt(S.total_aum_yi, 0) + " 亿元", `约占全A总市值 ${fmt(S.monitored_a_share_pct, 2)}%`, ""],
      ["当日估算净流入", fmt(S.flow_1d_yi, 2, true) + " 亿元", S.latest_date + " 全市场申赎估算", cls(S.flow_1d_yi)],
      ["近5日累计净流入", fmt(S.flow_5d_yi, 1, true) + " 亿元", "短期动向代理", cls(S.flow_5d_yi)],
      ["近20日累计净流入", fmt(S.flow_20d_yi, 1, true) + " 亿元", `区间累计 ${fmt(S.cum_flow_yi, 1, true)} 亿元`, cls(S.flow_20d_yi)],
    ]
      .map(
        (x) =>
          `<div class="stat-box"><div class="sk">${x[0]}</div><div class="sv num ${x[3]}">${x[1]}</div><div class="sd num">${x[2]}</div></div>`
      )
      .join("");

    let mode = "shares_flow";
    const chTotal = registerChart($("chartGjdTotal"));

    function drawTotal() {
      let opt;
      if (mode === "shares_flow") {
        opt = {
          tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
          legend: { top: 0, data: ["监控组合总份额(亿份)", "单日估算净流入(亿元)"] },
          grid: { left: 14, right: 16, top: 34, bottom: 48, containLabel: true },
          xAxis: { type: "category", data: dates, axisLabel: { fontSize: 11, color: COLORS.sub } },
          yAxis: [
            { type: "value", name: "亿份", scale: true, splitLine: { lineStyle: { color: COLORS.grid } }, axisLabel: { fontSize: 11 } },
            { type: "value", name: "净流入(亿元)", splitLine: { show: false }, axisLabel: { fontSize: 11 } },
          ],
          dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }],
          series: [
            {
              name: "监控组合总份额(亿份)",
              type: "line",
              data: agg.total_shares,
              symbol: "none",
              lineStyle: { color: COLORS.blue, width: 2.2 },
              areaStyle: { color: "rgba(37, 99, 235, 0.08)" },
            },
            {
              name: "单日估算净流入(亿元)",
              type: "bar",
              yAxisIndex: 1,
              data: agg.total_flow.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? COLORS.red : COLORS.green } })),
            },
          ],
        };
      } else if (mode === "cum_flow") {
        opt = {
          tooltip: { trigger: "axis", axisPointer: { type: "cross" }, valueFormatter: (v) => fmt(v, 2, true) + " 亿元" },
          legend: { top: 0, data: ["单日估算净流入(亿元)", "区间累计净流入(亿元)"] },
          grid: { left: 14, right: 16, top: 34, bottom: 48, containLabel: true },
          xAxis: { type: "category", data: dates, axisLabel: { fontSize: 11, color: COLORS.sub } },
          yAxis: [
            { type: "value", name: "单日(亿元)", splitLine: { lineStyle: { color: COLORS.grid } }, axisLabel: { fontSize: 11 } },
            { type: "value", name: "累计(亿元)", splitLine: { show: false }, axisLabel: { fontSize: 11 } },
          ],
          dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }],
          series: [
            {
              name: "单日估算净流入(亿元)",
              type: "bar",
              data: agg.total_flow.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? COLORS.red : COLORS.green } })),
            },
            {
              name: "区间累计净流入(亿元)",
              type: "line",
              yAxisIndex: 1,
              data: agg.cum_flow,
              symbol: "none",
              lineStyle: { color: COLORS.blue, width: 2.2 },
            },
          ],
        };
      } else {
        opt = {
          tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
          legend: { top: 0, data: ["占全A估算总市值比例(%)", "监控组合总规模(亿元)"] },
          grid: { left: 14, right: 16, top: 34, bottom: 48, containLabel: true },
          xAxis: { type: "category", data: dates, axisLabel: { fontSize: 11, color: COLORS.sub } },
          yAxis: [
            { type: "value", name: "占比(%)", scale: true, splitLine: { lineStyle: { color: COLORS.grid } }, axisLabel: { fontSize: 11, formatter: "{value}%" } },
            { type: "value", name: "规模(亿元)", scale: true, splitLine: { show: false }, axisLabel: { fontSize: 11 } },
          ],
          dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }],
          series: [
            {
              name: "占全A估算总市值比例(%)",
              type: "line",
              data: agg.est_a_share_pct,
              symbol: "none",
              lineStyle: { color: COLORS.purple, width: 2.2 },
            },
            {
              name: "监控组合总规模(亿元)",
              type: "line",
              yAxisIndex: 1,
              data: agg.total_aum,
              symbol: "none",
              lineStyle: { color: COLORS.sub, width: 1.5, type: "dashed" },
              areaStyle: { color: "rgba(100, 116, 139, 0.08)" },
            },
          ],
        };
      }
      chTotal.setOption(opt, true);
    }

    $("gjdModeGroup").querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => {
        $("gjdModeGroup").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        mode = btn.dataset.mode;
        drawTotal();
      };
    });
    drawTotal();

    // Single ETF selector chart
    const sel = $("gjdEtfSel");
    sel.innerHTML = G.etfs.map((e) => `<option value="${e.code}">${e.code} ${e.full}</option>`).join("");
    const chOne = registerChart($("chartGjdOne"));
    function drawOne(code) {
      const s = G.series[code] || { shares: [], flow: [] };
      chOne.setOption(
        {
          tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
          legend: { top: 0, data: ["份额(亿份)", "估算净流入(亿元)"] },
          grid: { left: 12, right: 28, top: 32, bottom: 42, containLabel: true },
          xAxis: { type: "category", data: dates, axisLabel: { fontSize: 10.5, color: COLORS.sub } },
          yAxis: [
            { type: "value", name: "亿份", scale: true, splitLine: { lineStyle: { color: COLORS.grid } }, axisLabel: { fontSize: 10.5 } },
            { type: "value", name: "亿元", splitLine: { show: false }, axisLabel: { fontSize: 10.5 } },
          ],
          dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 6 }],
          series: [
            {
              name: "份额(亿份)",
              type: "line",
              data: s.shares,
              symbol: "none",
              connectNulls: true,
              lineStyle: { color: COLORS.blue, width: 2 },
              areaStyle: { color: "rgba(37, 99, 235, 0.07)" },
            },
            {
              name: "估算净流入(亿元)",
              type: "bar",
              yAxisIndex: 1,
              data: (s.flow || []).map((v) => ({ value: v, itemStyle: { color: (v || 0) >= 0 ? COLORS.red : COLORS.green } })),
            },
          ],
        },
        true
      );
    }
    if (G.etfs.length) drawOne(G.etfs[0].code);
    sel.onchange = (e) => drawOne(e.target.value);

    // Futures chart (CITIC net short)
    const F = G.futures;
    if (F && F.latest && F.latest.date) {
      $("gjdFutBox").style.display = "";
      $("gjdFutTitle").textContent = (F.member || "中信期货") + "股指期货净空头走势";
      $("gjdFutDate").textContent = `中金所前20会员 · 截至 ${F.latest.date}`;
      const fdates = F.dates && F.dates.length ? F.dates : dates;
      const fcolors = { IH: COLORS.purple, IF: COLORS.blue, IC: COLORS.amber, IM: COLORS.teal };
      const chFut = registerChart($("chartGjdFut"));
      chFut.setOption({
        tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : Math.round(v).toLocaleString("zh-CN") + " 手") },
        legend: { top: 0, data: F.products.map((p) => p + " " + (F.names[p] || "")) },
        grid: { left: 12, right: 28, top: 32, bottom: 42, containLabel: true },
        xAxis: { type: "category", data: fdates, axisLabel: { fontSize: 10.5, color: COLORS.sub } },
        yAxis: { type: "value", name: "净空头(手)", splitLine: { lineStyle: { color: COLORS.grid } }, axisLabel: { fontSize: 10.5 } },
        dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 6 }],
        series: F.products.map((p) => ({
          name: p + " " + (F.names[p] || ""),
          type: "line",
          symbol: "none",
          connectNulls: true,
          lineStyle: { width: 2, color: fcolors[p] || COLORS.ink },
          itemStyle: { color: fcolors[p] || COLORS.ink },
          data: F.series[p].net_short,
        })),
      });
    } else {
      $("gjdFutBox").style.display = "none";
    }

    // Sortable ETF table
    let sortK = "flow1";
    let asc = false;
    function drawTable() {
      const rs = [...G.rows].sort((a, b) => {
        let x = a[sortK];
        let y = b[sortK];
        if (typeof x === "string") return asc ? x.localeCompare(y) : y.localeCompare(x);
        x = x == null ? -Infinity : x;
        y = y == null ? -Infinity : y;
        return asc ? x - y : y - x;
      });
      $("gjdTable").querySelector("tbody").innerHTML = rs
        .map(
          (r) => `<tr>
          <td class="l">${r.code}</td>
          <td class="l" title="${r.full}">${r.full}</td>
          <td class="l">${r.index}</td>
          <td>${fmt(r.shares, 2)}</td>
          <td class="${cls(r.d_shares)}">${fmt(r.d_shares, 2, true)}</td>
          <td class="${cls(r.flow1)}">${fmt(r.flow1, 2, true)}</td>
          <td class="${cls(r.flow5)}">${fmt(r.flow5, 1, true)}</td>
          <td class="${cls(r.flow20)}">${fmt(r.flow20, 1, true)}</td>
          <td>${fmt(r.close, 3)}</td>
          <td class="l" style="white-space:normal;max-width:260px;color:var(--sub)">${r.note}</td>
        </tr>`
        )
        .join("");

      const sumShares = G.rows.reduce((a, r) => a + (r.shares || 0), 0);
      const sumDShares = G.rows.reduce((a, r) => a + (r.d_shares || 0), 0);
      $("gjdTable").querySelector("tfoot").innerHTML = `<tr>
        <td class="l" colspan="3">监控组合合计（${G.rows.length} 只宽基ETF）</td>
        <td>${fmt(sumShares, 2)}</td>
        <td class="${cls(sumDShares)}">${fmt(sumDShares, 2, true)}</td>
        <td class="${cls(S.flow_1d_yi)}">${fmt(S.flow_1d_yi, 2, true)}</td>
        <td class="${cls(S.flow_5d_yi)}">${fmt(S.flow_5d_yi, 1, true)}</td>
        <td class="${cls(S.flow_20d_yi)}">${fmt(S.flow_20d_yi, 1, true)}</td>
        <td></td><td></td>
      </tr>`;
    }
    drawTable();
    $("gjdTable").querySelectorAll("th").forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.k;
        if (!k) return;
        asc = k === sortK ? !asc : false;
        sortK = k;
        drawTable();
      };
    });

    // Baseline table
    const B = G.baseline;
    if (B && B.holders) {
      $("gjdBaseTable").querySelector("tbody").innerHTML =
        B.holders
          .map(
            (h) => `<tr>
          <td class="l">${h.name}</td>
          <td>${h.etf_count}</td>
          <td>${fmt(h.shares_yi, 0)}</td>
          <td>${fmt(h.value_yi, 0)}</td>
          <td>${h.avg_pct != null ? fmt(h.avg_pct, 1) + "%" : "—"}</td>
        </tr>`
          )
          .join("") +
        `<tr><td class="l"><b>官方定期报告合计</b></td><td></td><td></td><td><b>${fmt(B.total_value_yi, 0)}</b></td><td></td></tr>`;
      $("gjdBaseNote").textContent = `${B.asof} · 来源：${B.source}。${B.note}`;
    }

    $("gjdFootnote").innerHTML =
      `<b>数据口径</b>：${G.source_note}。当日估算净流入 = 份额变动 × 当日均价，反映全市场一级申赎合计结果（汇金系为主要持有人，但单日变动不能全部归因于国家队）；占全A市值比基于全A估算总市值 ${fmt(S.a_share_total_mcap_yi / 10000, 1)} 万亿元测算，仅作宏观水位参考。`;
  }

  /* ==================== Reusable Technical + SMC Engine ==================== */
  function createTechToolbar(containerEl, state, onChange) {
    containerEl.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;">
        <div class="btn-group" data-role="range">
          <button data-bars="65" class="${state.bars === 65 ? "active" : ""}">近3月</button>
          <button data-bars="130" class="${state.bars === 130 ? "active" : ""}">近6月</button>
          <button data-bars="250" class="${state.bars === 250 ? "active" : ""}">近1年</button>
          <button data-bars="0" class="${state.bars === 0 ? "active" : ""}">全部</button>
        </div>
        <div class="btn-group" data-role="sub">
          <button data-sub="macd" class="${state.sub === "macd" ? "active" : ""}">副图: MACD</button>
          <button data-sub="rsi" class="${state.sub === "rsi" ? "active" : ""}">副图: RSI(14)</button>
        </div>
      </div>
      <div class="toggle-pills" data-role="layers">
        <button type="button" class="pill ${state.ma ? "active" : ""}" data-layer="ma">MA均线</button>
        <button type="button" class="pill ${state.boll ? "active" : ""}" data-layer="boll">BOLL</button>
        <button type="button" class="pill accent-wave ${state.wave ? "active" : ""}" data-layer="wave">波浪 ZigZag</button>
        <button type="button" class="pill accent-chan ${state.channel ? "active" : ""}" data-layer="channel">趋势通道</button>
        <button type="button" class="pill ${state.structure ? "active" : ""}" data-layer="structure">SMC结构</button>
        <button type="button" class="pill ${state.ob ? "active" : ""}" data-layer="ob">订单块 OB</button>
        <button type="button" class="pill ${state.fvg ? "active" : ""}" data-layer="fvg">FVG</button>
        <button type="button" class="pill ${state.pd ? "active" : ""}" data-layer="pd">折溢价 P/D</button>
        <button type="button" class="pill ${state.eq ? "active" : ""}" data-layer="eq">EQH/EQL</button>
      </div>
    `;

    containerEl.querySelectorAll('[data-role="range"] button').forEach((b) => {
      b.onclick = () => {
        containerEl.querySelectorAll('[data-role="range"] button').forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        state.bars = Number(b.dataset.bars);
        onChange();
      };
    });
    containerEl.querySelectorAll('[data-role="sub"] button').forEach((b) => {
      b.onclick = () => {
        containerEl.querySelectorAll('[data-role="sub"] button').forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        state.sub = b.dataset.sub;
        onChange();
      };
    });
    containerEl.querySelectorAll('[data-role="layers"] button').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.layer;
        state[k] = !state[k];
        b.classList.toggle("active", state[k]);
        onChange();
      };
    });
  }

  function renderTechHeader(el, item) {
    const m = item.meta;
    const s = item.summary;
    el.innerHTML = `
      <h3>
        <span>${m.title}</span>
        <span class="code-tag num">${m.display_code}</span>
        <span class="num ${cls(s.change_pct)}" style="font-size:16px;">${fmt(s.close, m.decimals)} ${m.price_unit}</span>
        <span class="num ${cls(s.change_pct)}" style="font-size:13px;">(${fmt(s.change_pct, 2, true)}%)</span>
      </h3>
      <span class="code-tag num">${s.latest_date} · ${m.source}</span>
    `;
  }

  function renderSmcRibbon(el, item) {
    const s = item.summary;
    const smc = item.smc;
    const z = smc.zones;
    const d = item.meta.decimals;
    const lastSw = smc.last_swing_event
      ? `${smc.last_swing_event.bias === "bullish" ? "多头" : "空头"}${smc.last_swing_event.kind} @ ${fmt(smc.last_swing_event.price, d)} (${smc.last_swing_event.break_date.slice(5)})`
      : "—";
    const ch = item.channel;
    const chChip = ch
      ? `<span class="smc-item num"><span class="lbl">60日通道:</span> <b>${ch.direction}</b> (${fmt(ch.pos_pct, 0)}%)</span>`
      : "";
    el.innerHTML = `
      <span class="smc-item"><span class="lbl">波段结构:</span> ${trendBadge(smc.swing_trend)}</span>
      <span class="smc-item"><span class="lbl">内部结构:</span> ${trendBadge(smc.internal_trend)}</span>
      ${chChip}
      <span class="smc-item num"><span class="lbl">${z.swing_high_role.split(" ")[0]} High:</span> <b>${fmt(z.swing_high, d)}</b></span>
      <span class="smc-item num"><span class="lbl">${z.swing_low_role.split(" ")[0]} Low:</span> <b>${fmt(z.swing_low, d)}</b></span>
      <span class="smc-item num"><span class="lbl">区间位置:</span> <b>${fmt(z.current_pos_pct, 1)}%</b>（${z.zone_label.split(" ")[0]}）</span>
      <span class="smc-item num"><span class="lbl">活跃OB:</span> ${s.active_bull_ob_count}多 / ${s.active_bear_ob_count}空</span>
      <span class="smc-item num"><span class="lbl">未补FVG:</span> ${s.active_fvg_count}</span>
      <span class="smc-item num"><span class="lbl">最近波段:</span> ${lastSw}</span>
      <span class="smc-item num"><span class="lbl">RSI14:</span> <b>${fmt(s.rsi14, 1)}</b></span>
      <span class="smc-item num"><span class="lbl">20日涨跌:</span> <b class="${cls(s.ret_20d)}">${fmt(s.ret_20d, 1, true)}%</b></span>
    `;
  }

  function drawTechChart(chart, item, state) {
    const m = item.meta;
    const dates = item.dates;
    const ohlc = item.ohlc;
    const ind = item.indicators;
    const smc = item.smc;
    const n = dates.length;
    const d = m.decimals;

    const startPct = state.bars > 0 && n > state.bars ? Math.max(0, ((n - state.bars) / n) * 100) : 0;
    const lastDate = dates[n - 1];

    // Build markLine & markArea on the candlestick series
    const markLines = [];
    const markAreas = [];

    if (state.structure) {
      // Swing structure lines (solid)
      smc.swing_events.forEach((ev) => {
        const col = ev.bias === "bullish" ? COLORS.red : COLORS.green;
        markLines.push([
          {
            coord: [ev.pivot_date, ev.price],
            lineStyle: { color: col, width: 1.5, type: "solid" },
            label: {
              show: true,
              formatter: ev.kind,
              position: "middle",
              color: col,
              fontSize: 10,
              fontWeight: 700,
              backgroundColor: "rgba(255,255,255,0.78)",
              padding: [1, 3],
              borderRadius: 2,
            },
          },
          { coord: [ev.break_date, ev.price] },
        ]);
      });

      // Internal structure lines (dashed, keep recent 16 to avoid visual clutter)
      smc.internal_events.slice(-16).forEach((ev) => {
        const col = ev.bias === "bullish" ? "rgba(217,68,66,0.68)" : "rgba(29,154,99,0.68)";
        markLines.push([
          {
            coord: [ev.pivot_date, ev.price],
            lineStyle: { color: col, width: 1.0, type: "dashed" },
            label: {
              show: true,
              formatter: "i-" + ev.kind,
              position: "middle",
              color: col,
              fontSize: 9,
            },
          },
          { coord: [ev.break_date, ev.price] },
        ]);
      });
    }

    if (state.ob) {
      smc.active_order_blocks.forEach((ob) => {
        const isBull = ob.bias === "bullish";
        const isSwing = ob.layer === "swing";
        markAreas.push([
          {
            xAxis: ob.start_date,
            yAxis: ob.bottom,
            name: isBull ? "多OB" : "空OB",
            itemStyle: {
              color: isBull
                ? isSwing
                  ? "rgba(37, 99, 235, 0.13)"
                  : "rgba(37, 99, 235, 0.06)"
                : isSwing
                ? "rgba(217, 68, 66, 0.13)"
                : "rgba(217, 68, 66, 0.06)",
              borderColor: isBull ? "rgba(37, 99, 235, 0.42)" : "rgba(217, 68, 66, 0.42)",
              borderWidth: isSwing ? 1 : 0.7,
              borderType: isSwing ? "solid" : "dashed",
            },
            label: {
              show: isSwing,
              position: "insideRight",
              color: isBull ? COLORS.blue : COLORS.red,
              fontSize: 9.5,
            },
          },
          { xAxis: lastDate, yAxis: ob.top },
        ]);
      });
    }

    if (state.fvg) {
      const fvgTotal = smc.active_fvgs.length;
      smc.active_fvgs.forEach((g, idx) => {
        const isBull = g.bias === "bullish";
        markAreas.push([
          {
            xAxis: g.start_date,
            yAxis: g.bottom,
            name: isBull ? "FVG↑" : "FVG↓",
            itemStyle: {
              color: isBull ? "rgba(13, 148, 136, 0.15)" : "rgba(217, 119, 6, 0.15)",
              borderColor: isBull ? "rgba(13, 148, 136, 0.48)" : "rgba(217, 119, 6, 0.48)",
              borderWidth: 0.8,
            },
            label: {
              show: idx >= fvgTotal - 2,
              position: "insideRight",
              color: isBull ? COLORS.teal : COLORS.amber,
              fontSize: 9,
            },
          },
          { xAxis: lastDate, yAxis: g.top },
        ]);
      });
    }

    if (state.pd && smc.zones) {
      const z = smc.zones;
      const startD = z.start_date;
      const pushZoneLine = (yVal, lbl, col, type = "dotted") => {
        markLines.push([
          {
            coord: [startD, yVal],
            lineStyle: { color: col, width: 1.1, type },
            label: { show: true, formatter: `${lbl} ${fmt(yVal, d)}`, position: "end", color: col, fontSize: 10 },
          },
          { coord: [lastDate, yVal] },
        ]);
      };
      pushZoneLine(z.swing_high, z.swing_high_role.split(" ")[0] + " H", COLORS.red, "dashed");
      pushZoneLine(z.equilibrium, "EQ 50%", COLORS.purple, "dotted");
      pushZoneLine(z.swing_low, z.swing_low_role.split(" ")[0] + " L", COLORS.green, "dashed");
    }

    if (state.eq && smc.eq_levels) {
      smc.eq_levels.forEach((lv) => {
        markLines.push([
          {
            coord: [lv.start_date, lv.price],
            lineStyle: { color: COLORS.amber, width: 1.2, type: "dotted" },
            label: { show: true, formatter: lv.type, position: "middle", color: COLORS.amber, fontSize: 9.5, fontWeight: 700 },
          },
          { coord: [lv.end_date, lv.price] },
        ]);
      });
    }

    // 60-day Linear Regression Channel overlay (通道理论)
    if (state.channel && item.channel && item.channel.lines) {
      const ln = item.channel.lines;
      const addRail = (vals, lbl, type, width) => {
        markLines.push([
          {
            coord: [ln.start_date, vals[0]],
            lineStyle: { color: COLORS.purple, width, type, opacity: 0.78 },
            label: { show: true, formatter: lbl, position: "end", color: COLORS.purple, fontSize: 9.5 },
          },
          { coord: [ln.end_date, vals[1]] },
        ]);
      };
      addRail(ln.upper, "上轨", "dashed", 1.35);
      addRail(ln.mid, "中轨", "dotted", 1.1);
      addRail(ln.lower, "下轨", "dashed", 1.35);
    }

    // Elliott Wave ZigZag overlay (波浪理论)
    const wavePivots = state.wave && item.wave && Array.isArray(item.wave.pivots) ? item.wave.pivots : [];
    if (wavePivots.length >= 2) {
      for (let i = 0; i < wavePivots.length - 1; i++) {
        const a = wavePivots[i];
        const b = wavePivots[i + 1];
        markLines.push([
          {
            coord: [a.date, a.price],
            lineStyle: { color: "#d97706", width: 1.9, type: b.developing ? "dashed" : "solid" },
            label: { show: false },
          },
          { coord: [b.date, b.price] },
        ]);
      }
    }

    // Volume display scaling (especially important for 科创板 where unit is 股!)
    const hasVol = item.volumes && item.volumes.some((v) => v != null && v > 0);
    let volDiv = 1;
    let volLabel = m.volume_unit || "量";
    if (hasVol) {
      const maxV = Math.max(...item.volumes.map((v) => v || 0));
      if (maxV >= 1e8) {
        volDiv = 1e8;
        volLabel = "亿" + (m.volume_unit || "");
      } else if (maxV >= 1e4) {
        volDiv = 1e4;
        volLabel = "万" + (m.volume_unit || "");
      }
    }
    const volSeriesData = dates.map((_, i) => {
      const v = item.volumes[i];
      if (v == null) return null;
      const up = ohlc[i][1] >= ohlc[i][0];
      return {
        value: +(v / volDiv).toFixed(2),
        itemStyle: { color: up ? "rgba(217, 68, 66, 0.55)" : "rgba(29, 154, 99, 0.55)" },
      };
    });

    const series = [
      {
        name: "日K",
        type: "candlestick",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: ohlc,
        itemStyle: {
          color: COLORS.red,
          color0: COLORS.green,
          borderColor: COLORS.red,
          borderColor0: COLORS.green,
        },
        markLine: {
          silent: true,
          symbol: ["none", "none"],
          animation: false,
          data: markLines,
        },
        markArea: {
          silent: true,
          animation: false,
          data: markAreas,
        },
      },
    ];

    if (state.ma) {
      const maDefs = [
        ["MA5", ind.ma5, "#f59e0b"],
        ["MA20", ind.ma20, "#2563eb"],
        ["MA60", ind.ma60, "#8b5cf6"],
        ["MA120", ind.ma120, "#64748b"],
      ];
      maDefs.forEach(([name, arr, color]) => {
        series.push({
          name,
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: arr,
          symbol: "none",
          smooth: false,
          lineStyle: { width: 1.2, color },
          itemStyle: { color },
        });
      });
    }

    if (state.boll) {
      [
        ["BOLL上", ind.boll.up, "#94a3b8", "dashed"],
        ["BOLL中", ind.boll.mid, "#475569", "dotted"],
        ["BOLL下", ind.boll.dn, "#94a3b8", "dashed"],
      ].forEach(([name, arr, color, type]) => {
        series.push({
          name,
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: arr,
          symbol: "none",
          lineStyle: { width: 1.1, color, type },
          itemStyle: { color },
        });
      });
    }

    if (wavePivots.length >= 2) {
      series.push({
        name: "波浪拐点",
        type: "scatter",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: wavePivots
          .filter((p) => p.label)
          .map((p) => ({
            value: [p.date, p.price],
            name: p.label,
          })),
        symbol: "circle",
        symbolSize: 18,
        itemStyle: { color: "#fff7ed", borderColor: "#d97706", borderWidth: 1.6 },
        label: {
          show: true,
          formatter: (p) => p.data.name,
          color: "#b45309",
          fontSize: 10,
          fontWeight: 700,
        },
        z: 8,
      });
    }

    // Volume series on grid 1
    series.push({
      name: `成交量(${volLabel})`,
      type: "bar",
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: volSeriesData,
    });

    // Sub indicator on grid 2
    if (state.sub === "macd") {
      series.push(
        {
          name: "MACD柱",
          type: "bar",
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: ind.macd.hist.map((v) => ({
            value: v,
            itemStyle: { color: (v || 0) >= 0 ? "rgba(217, 68, 66, 0.68)" : "rgba(29, 154, 99, 0.68)" },
          })),
        },
        {
          name: "DIF",
          type: "line",
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: ind.macd.dif,
          symbol: "none",
          lineStyle: { width: 1.25, color: COLORS.blue },
          itemStyle: { color: COLORS.blue },
        },
        {
          name: "DEA",
          type: "line",
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: ind.macd.dea,
          symbol: "none",
          lineStyle: { width: 1.25, color: COLORS.amber },
          itemStyle: { color: COLORS.amber },
        }
      );
    } else {
      series.push({
        name: "RSI(14)",
        type: "line",
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: ind.rsi14,
        symbol: "none",
        lineStyle: { width: 1.4, color: COLORS.purple },
        itemStyle: { color: COLORS.purple },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { type: "dashed", color: "#94a3b8", width: 1 },
          data: [{ yAxis: 70 }, { yAxis: 50 }, { yAxis: 30 }],
        },
      });
    }

    chart.setOption(
      {
        animation: false,
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "cross" },
          formatter: (params) => {
            if (!params || !params.length) return "";
            const idx = params[0].dataIndex;
            const dt = dates[idx];
            const k = ohlc[idx];
            const prevC = idx > 0 ? ohlc[idx - 1][1] : k[0];
            const chg = prevC ? ((k[1] / prevC) - 1) * 100 : 0;
            let html = `<div style="font-weight:700;margin-bottom:4px">${dt} · ${m.title}</div>`;
            html += `<div>开 <b>${fmt(k[0], d)}</b>　高 <b>${fmt(k[3], d)}</b>　低 <b>${fmt(k[2], d)}</b>　收 <b style="color:${chg >= 0 ? COLORS.red : COLORS.green}">${fmt(k[1], d)} (${fmt(chg, 2, true)}%)</b></div>`;
            if (hasVol && item.volumes[idx] != null) {
              html += `<div>成交量：<b>${fmt(item.volumes[idx] / volDiv, 2)} ${volLabel}</b></div>`;
            }
            if (state.ma) {
              html += `<div style="font-size:11.5px;color:#555">MA5:${fmt(ind.ma5[idx], d)} / MA20:${fmt(ind.ma20[idx], d)} / MA60:${fmt(ind.ma60[idx], d)}</div>`;
            }
            if (state.sub === "macd") {
              html += `<div style="font-size:11.5px;color:#555">MACD DIF:${fmt(ind.macd.dif[idx], 3)} DEA:${fmt(ind.macd.dea[idx], 3)} 柱:${fmt(ind.macd.hist[idx], 3)}</div>`;
            } else {
              html += `<div style="font-size:11.5px;color:#555">RSI(14)：<b>${fmt(ind.rsi14[idx], 2)}</b></div>`;
            }
            return html;
          },
        },
        axisPointer: { link: [{ xAxisIndex: "all" }] },
        legend: {
          top: 0,
          left: 6,
          itemWidth: 12,
          itemHeight: 8,
          textStyle: { fontSize: 11 },
          data: [
            "日K",
            ...(state.ma ? ["MA5", "MA20", "MA60", "MA120"] : []),
            ...(state.boll ? ["BOLL上", "BOLL中", "BOLL下"] : []),
            ...(state.sub === "macd" ? ["DIF", "DEA"] : ["RSI(14)"]),
          ],
        },
        grid: [
          { left: 68, right: 112, top: 30, height: "48%" },
          { left: 68, right: 112, top: "60%", height: "12%" },
          { left: 68, right: 112, top: "77%", height: "14%" },
        ],
        xAxis: [
          { type: "category", gridIndex: 0, data: dates, boundaryGap: true, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: "#cbd5e1" } } },
          { type: "category", gridIndex: 1, data: dates, boundaryGap: true, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: "#cbd5e1" } } },
          { type: "category", gridIndex: 2, data: dates, boundaryGap: true, axisLabel: { fontSize: 10.5, color: COLORS.sub }, axisLine: { lineStyle: { color: "#cbd5e1" } } },
        ],
        yAxis: [
          {
            type: "value",
            gridIndex: 0,
            scale: true,
            splitLine: { lineStyle: { color: COLORS.grid } },
            axisLabel: { fontSize: 10.5, color: COLORS.sub },
          },
          {
            type: "value",
            gridIndex: 1,
            scale: true,
            splitNumber: 2,
            name: hasVol ? volLabel : "无量",
            nameLocation: "middle",
            nameGap: 48,
            nameTextStyle: { fontSize: 10, color: COLORS.sub },
            splitLine: { show: false },
            axisLabel: { fontSize: 10, color: COLORS.sub },
          },
          {
            type: "value",
            gridIndex: 2,
            scale: state.sub === "macd",
            min: state.sub === "rsi" ? 10 : undefined,
            max: state.sub === "rsi" ? 90 : undefined,
            splitNumber: 2,
            name: state.sub === "macd" ? "MACD" : "RSI",
            nameLocation: "middle",
            nameGap: 48,
            nameTextStyle: { fontSize: 10, color: COLORS.sub },
            splitLine: { lineStyle: { color: COLORS.grid } },
            axisLabel: { fontSize: 10, color: COLORS.sub },
          },
        ],
        dataZoom: [
          { type: "inside", xAxisIndex: [0, 1, 2], start: startPct, end: 100 },
          { type: "slider", xAxisIndex: [0, 1, 2], height: 16, bottom: 4, start: startPct, end: 100 },
        ],
        series,
      },
      true
    );
  }

  /* ==================== Modules 3 & 4: Dedicated STAR 50 / ChiNext 50 ==================== */
  function renderSingleTechSection(key, item) {
    const m = item.meta;
    const s = item.summary;
    const badgeEl = $(key + "DateBadge");
    if (badgeEl) badgeEl.textContent = `最新交易日：${s.latest_date}（共 ${m.bar_count} 根日K）`;

    const state = { bars: 130, sub: "macd", ma: true, boll: false, wave: true, channel: true, structure: true, ob: true, fvg: false, pd: true, eq: false };
    const ch = registerChart($("chart-" + key));

    renderTechHeader($("head-" + key), item);
    renderSmcRibbon($("ribbon-" + key), item);

    const redraw = () => drawTechChart(ch, item, state);
    createTechToolbar($(key + "Toolbar"), state, redraw);
    redraw();

    const footEl = $(key + "Footnote");
    if (footEl) {
      footEl.innerHTML =
        `<b>${m.title}（${m.display_code}）图例与口径</b>：日K来自腾讯财经免Key三入口轮换（${m.date_range[0]} 至 ${m.date_range[1]}，成交量单位：${m.volume_unit}）。SMC 实线为波段结构（L=10），虚线为内部结构（L=3），按收盘价突破判定 BOS/CHoCH；订单块 OB 按 High/Low 触碰失效移除。指数无实际委托簿，结构标记仅反映历史价格形态。`;
    }
  }

  /* ==================== Module 5: Gold (伦敦金现 / 黄金股ETF / 黄金ETF) ==================== */
  function renderGold(T) {
    let activeKey = "gold_xau";
    const state = { bars: 130, sub: "macd", ma: true, boll: false, wave: true, channel: true, structure: true, ob: true, fvg: false, pd: true, eq: false };
    const chGold = registerChart($("chart-gold"));

    function redraw() {
      const item = T[activeKey];
      if (!item) return;
      renderTechHeader($("head-gold"), item);
      renderSmcRibbon($("ribbon-gold"), item);
      drawTechChart(chGold, item, state);
      const extraNote =
        activeKey === "gold_xau"
          ? "伦敦金现（XAU/USD）日K来自新浪外盘现货接口并实时叠加盘中最新报价，单位美元/盎司；国际现货无统一场内成交量列。"
          : activeKey === "gold_stock_etf"
          ? "黄金股ETF（永赢中证沪深港黄金产业股票ETF，517520.SH）来自腾讯财经前复权日K与实时行情，反映A/H黄金开采与冶炼产业链龙头弹性。"
          : "黄金ETF（华安黄金ETF，518880.SH）来自腾讯财经前复权日K与实时行情，紧密跟踪国内现货黄金价格。";
      $("goldFootnote").innerHTML = `<b>黄金数据口径</b>：${extraNote} 当前标的区间：${item.meta.date_range[0]} 至 ${item.meta.date_range[1]}（共 ${item.meta.bar_count} 根日K）。`;
    }

    createTechToolbar($("goldToolbar"), state, redraw);
    $("goldSymbolGroup").querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => {
        $("goldSymbolGroup").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        activeKey = btn.dataset.key;
        redraw();
      };
    });
    redraw();
  }

  /* ==================== Module 5: Yandongwei (688172) ==================== */
  function renderYandongwei(item) {
    const s = item.summary;
    const q = item.quote || {};
    const m = item.meta;

    $("ydwDateBadge").textContent = `最新交易日：${s.latest_date}（前复权日K · 科创板）`;

    $("ydwQuoteStats").innerHTML = [
      ["最新收盘价", fmt(s.close, 2) + " 元", `日涨跌 ${fmt(s.change_pct, 2, true)}% · 振幅 ${fmt(q.amplitude_pct, 2)}%`, cls(s.change_pct)],
      ["总市值 / 流通市值", `${fmt(q.mcap_yi, 1)} / ${fmt(q.float_mcap_yi, 1)} 亿`, "腾讯校准口径 f[45] / f[44]", ""],
      ["市净率 PB / PE(TTM)", `${fmt(q.pb, 2)}x / ${fmt(q.pe_ttm, 1)}x`, "PB=f[46]（非f[43]振幅）", ""],
      ["换手率 / 成交额", `${fmt(q.turnover_pct, 2)}% / ${fmt((q.amount_wan || 0) / 10000, 2)} 亿`, "成交量单位：股（万股）", ""],
      ["阶段涨跌幅", `5日 ${fmt(s.ret_5d, 1, true)}%`, `20日 ${fmt(s.ret_20d, 1, true)}% · 60日 ${fmt(s.ret_60d, 1, true)}%`, cls(s.ret_5d)],
    ]
      .map(
        (x) =>
          `<div class="stat-box"><div class="sk">${x[0]}</div><div class="sv num ${x[3]}">${x[1]}</div><div class="sd num">${x[2]}</div></div>`
      )
      .join("");

    renderSmcRibbon($("ribbon-ydw"), item);

    const state = { bars: 130, sub: "macd", ma: true, boll: false, wave: true, channel: true, structure: true, ob: true, fvg: false, pd: true, eq: false };
    const chYdw = registerChart($("chart-ydw"));
    const redraw = () => drawTechChart(chYdw, item, state);
    createTechToolbar($("ydwToolbar"), state, redraw);
    redraw();

    $("ydwFootnote").innerHTML =
      `<b>燕东微（688172.SH）口径说明</b>：日K来自腾讯财经前复权（${m.date_range[0]} 至 ${m.date_range[1]}，共 ${m.bar_count} 根）。严格遵循 <code>a-stock-data V3.10.1</code> 校验规则：<b>科创板（688/689）腾讯K线成交量原始单位为「股」</b>（图表自动换算为「万股」），避免按主板「手」误算放大100倍；市值严格区分总市值 <code>f[45]</code> 与流通市值 <code>f[44]</code>。`;

    // Render standalone Yandongwei SMC detail tables if present
    const zTbl = $("ydwZonesTable");
    if (zTbl) {
      const obs = (item.smc.active_order_blocks || []).map((ob) => ({
        type: "订单块 OB",
        dir: (ob.layer === "swing" ? "波段" : "内部") + " · " + (ob.bias === "bullish" ? "多头" : "空头"),
        bias: ob.bias,
        bot: ob.bottom,
        top: ob.top,
        start: ob.start_date,
        created: ob.created_date,
      }));
      const fvgs = (item.smc.active_fvgs || []).map((g) => ({
        type: "公允缺口 FVG",
        dir: g.bias === "bullish" ? "上行缺口 ↑" : "下行缺口 ↓",
        bias: g.bias,
        bot: g.bottom,
        top: g.top,
        start: g.start_date,
        created: g.created_date,
      }));
      const rows = [...obs, ...fvgs].sort((a, b) => (b.created || "").localeCompare(a.created || ""));
      zTbl.querySelector("tbody").innerHTML = rows.length
        ? rows
            .map(
              (r) => `<tr>
              <td class="l"><b>${r.type}</b></td>
              <td class="l"><span class="badge ${r.bias === "bullish" ? "bull" : "bear"}">${r.dir}</span></td>
              <td>${fmt(r.bot, m.decimals)}</td>
              <td>${fmt(r.top, m.decimals)}</td>
              <td>${r.start}</td>
              <td>${r.created}</td>
            </tr>`
            )
            .join("")
        : '<tr><td colspan="6" class="l" style="color:var(--sub)">当前无活跃未失效的 OB 或 FVG 区间</td></tr>';
    }

    const eTbl = $("ydwEventsTable");
    if (eTbl) {
      const evts = [
        ...(item.smc.swing_events || []).map((e) => ({ ...e, layerCn: "波段 (L=10)" })),
        ...(item.smc.internal_events || []).slice(-10).map((e) => ({ ...e, layerCn: "内部 (L=3)" })),
      ]
        .sort((a, b) => (b.break_date || "").localeCompare(a.break_date || ""))
        .slice(0, 14);
      eTbl.querySelector("tbody").innerHTML = evts.length
        ? evts
            .map(
              (e) => `<tr>
              <td class="l">${e.layerCn}</td>
              <td class="l"><span class="badge ${e.bias === "bullish" ? "bull" : "bear"}">${e.bias === "bullish" ? "多头" : "空头"} ${e.kind}</span></td>
              <td>${e.break_date}</td>
              <td>${e.pivot_date}</td>
              <td>${fmt(e.price, m.decimals)}</td>
              <td>${fmt(e.close, m.decimals)}</td>
            </tr>`
            )
            .join("")
        : '<tr><td colspan="6" class="l" style="color:var(--sub)">暂无结构突破记录</td></tr>';
    }
  }

  window.addEventListener("resize", () => {
    allCharts.forEach((c) => {
      if (c && !c.isDisposed()) c.resize();
    });
  });

  // Scheduled Beijing Time auto-refresh slots: 09:00, 11:30, 15:00, 22:30
  const SCHEDULED_SLOTS = new Set(["09:00", "11:30", "15:00", "22:30"]);
  let lastTriggeredSlot = "";
  function startScheduledClockWatcher() {
    setInterval(() => {
      if (!window.LiveMarketEngine) return;
      const cstNow = window.LiveMarketEngine.nowCstFull(); // YYYY-MM-DD HH:MM:SS
      const slotKey = cstNow.slice(0, 16); // YYYY-MM-DD HH:MM
      const hhmm = cstNow.slice(11, 16);
      if (SCHEDULED_SLOTS.has(hhmm) && lastTriggeredSlot !== slotKey) {
        lastTriggeredSlot = slotKey;
        showToast(`到达定时节点（${hhmm}），正在自动更新最新行情…`);
        loadDashboard();
      }
    }, 20000);
  }

    const backTopBtn = $("backTopBtn");
    if (backTopBtn) {
      window.addEventListener("scroll", () => {
        backTopBtn.classList.toggle("visible", window.scrollY > 360);
      }, { passive: true });
      backTopBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    }

  detectHostCapabilities().finally(() => {
    loadDashboard();
    startScheduledClockWatcher();
  });
})();
