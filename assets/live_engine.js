/**
 * Browser-Side Real-Time Market Sync + SMC Technical Analysis Engine
 * 每次打开公网静态页面时，直接在浏览器直连免Key公开行情接口（CORS / JSONP），
 * 实时补齐最新交易日/盘中K线，并在前端即时重算全部技术指标与 SMC 聪明钱结构。
 */
(function (global) {
  "use strict";

  const TENCENT_KLINE_HOSTS = [
    "https://web.ifzq.gtimg.cn",
    "https://proxy.finance.qq.com/ifzqgtimg",
    "https://ifzq.gtimg.cn",
  ];

  const SH_INDEX_WHITELIST = new Set(["000001", "000300", "000905", "000016", "000688", "000852", "000010"]);

  function roundOpt(v, d = 2) {
    if (v == null || !Number.isFinite(v)) return null;
    const p = Math.pow(10, d);
    return Math.round(v * p) / p;
  }

  function nowCstFull() {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const cst = new Date(utc + 8 * 3600000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${cst.getFullYear()}-${pad(cst.getMonth() + 1)}-${pad(cst.getDate())} ${pad(cst.getHours())}:${pad(cst.getMinutes())}:${pad(cst.getSeconds())}`;
  }

  function normalizeTencentSymbol(code) {
    const raw = String(code || "").trim();
    const low = raw.toLowerCase();
    if (low.startsWith("sh") || low.startsWith("sz") || low.startsWith("bj")) return low;
    if (raw.startsWith("92")) return "bj" + raw;
    if (SH_INDEX_WHITELIST.has(raw) || raw.startsWith("5") || raw.startsWith("6") || raw.startsWith("9")) return "sh" + raw;
    if (raw.startsWith("4") || raw.startsWith("8")) return "bj" + raw;
    return "sz" + raw;
  }

  /* ==================== Classic Indicators ==================== */
  function calcSma(values, period) {
    const n = values.length;
    const out = new Array(n).fill(null);
    if (period <= 0 || n < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    out[period - 1] = sum / period;
    for (let i = period; i < n; i++) {
      sum += values[i] - values[i - period];
      out[i] = sum / period;
    }
    return out;
  }

  function calcEma(values, period) {
    if (!values.length) return [];
    const k = 2 / (period + 1);
    const out = [values[0]];
    for (let i = 1; i < values.length; i++) {
      out.push(values[i] * k + out[i - 1] * (1 - k));
    }
    return out;
  }

  function calcBoll(closes, period = 20, mult = 2) {
    const mid = calcSma(closes, period);
    const up = new Array(closes.length).fill(null);
    const dn = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      const m = mid[i];
      if (m == null) continue;
      let vSum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const diff = closes[j] - m;
        vSum += diff * diff;
      }
      const sd = Math.sqrt(vSum / period);
      up[i] = m + mult * sd;
      dn[i] = m - mult * sd;
    }
    return { mid, up, dn };
  }

  function calcMacd(closes, fast = 12, slow = 26, signal = 9) {
    if (!closes.length) return { dif: [], dea: [], hist: [] };
    const ef = calcEma(closes, fast);
    const es = calcEma(closes, slow);
    const dif = closes.map((_, i) => ef[i] - es[i]);
    const dea = calcEma(dif, signal);
    const hist = dif.map((v, i) => (v - dea[i]) * 2);
    return { dif, dea, hist };
  }

  function calcRsi(closes, period = 14) {
    const n = closes.length;
    const out = new Array(n).fill(null);
    if (n <= period) return out;
    const gains = new Array(n).fill(0);
    const losses = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains[i] = diff;
      else losses[i] = -diff;
    }
    let avgG = 0;
    let avgL = 0;
    for (let i = 1; i <= period; i++) {
      avgG += gains[i];
      avgL += losses[i];
    }
    avgG /= period;
    avgL /= period;
    out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (let i = period + 1; i < n; i++) {
      avgG = (avgG * (period - 1) + gains[i]) / period;
      avgL = (avgL * (period - 1) + losses[i]) / period;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return out;
  }

  function calcAtr(highs, lows, closes, period = 14) {
    const n = closes.length;
    if (!n) return [];
    const trs = [highs[0] - lows[0]];
    for (let i = 1; i < n; i++) {
      trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    }
    const atr = new Array(n).fill(trs[0]);
    if (n > period) {
      let run = 0;
      for (let i = 0; i < period; i++) {
        run += trs[i];
        atr[i] = run / (i + 1);
      }
      for (let i = period; i < n; i++) {
        atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
      }
    } else {
      let run = 0;
      for (let i = 0; i < n; i++) {
        run += trs[i];
        atr[i] = run / (i + 1);
      }
    }
    return atr;
  }

  /* ==================== SMC Engine (1:1 Port of smc_engine.py) ==================== */
  function detectStructureLayer(bars, atr, length, layerName, eqAtrFactor, decimals) {
    const n = bars.length;
    const dates = bars.map((b) => b.date);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const closes = bars.map((b) => b.close);

    const parsedHigh = new Array(n);
    const parsedLow = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = highs[i] - lows[i];
      if (atr[i] > 0 && r >= 2 * atr[i]) {
        parsedHigh[i] = lows[i];
        parsedLow[i] = highs[i];
      } else {
        parsedHigh[i] = highs[i];
        parsedLow[i] = lows[i];
      }
    }

    let trend = 0;
    let lastHigh = null;
    let lastLow = null;
    let prevSwingHigh = null;
    let prevSwingLow = null;

    const events = [];
    const orderBlocks = [];
    const eqLevels = [];
    const pivots = [];

    for (let i = 0; i < n; i++) {
      const p = i - length;
      if (p >= length) {
        let maxLeftH = -Infinity, maxRightH = -Infinity;
        let minLeftL = Infinity, minRightL = Infinity;
        for (let k = p - length; k < p; k++) {
          if (highs[k] > maxLeftH) maxLeftH = highs[k];
          if (lows[k] < minLeftL) minLeftL = lows[k];
        }
        for (let k = p + 1; k <= i; k++) {
          if (highs[k] > maxRightH) maxRightH = highs[k];
          if (lows[k] < minRightL) minRightL = lows[k];
        }

        if (highs[p] >= maxLeftH && highs[p] > maxRightH) {
          const nh = { idx: p, date: dates[p], confirm_idx: i, confirm_date: dates[i], price: highs[p], crossed: false };
          pivots.push({ type: "H", ...nh });
          if (prevSwingHigh && atr[i] > 0 && Math.abs(nh.price - prevSwingHigh.price) <= eqAtrFactor * atr[i] && p - prevSwingHigh.idx >= length) {
            eqLevels.push({
              type: "EQH",
              layer: layerName,
              start_date: prevSwingHigh.date,
              end_date: nh.date,
              confirm_date: dates[i],
              price: roundOpt((prevSwingHigh.price + nh.price) / 2, decimals),
            });
          }
          prevSwingHigh = nh;
          lastHigh = nh;
        }

        if (lows[p] <= minLeftL && lows[p] < minRightL) {
          const nl = { idx: p, date: dates[p], confirm_idx: i, confirm_date: dates[i], price: lows[p], crossed: false };
          pivots.push({ type: "L", ...nl });
          if (prevSwingLow && atr[i] > 0 && Math.abs(nl.price - prevSwingLow.price) <= eqAtrFactor * atr[i] && p - prevSwingLow.idx >= length) {
            eqLevels.push({
              type: "EQL",
              layer: layerName,
              start_date: prevSwingLow.date,
              end_date: nl.date,
              confirm_date: dates[i],
              price: roundOpt((prevSwingLow.price + nl.price) / 2, decimals),
            });
          }
          prevSwingLow = nl;
          lastLow = nl;
        }
      }

      // Mitigation (High/Low)
      for (const ob of orderBlocks) {
        if (ob.active && i > ob.created_idx) {
          if (ob.bias === "bullish" && lows[i] < ob.bottom) {
            ob.active = false;
            ob.mitigated_date = dates[i];
          } else if (ob.bias === "bearish" && highs[i] > ob.top) {
            ob.active = false;
            ob.mitigated_date = dates[i];
          }
        }
      }

      // Close-price breakout
      if (lastHigh && !lastHigh.crossed && closes[i] > lastHigh.price) {
        const kind = trend === -1 ? "CHoCH" : "BOS";
        trend = 1;
        lastHigh.crossed = true;
        events.push({
          layer: layerName,
          kind,
          bias: "bullish",
          pivot_date: lastHigh.date,
          break_date: dates[i],
          price: roundOpt(lastHigh.price, decimals),
          close: roundOpt(closes[i], decimals),
        });
        const loIdx = lastHigh.idx;
        const hiIdx = Math.max(loIdx + 1, i);
        let bestIdx = loIdx;
        for (let k = loIdx + 1; k < hiIdx; k++) {
          if (parsedLow[k] < parsedLow[bestIdx]) bestIdx = k;
        }
        orderBlocks.push({
          layer: layerName,
          bias: "bullish",
          start_date: dates[bestIdx],
          created_date: dates[i],
          created_idx: i,
          top: roundOpt(Math.max(parsedHigh[bestIdx], parsedLow[bestIdx]), decimals),
          bottom: roundOpt(Math.min(parsedHigh[bestIdx], parsedLow[bestIdx]), decimals),
          active: true,
          mitigated_date: null,
        });
      }

      if (lastLow && !lastLow.crossed && closes[i] < lastLow.price) {
        const kind = trend === 1 ? "CHoCH" : "BOS";
        trend = -1;
        lastLow.crossed = true;
        events.push({
          layer: layerName,
          kind,
          bias: "bearish",
          pivot_date: lastLow.date,
          break_date: dates[i],
          price: roundOpt(lastLow.price, decimals),
          close: roundOpt(closes[i], decimals),
        });
        const loIdx = lastLow.idx;
        const hiIdx = Math.max(loIdx + 1, i);
        let bestIdx = loIdx;
        for (let k = loIdx + 1; k < hiIdx; k++) {
          if (parsedHigh[k] > parsedHigh[bestIdx]) bestIdx = k;
        }
        orderBlocks.push({
          layer: layerName,
          bias: "bearish",
          start_date: dates[bestIdx],
          created_date: dates[i],
          created_idx: i,
          top: roundOpt(Math.max(parsedHigh[bestIdx], parsedLow[bestIdx]), decimals),
          bottom: roundOpt(Math.min(parsedHigh[bestIdx], parsedLow[bestIdx]), decimals),
          active: true,
          mitigated_date: null,
        });
      }
    }

    const recentH = pivots.filter((p) => p.type === "H");
    const recentL = pivots.filter((p) => p.type === "L");
    return {
      trend,
      events,
      order_blocks: orderBlocks,
      eq_levels: eqLevels,
      trail_high: recentH.length ? recentH[recentH.length - 1] : prevSwingHigh,
      trail_low: recentL.length ? recentL[recentL.length - 1] : prevSwingLow,
    };
  }

  function detectFvgs(bars, atr, minGapAtr, decimals) {
    const fvgs = [];
    for (let i = 2; i < bars.length; i++) {
      for (const g of fvgs) {
        if (g.active) {
          if (g.bias === "bullish" && bars[i].low <= g.bottom) {
            g.active = false;
            g.mitigated_date = bars[i].date;
          } else if (g.bias === "bearish" && bars[i].high >= g.top) {
            g.active = false;
            g.mitigated_date = bars[i].date;
          }
        }
      }
      const curAtr = atr[i] > 0 ? atr[i] : 0;
      const bullGap = bars[i].low - bars[i - 2].high;
      if (bullGap > 0 && bars[i - 1].close > bars[i - 1].open && bullGap >= minGapAtr * curAtr) {
        fvgs.push({
          bias: "bullish",
          start_date: bars[i - 1].date,
          created_date: bars[i].date,
          top: roundOpt(bars[i].low, decimals),
          bottom: roundOpt(bars[i - 2].high, decimals),
          active: true,
          mitigated_date: null,
        });
      }
      const bearGap = bars[i - 2].low - bars[i].high;
      if (bearGap > 0 && bars[i - 1].close < bars[i - 1].open && bearGap >= minGapAtr * curAtr) {
        fvgs.push({
          bias: "bearish",
          start_date: bars[i - 1].date,
          created_date: bars[i].date,
          top: roundOpt(bars[i - 2].low, decimals),
          bottom: roundOpt(bars[i].high, decimals),
          active: true,
          mitigated_date: null,
        });
      }
    }
    return fvgs;
  }

  function analyzeTechnicalSeries(bars, meta, decimals = 2) {
    const n = bars.length;
    const dates = bars.map((b) => b.date);
    const opens = bars.map((b) => Number(b.open));
    const highs = bars.map((b) => Number(b.high));
    const lows = bars.map((b) => Number(b.low));
    const closes = bars.map((b) => Number(b.close));
    const volumes = bars.map((b) => (b.volume == null ? null : Number(b.volume)));

    const ma5 = calcSma(closes, 5).map((v) => roundOpt(v, decimals));
    const ma10 = calcSma(closes, 10).map((v) => roundOpt(v, decimals));
    const ma20 = calcSma(closes, 20).map((v) => roundOpt(v, decimals));
    const ma60 = calcSma(closes, 60).map((v) => roundOpt(v, decimals));
    const ma120 = calcSma(closes, 120).map((v) => roundOpt(v, decimals));
    const bollRaw = calcBoll(closes, 20, 2);
    const boll = {
      mid: bollRaw.mid.map((v) => roundOpt(v, decimals)),
      up: bollRaw.up.map((v) => roundOpt(v, decimals)),
      dn: bollRaw.dn.map((v) => roundOpt(v, decimals)),
    };
    const macdRaw = calcMacd(closes, 12, 26, 9);
    const mDig = Math.max(decimals + 1, 3);
    const macd = {
      dif: macdRaw.dif.map((v) => roundOpt(v, mDig)),
      dea: macdRaw.dea.map((v) => roundOpt(v, mDig)),
      hist: macdRaw.hist.map((v) => roundOpt(v, mDig)),
    };
    const rsi14 = calcRsi(closes, 14).map((v) => roundOpt(v, 2));
    const atr14 = calcAtr(highs, lows, closes, 14);

    const swing = detectStructureLayer(bars, atr14, 10, "swing", 0.15, decimals);
    const internal = detectStructureLayer(bars, atr14, 3, "internal", 0.15, decimals);
    const fvgs = detectFvgs(bars, atr14, 0.15, decimals);

    const activeSwingOb = swing.order_blocks.filter((o) => o.active).slice(-6);
    const activeIntOb = internal.order_blocks.filter((o) => o.active).slice(-4);
    const activeObs = [...activeSwingOb, ...activeIntOb];
    const activeFvgs = fvgs.filter((g) => g.active).slice(-6);

    const recent = bars.slice(-Math.min(n, 120));
    let swHighVal = swing.trail_high ? swing.trail_high.price : Math.max(...recent.map((b) => b.high));
    let swHighDate = swing.trail_high ? swing.trail_high.date : recent[recent.length - 1].date;
    let swLowVal = swing.trail_low ? swing.trail_low.price : Math.min(...recent.map((b) => b.low));
    let swLowDate = swing.trail_low ? swing.trail_low.date : recent[recent.length - 1].date;

    const rangeStart = swHighDate < swLowDate ? swHighDate : swLowDate;
    for (const b of bars) {
      if (b.date >= rangeStart) {
        if (b.high > swHighVal) { swHighVal = b.high; swHighDate = b.date; }
        if (b.low < swLowVal) { swLowVal = b.low; swLowDate = b.date; }
      }
    }
    if (swHighVal <= swLowVal) {
      const sl = bars.slice(-Math.min(n, 60));
      swHighVal = Math.max(...sl.map((b) => b.high));
      swLowVal = Math.min(...sl.map((b) => b.low));
    }

    const span = swHighVal - swLowVal;
    const eqPrice = (swHighVal + swLowVal) / 2;
    const lastClose = closes[n - 1];
    const prevClose = n >= 2 ? closes[n - 2] : lastClose;
    const chgPct = prevClose ? ((lastClose / prevClose) - 1) * 100 : 0;
    const posPct = Math.max(0, Math.min(100, span > 0 ? ((lastClose - swLowVal) / span) * 100 : 50));

    let zoneLabel = "折价区 (Lower Half)";
    if (posPct >= 75) zoneLabel = "深度溢价区 (Premium)";
    else if (posPct > 50) zoneLabel = "溢价区 (Upper Half)";
    else if (posPct <= 25) zoneLabel = "深度折价区 (Discount)";

    const trendMap = { 1: "偏多 (Bullish)", "-1": "偏空 (Bearish)", 0: "震荡待确认 (Neutral)" };
    const retN = (k) => (n > k && closes[n - 1 - k] > 0 ? roundOpt(((lastClose / closes[n - 1 - k]) - 1) * 100, 2) : null);

    return {
      meta: {
        ...meta,
        bar_count: n,
        date_range: [dates[0], dates[n - 1]],
      },
      dates,
      ohlc: bars.map((b) => [roundOpt(b.open, decimals), roundOpt(b.close, decimals), roundOpt(b.low, decimals), roundOpt(b.high, decimals)]),
      volumes,
      indicators: { ma5, ma10, ma20, ma60, ma120, boll, macd, rsi14, atr14: atr14.map((v) => roundOpt(v, decimals)) },
      smc: {
        swing_trend: swing.trend,
        swing_trend_label: trendMap[swing.trend],
        internal_trend: internal.trend,
        internal_trend_label: trendMap[internal.trend],
        swing_events: swing.events.slice(-24),
        internal_events: internal.events.slice(-36),
        active_order_blocks: activeObs.map(({ created_idx, ...rest }) => rest),
        active_fvgs: activeFvgs,
        eq_levels: [...swing.eq_levels.slice(-6), ...internal.eq_levels.slice(-6)].slice(-10),
        zones: {
          start_date: rangeStart,
          swing_high: roundOpt(swHighVal, decimals),
          swing_high_date: swHighDate,
          swing_high_role: swing.trend === -1 ? "Strong High (防守高点)" : "Weak High (目标高点)",
          swing_low: roundOpt(swLowVal, decimals),
          swing_low_date: swLowDate,
          swing_low_role: swing.trend === -1 ? "Weak Low (易测低点)" : "Strong Low (防守低点)",
          equilibrium: roundOpt(eqPrice, decimals),
          premium_75: roundOpt(swLowVal + 0.75 * span, decimals),
          discount_25: roundOpt(swLowVal + 0.25 * span, decimals),
          current_pos_pct: roundOpt(posPct, 1),
          zone_label: zoneLabel,
        },
        last_swing_event: swing.events.length ? swing.events[swing.events.length - 1] : null,
        last_internal_event: internal.events.length ? internal.events[internal.events.length - 1] : null,
        confirm_lag_days: { swing: 10, internal: 3 },
      },
      summary: {
        latest_date: dates[n - 1],
        close: roundOpt(lastClose, decimals),
        open: roundOpt(opens[n - 1], decimals),
        high: roundOpt(highs[n - 1], decimals),
        low: roundOpt(lows[n - 1], decimals),
        change_pct: roundOpt(chgPct, 2),
        ret_5d: retN(5),
        ret_20d: retN(20),
        ret_60d: retN(60),
        rsi14: rsi14[n - 1],
        macd_dif: macd.dif[n - 1],
        macd_dea: macd.dea[n - 1],
        macd_hist: macd.hist[n - 1],
        atr14: roundOpt(atr14[n - 1], decimals),
        active_bull_ob_count: activeObs.filter((o) => o.bias === "bullish").length,
        active_bear_ob_count: activeObs.filter((o) => o.bias === "bearish").length,
        active_fvg_count: activeFvgs.length,
      },
    };
  }

  /* ==================== Direct Browser Live Fetchers ==================== */
  async function fetchWithTimeout(url, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchTencentQuotes(codes) {
    const prefixed = codes.map(normalizeTencentSymbol);
    const keyOf = {};
    codes.forEach((c, i) => { keyOf[prefixed[i]] = c; });

    const resp = await fetchWithTimeout("https://qt.gtimg.cn/q=" + prefixed.join(",") + "&_=" + Date.now(), 7000);
    const buf = await resp.arrayBuffer();
    let text;
    try {
      text = new TextDecoder("gbk").decode(buf);
    } catch (_) {
      text = new TextDecoder("utf-8").decode(buf);
    }

    const out = {};
    for (const line of text.trim().split(";")) {
      if (!line.trim() || !line.includes("=") || !line.includes('"')) continue;
      const key = line.split("=")[0].split("_").pop();
      const vals = line.split('"')[1].split("~");
      if (vals.length < 53) continue;
      const f = (idx) => {
        const v = Number(vals[idx]);
        return Number.isFinite(v) ? v : 0;
      };
      // Date string in vals[30]: YYYYMMDDHHMMSS or YYYY-MM-DD HH:MM:SS
      const rawDt = String(vals[30] || "").replace(/[^0-9]/g, "");
      let quoteDate = null;
      if (rawDt.length >= 8) {
        quoteDate = `${rawDt.slice(0, 4)}-${rawDt.slice(4, 6)}-${rawDt.slice(6, 8)}`;
      }
      const origKey = keyOf[key] || key;
      out[origKey] = {
        symbol: key,
        name: vals[1],
        code: vals[2],
        price: f(3),
        last_close: f(4),
        open: f(5),
        volume: f(6),
        quote_date: quoteDate,
        change_amt: f(31),
        change_pct: f(32),
        high: f(33),
        low: f(34),
        amount_wan: f(37),
        turnover_pct: f(38),
        pe_ttm: f(39),
        amplitude_pct: f(43),
        float_mcap_yi: f(44),
        mcap_yi: f(45),
        pb: f(46),
        vol_ratio: f(49),
        pe_static: f(52),
      };
    }
    return out;
  }

  async function fetchTencentKline(code, count = 520, adjust = "qfq") {
    const sym = normalizeTencentSymbol(code);
    const param = encodeURIComponent(`${sym},day,,,${count},${adjust}`);
    let lastErr = null;
    for (const host of TENCENT_KLINE_HOSTS) {
      try {
        const resp = await fetchWithTimeout(`${host}/appstock/app/fqkline/get?param=${param}&_=${Date.now()}`, 8000);
        const json = await resp.json();
        const node = json && json.data && json.data[sym];
        if (!node) throw new Error("empty node");
        const items = node[adjust + "day"] || node.day;
        if (!Array.isArray(items) || !items.length) throw new Error("empty kline");
        const bars = [];
        for (const it of items) {
          const o = Number(it[1]), c = Number(it[2]), h = Number(it[3]), l = Number(it[4]);
          if (Math.min(o, c, h, l) <= 0) continue;
          bars.push({ date: String(it[0]), open: o, close: c, high: h, low: l, volume: Number(it[5] || 0) });
        }
        bars.sort((a, b) => a.date.localeCompare(b.date));
        return bars;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("tencent kline failed");
  }

  function loadJsonpVar(url, varName, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      let done = false;
      const cleanup = () => {
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          cleanup();
          reject(new Error("JSONP timeout: " + varName));
        }
      }, timeoutMs);

      script.src = url;
      script.async = true;
      script.onload = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const val = global[varName];
        cleanup();
        if (val) resolve(val);
        else reject(new Error("JSONP empty var: " + varName));
      };
      script.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error("JSONP load error: " + varName));
      };
      document.head.appendChild(script);
    });
  }

  async function fetchSinaFuturesKline(symbol = "AU0", count = 520) {
    const varName = "__SINA_FUT_" + symbol + "_" + Math.floor(Math.random() * 100000);
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/window.${varName}=/InnerFuturesNewService.getDailyKLine?symbol=${encodeURIComponent(symbol)}&_=${Date.now()}`;
    const arr = await loadJsonpVar(url, varName, 9000);
    try { delete global[varName]; } catch (_) {}
    const bars = [];
    for (const r of arr) {
      const o = Number(r.o), h = Number(r.h), l = Number(r.l), c = Number(r.c);
      if (Math.min(o, h, l, c) <= 0) continue;
      bars.push({ date: String(r.d), open: o, high: h, low: l, close: c, volume: Number(r.v || 0) });
    }
    bars.sort((a, b) => a.date.localeCompare(b.date));
    return bars.length > count ? bars.slice(-count) : bars;
  }

  async function fetchEastmoneyKline(secid, count = 520) {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&lmt=${count}&end=20500101&_=${Date.now()}`;
    const resp = await fetchWithTimeout(url, 8000);
    const json = await resp.json();
    const klines = json && json.data && json.data.klines;
    if (!Array.isArray(klines) || !klines.length) throw new Error("empty em kline");
    const bars = [];
    for (const line of klines) {
      const p = line.split(",");
      const o = Number(p[1]), c = Number(p[2]), h = Number(p[3]), l = Number(p[4]), v = Number(p[5] || 0);
      if (Math.min(o, c, h, l) <= 0) continue;
      bars.push({ date: p[0], open: o, close: c, high: h, low: l, volume: v > 0 ? v : null });
    }
    bars.sort((a, b) => a.date.localeCompare(b.date));
    return bars;
  }

  async function fetchEastmoneyQuotes(secids) {
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f4,f12,f14,f15,f16,f17,f18&secids=${encodeURIComponent(secids.join(","))}&_=${Date.now()}`;
    const resp = await fetchWithTimeout(url, 7000);
    const json = await resp.json();
    const diff = (json && json.data && json.data.diff) || [];
    const out = {};
    for (const row of diff) {
      if (row && row.f12 && row.f2 !== "-") {
        out[row.f12] = {
          price: Number(row.f2),
          change_pct: Number(row.f3),
          change_amt: Number(row.f4),
          high: Number(row.f15),
          low: Number(row.f16),
          open: Number(row.f17),
          last_close: Number(row.f18),
        };
      }
    }
    return out;
  }

  function mergeIntradayBar(bars, quote) {
    if (!bars.length || !quote || !quote.price || quote.price <= 0) return bars;
    const out = bars.slice();
    const last = out[out.length - 1];
    const qDate = quote.quote_date || last.date;
    const o = quote.open > 0 ? quote.open : quote.price;
    const h = Math.max(quote.high > 0 ? quote.high : quote.price, quote.price, o);
    const l = Math.min(quote.low > 0 ? quote.low : quote.price, quote.price, o);

    if (qDate === last.date) {
      out[out.length - 1] = {
        ...last,
        open: o,
        high: Math.max(last.high, h),
        low: Math.min(last.low, l),
        close: quote.price,
        volume: quote.volume > 0 ? quote.volume : last.volume,
      };
    } else if (qDate > last.date) {
      out.push({
        date: qDate,
        open: o,
        high: h,
        low: l,
        close: quote.price,
        volume: quote.volume > 0 ? quote.volume : null,
      });
    }
    return out;
  }

  /* ==================== Master Live Sync Entry ==================== */
  async function syncLiveMarketData(baseData, pageMode) {
    const D = JSON.parse(JSON.stringify(baseData));
    const synced = [];
    const failed = [];
    const syncTime = nowCstFull();

    if (pageMode === "yandongwei") {
      try {
        const [bars, quotes] = await Promise.all([
          fetchTencentKline("sh688172", 520, "qfq"),
          fetchTencentQuotes(["sh688172"]),
        ]);
        const q = quotes.sh688172;
        const merged = mergeIntradayBar(bars, q);
        const prevMeta = D.technical.yandongwei.meta;
        const fresh = analyzeTechnicalSeries(merged, { ...prevMeta, source: "腾讯财经实时直连 (前复权)" }, prevMeta.decimals);
        if (q) {
          fresh.quote = {
            price: q.price,
            change_pct: q.change_pct,
            change_amt: q.change_amt,
            turnover_pct: q.turnover_pct,
            amplitude_pct: q.amplitude_pct,
            pe_ttm: q.pe_ttm,
            pe_static: q.pe_static,
            pb: q.pb,
            float_mcap_yi: q.float_mcap_yi,
            mcap_yi: q.mcap_yi,
            amount_wan: q.amount_wan,
            vol_ratio: q.vol_ratio,
            is_stale: false,
          };
          // Ensure summary change_pct matches live quote accurately
          if (Number.isFinite(q.change_pct)) fresh.summary.change_pct = roundOpt(q.change_pct, 2);
        }
        D.technical.yandongwei = fresh;
        D.meta.latest_market_date = fresh.summary.latest_date;
        synced.push("燕东微实时日K/估值");
      } catch (e) {
        failed.push("燕东微(" + e.message + ")");
      }
    } else {
      // Market 5-item dashboard: fetch all live feeds in parallel!
      const etfCodes = (D.national_team && D.national_team.etfs ? D.national_team.etfs.map((e) => e.code) : []);
      const quoteCodes = ["sh000300", "sh000688", "sz399673", "sh518880", ...etfCodes];

      const [
        quotesRes,
        star50Res,
        cyb50Res,
        goldEtfRes,
        csi300Res,
        goldAu0Res,
        goldSgeRes,
        emGoldQRes,
      ] = await Promise.allSettled([
        fetchTencentQuotes(quoteCodes),
        fetchTencentKline("sh000688", 520, "qfq"),
        fetchTencentKline("sz399673", 520, "qfq"),
        fetchTencentKline("sh518880", 520, "qfq"),
        fetchTencentKline("sh000300", 60, ""),
        fetchSinaFuturesKline("AU0", 520),
        fetchEastmoneyKline("118.AU9999", 520),
        fetchEastmoneyQuotes(["113.aum", "118.AU9999"]),
      ]);

      const tq = quotesRes.status === "fulfilled" ? quotesRes.value : {};
      const emGoldQ = emGoldQRes.status === "fulfilled" ? emGoldQRes.value : {};

      // 1. Update Module 1 (沪深300全收益 tail extension via live sh000300 daily returns)
      if (csi300Res.status === "fulfilled" && D.convergence && D.convergence.dates.length) {
        try {
          const c = D.convergence;
          let bars300 = mergeIntradayBar(csi300Res.value, tq.sh000300);
          const lastBaseDate = c.dates[c.dates.length - 1];
          // Build date->close map for sh000300
          const idxAnchor = bars300.findIndex((b) => b.date === lastBaseDate);
          if (idxAnchor >= 0 && idxAnchor < bars300.length - 1) {
            let curNav300 = c.csi300_tri_nav[c.csi300_tri_nav.length - 1];
            const curNavB2 = c.bond2_nav[c.bond2_nav.length - 1];
            const curNavCsiB = c.csi_bond_nav[c.csi_bond_nav.length - 1];
            for (let k = idxAnchor + 1; k < bars300.length; k++) {
              const r = bars300[k].close / bars300[k - 1].close - 1;
              curNav300 = curNav300 * (1 + r);
              const p300 = roundOpt((curNav300 - 1) * 100, 2);
              const pb2 = roundOpt((curNavB2 - 1) * 100, 2);
              const pcsi = roundOpt((curNavCsiB - 1) * 100, 2);
              c.dates.push(bars300[k].date);
              c.csi300_tri_nav.push(roundOpt(curNav300, 4));
              c.bond2_nav.push(curNavB2);
              c.csi_bond_nav.push(curNavCsiB);
              c.csi300_tri_pct.push(p300);
              c.bond2_pct.push(pb2);
              c.csi_bond_pct.push(pcsi);
              c.spread_pct.push(roundOpt(p300 - pb2, 2));
            }
            c.latest_date = c.dates[c.dates.length - 1];
            c.summary.csi300_cum_pct = c.csi300_tri_pct[c.csi300_tri_pct.length - 1];
            c.summary.spread_pct = c.spread_pct[c.spread_pct.length - 1];
            c.summary.ratio_300_to_bond2 = roundOpt(
              c.csi300_tri_nav[c.csi300_tri_nav.length - 1] / c.bond2_nav[c.bond2_nav.length - 1],
              3
            );
            c.summary.is_currently_below =
              c.csi300_tri_nav[c.csi300_tri_nav.length - 1] < c.bond2_nav[c.bond2_nav.length - 1];
          } else if (tq.sh000300 && tq.sh000300.quote_date === lastBaseDate && c.dates.length >= 2) {
            // Update today's intraday live point on the last date
            const prevNav = c.csi300_tri_nav[c.csi300_tri_nav.length - 2];
            const liveNav = prevNav * (1 + tq.sh000300.change_pct / 100);
            const livePct = roundOpt((liveNav - 1) * 100, 2);
            const iLast = c.dates.length - 1;
            c.csi300_tri_nav[iLast] = roundOpt(liveNav, 4);
            c.csi300_tri_pct[iLast] = livePct;
            c.spread_pct[iLast] = roundOpt(livePct - c.bond2_pct[iLast], 2);
            c.summary.csi300_cum_pct = livePct;
            c.summary.spread_pct = c.spread_pct[iLast];
            c.summary.ratio_300_to_bond2 = roundOpt(liveNav / c.bond2_nav[iLast], 3);
          }
          synced.push("沪深300实时联动");
        } catch (e) {
          failed.push("股债收敛(" + e.message + ")");
        }
      }

      // 2. Update Module 2 (National Team 16 ETFs live prices & real-time AUM)
      if (Object.keys(tq).length && D.national_team && D.national_team.rows) {
        let liveAum = 0;
        let updatedCount = 0;
        for (const r of D.national_team.rows) {
          const q = tq[r.code];
          if (q && q.price > 0) {
            r.close = roundOpt(q.price, 3);
            if (r.shares != null) {
              r.aum = roundOpt(r.shares * q.price, 1);
              liveAum += r.aum;
            }
            updatedCount++;
          } else if (r.aum != null) {
            liveAum += r.aum;
          }
        }
        if (updatedCount > 0 && liveAum > 0) {
          D.national_team.summary.total_aum_yi = roundOpt(liveAum, 1);
          if (tq.sh000300 && tq.sh000300.mcap_yi > 100000) {
            const estAllA = roundOpt(tq.sh000300.mcap_yi / 0.52, 0);
            D.national_team.summary.a_share_total_mcap_yi = estAllA;
            D.national_team.summary.monitored_a_share_pct = roundOpt((liveAum / estAllA) * 100, 2);
          }
          D.national_team.live_price_synced = true;
          synced.push(`国家队${updatedCount}只ETF实时价`);
        }
      }

      // 3. Update Module 3 (科创50)
      if (star50Res.status === "fulfilled") {
        const prev = D.technical.star50.meta;
        const merged = mergeIntradayBar(star50Res.value, tq.sh000688);
        D.technical.star50 = analyzeTechnicalSeries(merged, { ...prev, source: "腾讯财经实时直连" }, prev.decimals);
        if (tq.sh000688 && Number.isFinite(tq.sh000688.change_pct)) {
          D.technical.star50.summary.change_pct = roundOpt(tq.sh000688.change_pct, 2);
        }
        synced.push("科创50实时日K");
      } else {
        failed.push("科创50");
      }

      // 4. Update Module 4 (创业板50)
      if (cyb50Res.status === "fulfilled") {
        const prev = D.technical.cyb50.meta;
        const merged = mergeIntradayBar(cyb50Res.value, tq.sz399673);
        D.technical.cyb50 = analyzeTechnicalSeries(merged, { ...prev, source: "腾讯财经实时直连" }, prev.decimals);
        if (tq.sz399673 && Number.isFinite(tq.sz399673.change_pct)) {
          D.technical.cyb50.summary.change_pct = roundOpt(tq.sz399673.change_pct, 2);
        }
        synced.push("创业板50实时日K");
      } else {
        failed.push("创业板50");
      }

      // 5A. Update Module 5 (沪金主连 AU0 via Sina JSONP + EastMoney live night/day quote)
      if (goldAu0Res.status === "fulfilled") {
        const prev = D.technical.gold_au0.meta;
        let bars = goldAu0Res.value;
        const qAu = emGoldQ.aum;
        if (qAu && qAu.price > 0) {
          // If night session or intraday is active, update latest candle
          const todayStr = syncTime.slice(0, 10);
          bars = mergeIntradayBar(bars, { ...qAu, quote_date: bars[bars.length - 1].date >= todayStr ? bars[bars.length - 1].date : todayStr });
        }
        D.technical.gold_au0 = analyzeTechnicalSeries(bars, { ...prev, source: "新浪期货 + 东财盘中实时直连" }, prev.decimals);
        if (qAu && Number.isFinite(qAu.change_pct)) {
          D.technical.gold_au0.summary.change_pct = roundOpt(qAu.change_pct, 2);
        }
        synced.push("沪金AU0实时");
      } else {
        failed.push("沪金AU0");
      }

      // 5B. Update Module 5 (上海金 Au99.99 via EastMoney CORS)
      if (goldSgeRes.status === "fulfilled") {
        const prev = D.technical.gold_sge.meta;
        let bars = goldSgeRes.value;
        const qSge = emGoldQ.AU9999;
        if (qSge && qSge.price > 0) {
          bars = mergeIntradayBar(bars, { ...qSge, quote_date: bars[bars.length - 1].date });
        }
        D.technical.gold_sge = analyzeTechnicalSeries(bars, { ...prev, source: "上金所 Au99.99 实时直连" }, prev.decimals);
        if (qSge && Number.isFinite(qSge.change_pct)) {
          D.technical.gold_sge.summary.change_pct = roundOpt(qSge.change_pct, 2);
        }
        synced.push("上海金Au99.99实时");
      } else {
        failed.push("上海金");
      }

      // 5C. Update Module 5 (黄金ETF 518880)
      if (goldEtfRes.status === "fulfilled") {
        const prev = D.technical.gold_etf.meta;
        const merged = mergeIntradayBar(goldEtfRes.value, tq.sh518880);
        D.technical.gold_etf = analyzeTechnicalSeries(merged, { ...prev, source: "腾讯财经实时直连 (前复权)" }, prev.decimals);
        if (tq.sh518880 && Number.isFinite(tq.sh518880.change_pct)) {
          D.technical.gold_etf.summary.change_pct = roundOpt(tq.sh518880.change_pct, 2);
        }
        synced.push("黄金ETF实时");
      } else {
        failed.push("黄金ETF");
      }

      const techDates = ["star50", "cyb50", "gold_au0", "gold_sge", "gold_etf"]
        .map((k) => D.technical[k] && D.technical[k].summary && D.technical[k].summary.latest_date)
        .filter(Boolean);
      if (techDates.length) {
        D.meta.latest_market_date = techDates.sort().pop();
      }
    }

    D.meta.live_sync = {
      ok: synced.length > 0,
      synced_at: syncTime,
      synced_items: synced,
      failed_items: failed,
    };

    return D;
  }

  global.LiveMarketEngine = {
    syncLiveMarketData,
    analyzeTechnicalSeries,
    nowCstFull,
  };
})(window);
