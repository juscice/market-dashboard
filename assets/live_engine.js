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

    // Lightweight Wave ZigZag + 60-day Linear Regression Channel for live chart overlays
    const thresh = (meta && (meta.key === "gold_xau" || meta.key === "gold_etf")) ? 0.045 : 0.06;
    const wave = computeWaveOverlay(bars, decimals, thresh);
    const channel = computeChannelOverlay(bars, 60, decimals);

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
      wave,
      channel,
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

  /* ==================== Full Live Elliott Wave + 60D Channel Engine ==================== */
  function computeWaveOverlay(bars, decimals = 2, pctThreshold = 0.055) {
    const win = bars.slice(-Math.min(bars.length, 260));
    if (win.length < 10) {
      return { wave_stage: "窄幅蓄势（待确立主浪）", bias: "neutral", retrace_pct: 0, summary: "数据不足", fib_levels: {}, pivots: [] };
    }
    const runZigzag = (th) => {
      const piv = [];
      let dir = 0, extIdx = 0, extPrice = Number(win[0].close);
      for (let i = 1; i < win.length; i++) {
        const hi = Number(win[i].high), lo = Number(win[i].low);
        if (dir === 0) {
          if (hi >= extPrice * (1 + th)) {
            piv.push({ date: win[extIdx].date, price: roundOpt(win[extIdx].low, decimals), type: "L" });
            dir = 1; extIdx = i; extPrice = hi;
          } else if (lo <= extPrice * (1 - th)) {
            piv.push({ date: win[extIdx].date, price: roundOpt(win[extIdx].high, decimals), type: "H" });
            dir = -1; extIdx = i; extPrice = lo;
          } else if (hi > extPrice) { extPrice = hi; extIdx = i; }
        } else if (dir === 1) {
          if (hi >= extPrice) { extPrice = hi; extIdx = i; }
          else if (lo <= extPrice * (1 - th)) {
            piv.push({ date: win[extIdx].date, price: roundOpt(extPrice, decimals), type: "H" });
            dir = -1; extIdx = i; extPrice = lo;
          }
        } else {
          if (lo <= extPrice) { extPrice = lo; extIdx = i; }
          else if (hi >= extPrice * (1 + th)) {
            piv.push({ date: win[extIdx].date, price: roundOpt(extPrice, decimals), type: "L" });
            dir = 1; extIdx = i; extPrice = hi;
          }
        }
      }
      if (dir !== 0) piv.push({ date: win[extIdx].date, price: roundOpt(extPrice, decimals), type: dir === 1 ? "H" : "L", developing: true });
      return piv;
    };

    let pivs = runZigzag(pctThreshold);
    if (pivs.length < 4) pivs = runZigzag(pctThreshold * 0.65);

    const lastBar = win[win.length - 1];
    const lastClose = Number(lastBar.close);
    const lastDate = lastBar.date;

    if (pivs.length < 3) {
      const hi = Math.max(...win.map((b) => Number(b.high)));
      const lo = Math.min(...win.map((b) => Number(b.low)));
      return {
        wave_stage: "窄幅蓄势（待确立主浪）",
        bias: "neutral",
        retrace_pct: 0,
        summary: `近一年波幅收敛，区间 ${lo.toFixed(decimals)}–${hi.toFixed(decimals)}，等待有效突破确立新一轮推动浪方向。`,
        fib_levels: {
          f382: roundOpt(lo + 0.382 * (hi - lo), decimals),
          f500: roundOpt(lo + 0.5 * (hi - lo), decimals),
          f618: roundOpt(lo + 0.618 * (hi - lo), decimals),
        },
        pivots: [],
      };
    }

    const recent = pivs.slice(-Math.min(pivs.length, 6));
    const pLast = recent[recent.length - 1];
    const pPrev = recent[recent.length - 2];
    const pPrev2 = recent[recent.length - 3];

    const legCurr = pLast.price - pPrev.price;
    const legPrev = pPrev.price - pPrev2.price;
    const currUp = legCurr > 0;
    const retraceRatio = Math.abs(legPrev) > 1e-9 ? Math.abs(legCurr / legPrev) : 0;

    const highs = recent.filter((p) => p.type === "H").map((p) => p.price);
    const lows = recent.filter((p) => p.type === "L").map((p) => p.price);
    const hh = highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2];
    const hl = lows.length >= 2 && lows[lows.length - 1] > lows[lows.length - 2];
    const lh = highs.length >= 2 && highs[highs.length - 1] < highs[highs.length - 2];
    const ll = lows.length >= 2 && lows[lows.length - 1] < lows[lows.length - 2];

    let waveStage = "震荡整理";
    let bias = "neutral";
    let labels = [];
    let detail = "";

    if (currUp) {
      if (hh && hl) {
        waveStage = "上升推动浪（第3/5浪延伸）";
        bias = "bullish";
        labels = ["0", "1", "2", "3", "4", "5"].slice(-recent.length);
        detail = `高低点逐级抬升，当前处于多头主升/延伸结构（本段较前段推进比 ${retraceRatio.toFixed(2)}x），回调不破前低 ${pPrev.price.toFixed(decimals)} 则维持多头浪型。`;
      } else if (retraceRatio < 0.786 && lh) {
        waveStage = "下跌途中的 B 浪反弹";
        bias = "bearish";
        labels = ["0", "A", "B"].slice(-Math.min(3, recent.length));
        detail = `前序仍为高点下移结构，本轮自 ${pPrev.price.toFixed(decimals)} 反弹幅度约为前跌浪的 ${(retraceRatio * 100).toFixed(1)}%，未突破前高 ${pPrev2.price.toFixed(decimals)} 前按 B 浪反弹对待。`;
      } else {
        waveStage = "底部转折（疑似新1浪启动）";
        bias = "bullish";
        labels = ["A", "B", "C", "1"].slice(-Math.min(4, recent.length));
        detail = `自低点 ${pPrev.price.toFixed(decimals)} 强力反攻，已收复前跌浪 ${(retraceRatio * 100).toFixed(1)}%，关注能否放量站稳前高 ${pPrev2.price.toFixed(decimals)} 确认1→3主升切换。`;
      }
    } else {
      if (lh && ll) {
        if (retraceRatio >= 1.0) {
          waveStage = "主跌浪 / 延长 C 浪";
          bias = "bearish";
          labels = ["0", "A", "B", "C"].slice(-Math.min(4, recent.length));
          detail = `高点与低点同步下移，本段下行幅度已达前段反弹的 ${retraceRatio.toFixed(2)}x（跌破前低），处于空头主跌/延长C浪；右侧需等待止跌底分型与反破前高。`;
        } else {
          waveStage = "下跌推动 / C 浪探底";
          bias = "bearish";
          labels = ["0", "A", "B", "C"].slice(-Math.min(4, recent.length));
          detail = `自 ${pPrev.price.toFixed(decimals)} 回落并刷新阶段低点，空头浪型延续，重点观察下方斐波那契支撑区能否形成背离企稳。`;
        }
      } else if (hl || retraceRatio < 0.618) {
        waveStage = "上升途中的 2/4 浪回踩";
        bias = "neutral";
        labels = ["0", "1", "2", "3", "4"].slice(-Math.min(5, recent.length));
        detail = `前期呈多头波段，当前自 ${pPrev.price.toFixed(decimals)} 回撤约为前涨浪的 ${(retraceRatio * 100).toFixed(1)}%；若守住 0.618 关键位，仍属健康回调蓄势。`;
      } else {
        waveStage = "ABC 深度调整浪";
        bias = "bearish";
        labels = ["0", "A", "B", "C"].slice(-Math.min(4, recent.length));
        detail = `自高点 ${pPrev.price.toFixed(decimals)} 回调幅度已达前涨浪的 ${(retraceRatio * 100).toFixed(1)}%，调整偏深，需防范演变为大级别下跌浪。`;
      }
    }

    const hiRef = Math.max(pPrev.price, pPrev2.price, pLast.price);
    const loRef = Math.min(pPrev.price, pPrev2.price, pLast.price);
    const span = Math.max(hiRef - loRef, 1e-6);
    const fibLevels = {
      anchor_high: roundOpt(hiRef, decimals),
      anchor_low: roundOpt(loRef, decimals),
      f236: roundOpt(loRef + 0.236 * span, decimals),
      f382: roundOpt(loRef + 0.382 * span, decimals),
      f500: roundOpt(loRef + 0.5 * span, decimals),
      f618: roundOpt(loRef + 0.618 * span, decimals),
    };

    const offset = recent.length - labels.length;
    const chartPivots = recent.map((p, i) => ({
      date: p.date,
      price: p.price,
      type: p.type,
      label: i >= offset ? labels[i - offset] : "",
      developing: Boolean(p.developing),
    }));
    if (chartPivots.length && chartPivots[chartPivots.length - 1].date < lastDate) {
      chartPivots.push({ date: lastDate, price: roundOpt(lastClose, decimals), type: "C", label: "现", developing: true });
    }

    return {
      wave_stage: waveStage,
      bias,
      retrace_pct: roundOpt(retraceRatio * 100, 1),
      summary: detail,
      fib_levels: fibLevels,
      pivots: chartPivots,
    };
  }

  function computeChannelOverlay(bars, windowLen = 60, decimals = 2) {
    const w = Math.min(bars.length, windowLen);
    if (w < 5) return null;
    const seg = bars.slice(-w);
    const closes = seg.map((b) => Number(b.close));
    const xMean = (w - 1) / 2;
    const yMean = closes.reduce((a, b) => a + b, 0) / w;
    let num = 0, den = 0;
    for (let i = 0; i < w; i++) {
      num += (i - xMean) * (closes[i] - yMean);
      den += (i - xMean) * (i - xMean);
    }
    const slope = den > 0 ? num / den : 0;
    const intercept = yMean - slope * xMean;
    let sq = 0;
    for (let i = 0; i < w; i++) {
      const r = closes[i] - (intercept + slope * i);
      sq += r * r;
    }
    const band = Math.max(2 * Math.sqrt(sq / w), 1e-6);
    const midS = intercept, midE = intercept + slope * (w - 1);
    const upE = midE + band, dnE = midE - band;
    const lastC = closes[w - 1];
    const posPct = Math.max(0, Math.min(100, ((lastC - dnE) / (upE - dnE)) * 100));
    const slopeAnn = yMean > 0 ? (slope * 242 / yMean) * 100 : 0;

    let direction = "横向箱体通道", bias = "neutral";
    if (slopeAnn >= 12) { direction = "上行通道"; bias = "bullish"; }
    else if (slopeAnn <= -12) { direction = "下行通道"; bias = "bearish"; }

    let posState = "中轨下方运行（通道偏弱）";
    if (lastC > upE) posState = "突破上轨（短线超买/加速）";
    else if (posPct >= 78) posState = "逼近上轨压力区";
    else if (posPct >= 52) posState = "中轨上方运行（通道偏强）";
    else if (posPct >= 22) posState = "中轨下方运行（通道偏弱）";
    else if (lastC >= dnE) posState = "回踩下轨支撑区";
    else posState = "跌破下轨（短线超卖/加速）";

    const d20 = bars.slice(-Math.min(bars.length, 20));
    const donchianHi = Math.max(...d20.map((b) => Number(b.high)));
    const donchianLo = Math.min(...d20.map((b) => Number(b.low)));

    return {
      direction,
      bias,
      slope_ann_pct: roundOpt(slopeAnn, 1),
      pos_pct: roundOpt(posPct, 1),
      pos_state: posState,
      upper: roundOpt(upE, decimals),
      mid: roundOpt(midE, decimals),
      lower: roundOpt(dnE, decimals),
      donchian_20_high: roundOpt(donchianHi, decimals),
      donchian_20_low: roundOpt(donchianLo, decimals),
      summary: `60日回归呈${direction}（年化斜率 ${slopeAnn >= 0 ? "+" : ""}${slopeAnn.toFixed(1)}%），下轨支撑 ${dnE.toFixed(decimals)} / 中轨 ${midE.toFixed(decimals)} / 上轨压力 ${upE.toFixed(decimals)}；现价处于通道 ${posPct.toFixed(0)}% 分位，${posState}。`,
      lines: {
        start_date: seg[0].date,
        end_date: seg[w - 1].date,
        upper: [roundOpt(midS + band, decimals), roundOpt(upE, decimals)],
        mid: [roundOpt(midS, decimals), roundOpt(midE, decimals)],
        lower: [roundOpt(midS - band, decimals), roundOpt(dnE, decimals)],
      },
    };
  }

  function _barsFromTechItem(item) {
    if (!item || !item.dates || !item.ohlc) return [];
    return item.dates.map((d, i) => ({
      date: d,
      open: item.ohlc[i][0],
      close: item.ohlc[i][1],
      low: item.ohlc[i][2],
      high: item.ohlc[i][3],
      volume: item.volumes ? item.volumes[i] : null,
    }));
  }

  function _fmtSigned(v, d = 1) {
    if (v == null || !Number.isFinite(v)) return "—";
    return (v >= 0 ? "+" : "") + Number(v).toFixed(d);
  }

  function generateLiveBriefing(D, generatedAt) {
    if (!D || !D.convergence || !D.national_team || !D.technical) return D && D.morning_briefing;
    const ts = generatedAt || nowCstFull();
    const editionDate = ts.slice(0, 10);
    const cs = D.convergence.summary;
    const gs = D.national_team.summary;

    // 1. 股债收敛
    let convTag, convBias, convView;
    if (cs.is_currently_below) {
      convTag = "极值跌破·高赔率区间";
      convBias = "bullish";
      convView = `沪深300全收益已跌破二级债基基准（剪刀差 ${_fmtSigned(cs.spread_pct, 1)}pct），历史上仅出现 ${cs.episode_count} 次同类极值，长期股债性价比处于右侧配置窗口。`;
    } else if (cs.spread_pct < 60) {
      convTag = "收敛蓄势·中性偏积极";
      convBias = "neutral";
      convView = `300全收益较二级债基领先 ${_fmtSigned(cs.spread_pct, 1)}pct（净值比 ${cs.ratio_300_to_bond2}x），处于中低溢价收敛带，可结合成长宽基通道企稳节奏分批布局。`;
    } else {
      convTag = "权益溢价·防波动回撤";
      convBias = "neutral";
      convView = `300全收益累计 ${_fmtSigned(cs.csi300_cum_pct, 1)}% 领先二级债基 ${_fmtSigned(cs.spread_pct, 1)}pct（净值比 ${cs.ratio_300_to_bond2}x），距历史${cs.episode_count}次跌破极值区尚有缓冲，注重波段节奏与回撤控制。`;
    }

    // 2. 国家队份额
    const f1 = Number(gs.flow_1d_yi || 0);
    const f5 = Number(gs.flow_5d_yi || 0);
    const f20 = Number(gs.flow_20d_yi || 0);
    let gjdTag, gjdBias, gjdView;
    if (f1 > 50 || f5 > 100) {
      gjdTag = "显著净申购·托底信号强";
      gjdBias = "bullish";
      gjdView = `16只重仓宽基ETF总份额升至 ${Number(gs.total_shares_yi).toFixed(1)} 亿份，单日估算净流入 ${_fmtSigned(f1, 1)} 亿元（近5日 ${_fmtSigned(f5, 1)} 亿），大资金低位托底意愿明显。`;
    } else if (f1 < -50 || f5 < -100) {
      gjdTag = "阶段净赎回·逢高兑现";
      gjdBias = "bearish";
      gjdView = `监控宽基ETF总份额 ${Number(gs.total_shares_yi).toFixed(1)} 亿份，单日净流出 ${_fmtSigned(f1, 1)} 亿元（近5日 ${_fmtSigned(f5, 1)} 亿），需留意权重宽基上方筹码消化压力。`;
    } else {
      gjdTag = "份额平稳·存量博弈";
      gjdBias = "neutral";
      gjdView = `监控宽基ETF总份额 ${Number(gs.total_shares_yi).toFixed(1)} 亿份，单日净申赎 ${_fmtSigned(f1, 1)} 亿元（近20日 ${_fmtSigned(f20, 1)} 亿），平准资金整体按兵不动，市场以存量结构轮动为主。`;
    }

    const buildTechCard = (idxNum, href, key, label) => {
      const it = D.technical[key];
      const dec = it.meta.decimals;
      const u = it.meta.price_unit;
      const s = it.summary;
      const bars = _barsFromTechItem(it);
      const w = (it.wave && it.wave.bias) ? it.wave : computeWaveOverlay(bars, dec, 0.06);
      const ch = (it.channel && it.channel.pos_state) ? it.channel : computeChannelOverlay(bars, 60, dec);
      it.wave = w;
      it.channel = ch;

      let action;
      const fib50 = w.fib_levels && w.fib_levels.f500 != null ? w.fib_levels.f500.toFixed(dec) : ch.mid.toFixed(dec);
      if (w.bias === "bearish" && ch.pos_pct <= 25) {
        action = `波浪偏空叠加通道下轨超卖（分位 ${ch.pos_pct.toFixed(0)}%），切忌盲目追空，重点观察 ${ch.lower.toFixed(dec)} 支撑位是否出现底背离或内部 CHoCH 企稳信号。`;
      } else if (w.bias === "bullish" && ch.pos_pct >= 78) {
        action = `多头推动浪运行至通道上轨压力区（${ch.upper.toFixed(dec)}），顺势持有同时防范短线乖离回踩中轨 ${ch.mid.toFixed(dec)}。`;
      } else if (w.bias === "bullish") {
        action = `波浪与通道共振偏多，以中轨 ${ch.mid.toFixed(dec)} / 斐波那契 50% (${fib50}) 为防守参照。`;
      } else {
        action = `当前处于${w.wave_stage}与${ch.direction}共振区，上方阻力看中轨 ${ch.mid.toFixed(dec)}，下方防守看下轨 ${ch.lower.toFixed(dec)}。`;
      }

      return {
        index: idxNum,
        href,
        key,
        title: label,
        code: it.meta.display_code,
        price_text: `${Number(s.close).toFixed(dec)} ${u}`,
        change_pct: s.change_pct,
        bias: w.bias,
        wave_stage: w.wave_stage,
        channel_stage: `${ch.direction} · ${ch.pos_state.split("（")[0]}（${ch.pos_pct.toFixed(0)}%）`,
        key_levels: {
          support: ch.lower.toFixed(dec),
          mid: ch.mid.toFixed(dec),
          resistance: ch.upper.toFixed(dec),
          fib50,
        },
        view: action,
      };
    };

    const starCard = buildTechCard(3, "#sec-star50", "star50", "科创50");
    const cybCard = buildTechCard(4, "#sec-cyb", "cyb", "创业板指");

    const items = [
      {
        index: 1,
        href: "#sec-convergence",
        key: "convergence",
        title: "股债波动收敛",
        code: "H00300 vs 885007",
        price_text: `剪刀差 ${_fmtSigned(cs.spread_pct, 1)} pct`,
        change_pct: null,
        bias: convBias,
        wave_stage: `长周期估值锚 · 历史跌破 ${cs.episode_count} 次`,
        channel_stage: convTag,
        key_levels: {
          support: "0% 跌破线",
          mid: `300: ${_fmtSigned(cs.csi300_cum_pct, 0)}%`,
          resistance: `债基: ${_fmtSigned(cs.bond2_cum_pct, 0)}%`,
        },
        view: convView,
      },
      {
        index: 2,
        href: "#sec-gjd",
        key: "national_team",
        title: "国家队宽基份额",
        code: "16只核心宽基ETF",
        price_text: `${Number(gs.total_shares_yi).toFixed(1)} 亿份`,
        change_pct: null,
        bias: gjdBias,
        wave_stage: `单日净流入 ${_fmtSigned(f1, 1)} 亿元`,
        channel_stage: gjdTag,
        key_levels: {
          support: `5日 ${_fmtSigned(f5, 0)}亿`,
          mid: `20日 ${_fmtSigned(f20, 0)}亿`,
          resistance: `规模 ${Number(gs.total_aum_yi).toFixed(0)}亿`,
        },
        view: gjdView,
      },
      starCard,
      cybCard,
    ];

    const bearCnt = [starCard, cybCard].filter((c) => c.bias === "bearish").length;
    const bullCnt = [starCard, cybCard].filter((c) => c.bias === "bullish").length;
    let headline;
    if (bearCnt === 2 && gjdBias === "bullish") {
      headline = "核心定调：科创50与创业板指处于下行通道/调整浪探底区，但国家队宽基ETF出现显著净申购托底，重点观察通道下轨与波浪背离共振企稳机会。";
    } else if (bearCnt === 2) {
      headline = "核心定调：成长宽基仍处下行通道与空头调整浪内，多看少动、紧盯通道下轨支撑与内部结构 CHoCH 反转确认。";
    } else if (bullCnt === 2) {
      headline = "核心定调：成长宽基多头推动浪与上行通道共振延续，顺势跟踪同时留意通道上轨压力与中轨防守。";
    } else {
      headline = "核心定调：A股核心宽基呈结构性分化与箱体震荡，紧扣股债性价比、国家队资金动向与通道上下轨节奏操作。";
    }

    const lines = [`【A股实时波浪与通道投研简报｜${editionDate}】`, headline, ""];
    for (const it of items) {
      const chgStr = it.change_pct != null ? `（${_fmtSigned(it.change_pct, 2)}%）` : "";
      lines.push(`${it.index}. ${it.title}（${it.code}）${it.price_text}${chgStr}`);
      lines.push(`   · 波浪/周期：${it.wave_stage} ｜ 通道/资金：${it.channel_stage}`);
      lines.push(`   · 关键参照：下沿/支撑 ${it.key_levels.support} ｜ 中轴 ${it.key_levels.mid} ｜ 上沿/压力 ${it.key_levels.resistance}`);
      lines.push(`   · 简评：${it.view}`);
    }
    lines.push("", `实时生成时间：${ts}（按最新实时行情即时生成，仅供参考不构成投资建议）`);

    return {
      edition_date: editionDate,
      scheduled_time: "实时行情动态生成",
      generated_at: ts,
      headline,
      items,
      plain_text: lines.join("\n"),
    };
  }

  function generateGoldBriefing(D, generatedAt) {
    if (!D || !D.technical || !D.technical.gold_xau) return D && D.gold_briefing;
    const ts = generatedAt || nowCstFull();
    const editionDate = ts.slice(0, 10);
    const xau = D.technical.gold_xau;
    const dec = xau.meta.decimals;
    const sx = xau.summary;
    const bars = _barsFromTechItem(xau);
    const w = (xau.wave && xau.wave.bias) ? xau.wave : computeWaveOverlay(bars, dec, 0.045);
    const ch = (xau.channel && xau.channel.pos_state) ? xau.channel : computeChannelOverlay(bars, 60, dec);
    xau.wave = w;
    xau.channel = ch;

    const gStk = D.technical.gold_stock_etf && D.technical.gold_stock_etf.summary;
    const gEtf = D.technical.gold_etf && D.technical.gold_etf.summary;
    const etfHint = gStk && gEtf
      ? ` 国内映射：黄金股ETF ${Number(gStk.close).toFixed(3)}（${_fmtSigned(gStk.change_pct, 2)}%），黄金ETF ${Number(gEtf.close).toFixed(3)}（${_fmtSigned(gEtf.change_pct, 2)}%）。`
      : "";
    const fib50 = w.fib_levels && w.fib_levels.f500 != null ? w.fib_levels.f500.toFixed(dec) : ch.mid.toFixed(dec);

    let goldView;
    if (w.bias === "bearish" && ch.pos_pct <= 25) {
      goldView = `波浪偏空叠加通道下轨超卖（分位 ${ch.pos_pct.toFixed(0)}%），切忌盲目追空，重点观察 ${ch.lower.toFixed(dec)} 支撑位是否出现底背离或内部 CHoCH 企稳信号。`;
    } else if (w.bias === "bullish" && ch.pos_pct >= 78) {
      goldView = `多头推动浪运行至通道上轨压力区（${ch.upper.toFixed(dec)}），顺势持有同时防范短线乖离回踩中轨 ${ch.mid.toFixed(dec)}。`;
    } else if (w.bias === "bullish") {
      goldView = `波浪与通道共振偏多，以中轨 ${ch.mid.toFixed(dec)} / 斐波那契 50% (${fib50}) 为防守参照。`;
    } else {
      goldView = `当前处于${w.wave_stage}与${ch.direction}共振区，上方阻力看中轨 ${ch.mid.toFixed(dec)}，下方防守看下轨 ${ch.lower.toFixed(dec)}。`;
    }
    goldView += etfHint;

    const items = [
      {
        index: 1,
        href: "#sec-gold-main",
        key: "gold_xau",
        title: "伦敦金现 (XAU/USD)",
        code: xau.meta.display_code,
        price_text: `${Number(sx.close).toFixed(dec)} 美元/盎司`,
        change_pct: sx.change_pct,
        bias: w.bias,
        wave_stage: w.wave_stage,
        channel_stage: `${ch.direction} · ${ch.pos_state.split("（")[0]}（${ch.pos_pct.toFixed(0)}%）`,
        key_levels: {
          support: ch.lower.toFixed(dec),
          mid: ch.mid.toFixed(dec),
          resistance: ch.upper.toFixed(dec),
        },
        view: goldView,
      },
    ];

    const seriesMap = (D.gold_macro && D.gold_macro.series) || {};
    const dxy = seriesMap.dxy;
    const us10y = seriesMap.us10y;
    const us2y = seriesMap.us2y;
    const sp = D.gold_macro && D.gold_macro.spread_10y_2y;
    let macroPressure = 0;

    if (dxy && dxy.summary) {
      const sd = dxy.summary;
      const r20 = Number(sd.ret_20d || 0);
      let dxyBias = "neutral", dxyTag = "美元震荡 · 中性影响";
      if (r20 >= 1.5) { dxyBias = "bearish"; dxyTag = "美元走强 · 压制金价"; macroPressure += 1; }
      else if (r20 <= -1.5) { dxyBias = "bullish"; dxyTag = "美元走弱 · 利好金价"; macroPressure -= 1; }
      items.push({
        index: 2,
        href: "#sec-gold-macro",
        key: "dxy",
        title: "美元指数 (DXY)",
        code: "100.UDI",
        price_text: Number(sd.close).toFixed(2),
        change_pct: sd.change_pct,
        bias: dxyBias,
        wave_stage: sd.ret_20d != null ? `20日 ${_fmtSigned(sd.ret_20d, 2)}%` : "实时跟踪",
        channel_stage: dxyTag,
        key_levels: {
          support: sd.ret_5d != null ? `5日 ${_fmtSigned(sd.ret_5d, 2)}%` : "—",
          mid: `现值 ${Number(sd.close).toFixed(2)}`,
          resistance: sd.ret_60d != null ? `60日 ${_fmtSigned(sd.ret_60d, 2)}%` : "—",
        },
        view: `美元指数最新报 ${Number(sd.close).toFixed(2)}（日变动 ${_fmtSigned(sd.change_pct, 2)}%），近20个交易日变动 ${_fmtSigned(r20, 2)}%；美元强弱直接影响以美元计价的国际金价定价中枢。`,
      });
    }

    if (us10y && us2y && us10y.summary && us2y.summary) {
      const s10 = us10y.summary;
      const s2 = us2y.summary;
      const bp20_10 = Number(s10.chg_20d_bp || 0);
      const bp20_2 = Number(s2.chg_20d_bp || 0);
      let yBias = "neutral", yTag = "美债利率窄幅震荡";
      if (bp20_10 >= 15) { yBias = "bearish"; yTag = "美债利率上行 · 抬升机会成本"; macroPressure += 1; }
      else if (bp20_10 <= -15) { yBias = "bullish"; yTag = "美债利率回落 · 利好无息黄金"; macroPressure -= 1; }
      const spTxt = sp ? `10Y−2Y利差 ${_fmtSigned(sp.latest_bp, 1)}bp（${sp.is_inverted ? "倒挂" : "正斜率"}）` : "实时跟踪";
      items.push({
        index: 3,
        href: "#sec-gold-macro",
        key: "us_yields",
        title: "美国10Y / 2Y国债收益率",
        code: "US10Y / US2Y",
        price_text: `${Number(s10.close).toFixed(3)}% / ${Number(s2.close).toFixed(3)}%`,
        change_pct: s10.change_pct,
        bias: yBias,
        wave_stage: spTxt,
        channel_stage: yTag,
        key_levels: {
          support: `10Y: ${Number(s10.close).toFixed(3)}%`,
          mid: `2Y: ${Number(s2.close).toFixed(3)}%`,
          resistance: `10Y 20日 ${_fmtSigned(bp20_10, 0)}bp`,
        },
        view: `美国10年期国债收益率报 ${Number(s10.close).toFixed(3)}%（日变动 ${_fmtSigned(s10.change_bp, 1)}bp，近20日 ${_fmtSigned(bp20_10, 1)}bp），2年期报 ${Number(s2.close).toFixed(3)}%（近20日 ${_fmtSigned(bp20_2, 1)}bp），${spTxt}。`,
      });
    }

    let headline;
    if (w.bias === "bullish" && macroPressure <= 0) {
      headline = "黄金实时定调：伦敦金现技术结构偏多且美元/美债利率未构成强压制，宏观与技术共振向好，顺势跟踪通道中轨与前高突破。";
    } else if (w.bias === "bearish" && macroPressure >= 1) {
      headline = "黄金实时定调：美元与美债收益率偏强叠加金价处于调整浪/下行通道，短线承压，重点观察通道下轨与利率拐点共振。";
    } else if (w.bias === "bearish") {
      headline = "黄金实时定调：金价技术面处于调整浪/回调阶段，紧盯 60 日通道下轨与美债 10Y/2Y 收益率回落催化。";
    } else {
      headline = "黄金实时定调：金价与美元、美债收益率进入博弈震荡区，结合 10Y−2Y 期限利差变化与 SMC 订单块关键位高抛低吸。";
    }

    const lines = [`【黄金与美元/美债实时投研简报｜${editionDate}】`, headline, ""];
    for (const it of items) {
      lines.push(`${it.index}. ${it.title}（${it.code}）${it.price_text}`);
      lines.push(`   · 趋势/利差：${it.wave_stage} ｜ 宏观/通道：${it.channel_stage}`);
      lines.push(`   · 简评：${it.view}`);
    }
    lines.push("", `实时生成时间：${ts}（按最新实时行情即时生成，仅供参考不构成投资建议）`);

    return {
      edition_date: editionDate,
      scheduled_time: "实时行情动态生成",
      generated_at: ts,
      headline,
      items,
      plain_text: lines.join("\n"),
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

  async function fetchSinaGlobalFuturesKline(symbol = "XAU", count = 520) {
    const varName = "__SINA_GFUT_" + symbol + "_" + Math.floor(Math.random() * 100000);
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/window.${varName}=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${encodeURIComponent(symbol)}&_=${Date.now()}`;
    const arr = await loadJsonpVar(url, varName, 9000);
    try { delete global[varName]; } catch (_) {}
    const bars = [];
    for (const r of arr) {
      const o = Number(r.open ?? r.o ?? 0);
      const h = Number(r.high ?? r.h ?? 0);
      const l = Number(r.low ?? r.l ?? 0);
      const c = Number(r.close ?? r.c ?? 0);
      if (Math.min(o, h, l, c) <= 0) continue;
      const vol = Number(r.volume ?? r.v ?? 0);
      bars.push({
        date: String(r.date ?? r.d),
        open: o,
        high: Math.max(h, o, c),
        low: Math.min(l, o, c),
        close: c,
        volume: vol > 0 ? vol : null,
      });
    }
    bars.sort((a, b) => a.date.localeCompare(b.date));
    return bars.length > count ? bars.slice(-count) : bars;
  }

  async function fetchSinaForexKline(symbol = "DINIW", count = 520) {
    const varName = "__SINA_FX_" + symbol + "_" + Math.floor(Math.random() * 100000);
    const url = `https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/window.${varName}=/NewForexService.getDayKLine?symbol=${encodeURIComponent(symbol)}&_=${Date.now()}`;
    const rawStr = await loadJsonpVar(url, varName, 9000);
    try { delete global[varName]; } catch (_) {}
    if (typeof rawStr !== "string" || !rawStr.trim()) throw new Error("empty sina forex");
    const bars = [];
    for (const seg of rawStr.split("|")) {
      const p = seg.trim().split(",");
      if (p.length < 5 || !p[0]) continue;
      const o = Number(p[1]), l = Number(p[2]), h = Number(p[3]), c = Number(p[4]);
      if (Math.min(o, l, h, c) <= 0) continue;
      bars.push({ date: p[0], open: o, low: Math.min(l, o, c), high: Math.max(h, o, c), close: c, volume: null });
    }
    bars.sort((a, b) => a.date.localeCompare(b.date));
    return bars.length > count ? bars.slice(-count) : bars;
  }

  function loadJsonpCallback(urlBase, cbParam = "callback", timeoutMs = 9000) {
    return new Promise((resolve, reject) => {
      const cbName = "__EM_JSONP_" + Math.floor(Math.random() * 1000000) + "_" + Date.now();
      const script = document.createElement("script");
      let done = false;
      const cleanup = () => {
        try { delete global[cbName]; } catch (_) { global[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          cleanup();
          reject(new Error("JSONP callback timeout"));
        }
      }, timeoutMs);
      global[cbName] = (payload) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        resolve(payload);
      };
      script.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error("JSONP callback error"));
      };
      const sep = urlBase.includes("?") ? "&" : "?";
      script.src = `${urlBase}${sep}${cbParam}=${cbName}&_=${Date.now()}`;
      script.async = true;
      document.head.appendChild(script);
    });
  }

  async function fetchEastmoneyDatacenterYields(count = 520) {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD&columns=SOLAR_DATE,EMG00001306,EMG00001308&sortColumns=SOLAR_DATE&sortTypes=-1&pageSize=${count + 60}&pageNumber=1`;
    const payload = await loadJsonpCallback(url, "callback", 9000);
    const rows = (payload && payload.result && payload.result.data) || [];
    const us10y = [];
    const us2y = [];
    for (const r of rows) {
      const dt = String(r.SOLAR_DATE || "").slice(0, 10);
      if (dt.length !== 10) continue;
      const v10 = Number(r.EMG00001308);
      const v2 = Number(r.EMG00001306);
      if (Number.isFinite(v10) && v10 > 0) {
        us10y.push({ date: dt, open: v10, high: v10, low: v10, close: v10, volume: null });
      }
      if (Number.isFinite(v2) && v2 > 0) {
        us2y.push({ date: dt, open: v2, high: v2, low: v2, close: v2, volume: null });
      }
    }
    us10y.sort((a, b) => a.date.localeCompare(b.date));
    us2y.sort((a, b) => a.date.localeCompare(b.date));
    if (!us10y.length || !us2y.length) throw new Error("empty datacenter yields");
    return {
      us10y: us10y.slice(-count),
      us2y: us2y.slice(-count),
    };
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
      bars.push({ date: p[0], open: o, close: c, high: Math.max(h, o, c), low: Math.min(l, o, c), volume: v > 0 ? v : null });
    }
    bars.sort((a, b) => a.date.localeCompare(b.date));
    return bars;
  }

  function unixToCstDate(ts) {
    if (!Number.isFinite(ts) || ts < 1e9) return null;
    const d = new Date(ts * 1000 + 8 * 3600000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  async function fetchEastmoneyQuotes(secids) {
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f4,f12,f14,f15,f16,f17,f18,f124&secids=${secids.join(",")}&_=${Date.now()}`;
    const resp = await fetchWithTimeout(url, 7000);
    const json = await resp.json();
    const diff = (json && json.data && json.data.diff) || [];
    const out = {};
    const numOpt = (v) => (v !== "-" && v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    for (const row of diff) {
      if (row && row.f12 && row.f2 !== "-") {
        out[row.f12] = {
          price: numOpt(row.f2),
          change_pct: numOpt(row.f3),
          change_amt: numOpt(row.f4),
          high: numOpt(row.f15),
          low: numOpt(row.f16),
          open: numOpt(row.f17),
          last_close: numOpt(row.f18),
          quote_date: unixToCstDate(Number(row.f124)),
        };
      }
    }
    return out;
  }

  function buildMacroSeriesItem(prevMeta, bars, quote, sourceLabel) {
    const dec = (prevMeta && prevMeta.decimals) || 2;
    const isYield = prevMeta && prevMeta.unit === "%";
    let merged = bars.slice();
    if (quote && quote.price > 0 && merged.length) {
      const lastDate = merged[merged.length - 1].date;
      const qDate = quote.quote_date && quote.quote_date >= lastDate ? quote.quote_date : lastDate;
      merged = mergeIntradayBar(merged, { ...quote, quote_date: qDate });
    }
    const dates = merged.map((b) => b.date);
    const closes = merged.map((b) => roundOpt(b.close, dec));
    const ohlc = merged.map((b) => [roundOpt(b.open, dec), roundOpt(b.close, dec), roundOpt(b.low, dec), roundOpt(b.high, dec)]);
    const n = closes.length;
    const lastC = closes[n - 1];
    const prevC = n >= 2 ? closes[n - 2] : lastC;
    let chgAmt = roundOpt(lastC - prevC, dec);
    let chgPct = prevC > 0 ? roundOpt(((lastC / prevC) - 1) * 100, 2) : 0;
    if (quote && quote.change_pct != null) chgPct = roundOpt(quote.change_pct, 2);
    if (quote && quote.change_amt != null) chgAmt = roundOpt(quote.change_amt, dec);

    const retN = (k) => (n > k && closes[n - 1 - k] > 0 ? roundOpt(((lastC / closes[n - 1 - k]) - 1) * 100, 2) : null);
    const diffBp = (k) => (isYield && n > k ? roundOpt((lastC - closes[n - 1 - k]) * 100, 1) : null);

    return {
      meta: {
        ...prevMeta,
        source: sourceLabel,
        bar_count: n,
        date_range: [dates[0], dates[n - 1]],
      },
      dates,
      closes,
      ohlc,
      summary: {
        latest_date: dates[n - 1],
        close: lastC,
        change_amt: chgAmt,
        change_pct: chgPct,
        change_bp: isYield ? roundOpt(chgAmt * 100, 1) : null,
        ret_5d: retN(5),
        ret_20d: retN(20),
        ret_60d: retN(60),
        chg_5d_bp: diffBp(5),
        chg_20d_bp: diffBp(20),
        chg_60d_bp: diffBp(60),
      },
    };
  }

  function computeSpread10y2y(us10y, us2y) {
    if (!us10y || !us2y || !us10y.dates || !us2y.dates) return null;
    const m10 = {};
    const m2 = {};
    us10y.dates.forEach((d, i) => { m10[d] = us10y.closes[i]; });
    us2y.dates.forEach((d, i) => { m2[d] = us2y.closes[i]; });
    const allDates = Array.from(new Set([...us10y.dates, ...us2y.dates])).sort();
    const dates = [];
    const spread_bp = [];
    let l10 = null, l2 = null;
    for (const d of allDates) {
      if (m10[d] != null) l10 = m10[d];
      if (m2[d] != null) l2 = m2[d];
      if (l10 != null && l2 != null) {
        dates.push(d);
        spread_bp.push(roundOpt((l10 - l2) * 100, 1));
      }
    }
    if (!dates.length) return null;
    const cur = spread_bp[spread_bp.length - 1];
    const prev = spread_bp.length >= 2 ? spread_bp[spread_bp.length - 2] : cur;
    return {
      dates,
      spread_bp,
      latest_date: dates[dates.length - 1],
      latest_bp: cur,
      change_bp: roundOpt(cur - prev, 1),
      is_inverted: cur < 0,
    };
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
    } else if (pageMode === "gold") {
      // Standalone Gold + DXY + US10Y/US2Y Yield Dashboard
      const fetchXauBars = () =>
        fetchSinaGlobalFuturesKline("XAU", 520).catch(() => fetchEastmoneyKline("122.XAU", 520));
      const fetchDxyBars = () =>
        fetchEastmoneyKline("100.UDI", 520).catch(() => fetchSinaForexKline("DINIW", 520));
      let dcYieldPromise = null;
      const getDcYields = () => {
        if (!dcYieldPromise) dcYieldPromise = fetchEastmoneyDatacenterYields(520);
        return dcYieldPromise;
      };
      const fetchUs10yBars = () =>
        fetchEastmoneyKline("171.US10Y", 520).catch(() => getDcYields().then((d) => d.us10y));
      const fetchUs2yBars = () =>
        fetchEastmoneyKline("171.US2Y", 520).catch(() => getDcYields().then((d) => d.us2y));

      const [
        tqRes,
        goldXauRes,
        goldStockEtfRes,
        goldEtfRes,
        dxyRes,
        us10yRes,
        us2yRes,
        emQRes,
      ] = await Promise.allSettled([
        fetchTencentQuotes(["sh517520", "sh518880"]),
        fetchXauBars(),
        fetchTencentKline("sh517520", 520, "qfq"),
        fetchTencentKline("sh518880", 520, "qfq"),
        fetchDxyBars(),
        fetchUs10yBars(),
        fetchUs2yBars(),
        fetchEastmoneyQuotes(["122.XAU", "100.UDI", "171.US10Y", "171.US2Y"]),
      ]);

      const tq = tqRes.status === "fulfilled" ? tqRes.value : {};
      const emQ = emQRes.status === "fulfilled" ? emQRes.value : {};

      // 1. 伦敦金现 XAU/USD
      if (goldXauRes.status === "fulfilled") {
        const prev = D.technical.gold_xau.meta;
        let bars = goldXauRes.value;
        const qXau = emQ.XAU;
        if (qXau && qXau.price > 0) {
          const lastD = bars[bars.length - 1].date;
          const qDate = qXau.quote_date && qXau.quote_date >= lastD ? qXau.quote_date : lastD;
          bars = mergeIntradayBar(bars, { ...qXau, quote_date: qDate });
        }
        D.technical.gold_xau = analyzeTechnicalSeries(bars, { ...prev, source: "新浪外盘 + 伦敦金现实时直连" }, prev.decimals);
        if (qXau && Number.isFinite(qXau.change_pct)) {
          D.technical.gold_xau.summary.change_pct = roundOpt(qXau.change_pct, 2);
        }
        synced.push("伦敦金现实时");
      } else {
        failed.push("伦敦金现");
      }

      // 2. 黄金股ETF sh517520
      if (goldStockEtfRes.status === "fulfilled") {
        const prev = D.technical.gold_stock_etf.meta;
        const merged = mergeIntradayBar(goldStockEtfRes.value, tq.sh517520);
        D.technical.gold_stock_etf = analyzeTechnicalSeries(merged, { ...prev, source: "腾讯财经实时直连 (前复权)" }, prev.decimals);
        if (tq.sh517520 && Number.isFinite(tq.sh517520.change_pct)) {
          D.technical.gold_stock_etf.summary.change_pct = roundOpt(tq.sh517520.change_pct, 2);
        }
        synced.push("黄金股ETF实时");
      } else {
        failed.push("黄金股ETF");
      }

      // 3. 黄金ETF sh518880
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

      // 4. Macro series: DXY / US10Y / US2Y
      D.gold_macro = D.gold_macro || { latest_date: "", series: {}, spread_10y_2y: null };
      D.gold_macro.series = D.gold_macro.series || {};

      const defaultMeta = {
        dxy: { key: "dxy", title: "美元指数 (DXY)", code: "UDI", display_code: "DXY", secid: "100.UDI", unit: "点", decimals: 2 },
        us10y: { key: "us10y", title: "美国10年期国债收益率", code: "US10Y", display_code: "US10Y", secid: "171.US10Y", unit: "%", decimals: 3 },
        us2y: { key: "us2y", title: "美国2年期国债收益率", code: "US2Y", display_code: "US2Y", secid: "171.US2Y", unit: "%", decimals: 3 },
      };

      if (dxyRes.status === "fulfilled") {
        const prevMeta = (D.gold_macro.series.dxy && D.gold_macro.series.dxy.meta) || defaultMeta.dxy;
        D.gold_macro.series.dxy = buildMacroSeriesItem(prevMeta, dxyRes.value, emQ.UDI, "东方财富实时直连 (DXY)");
        synced.push("美元指数实时");
      } else {
        failed.push("美元指数");
      }

      if (us10yRes.status === "fulfilled") {
        const prevMeta = (D.gold_macro.series.us10y && D.gold_macro.series.us10y.meta) || defaultMeta.us10y;
        D.gold_macro.series.us10y = buildMacroSeriesItem(prevMeta, us10yRes.value, emQ.US10Y, "东方财富实时直连 (US10Y)");
        synced.push("美债10Y实时");
      } else {
        failed.push("美债10Y");
      }

      if (us2yRes.status === "fulfilled") {
        const prevMeta = (D.gold_macro.series.us2y && D.gold_macro.series.us2y.meta) || defaultMeta.us2y;
        D.gold_macro.series.us2y = buildMacroSeriesItem(prevMeta, us2yRes.value, emQ.US2Y, "东方财富实时直连 (US2Y)");
        synced.push("美债2Y实时");
      } else {
        failed.push("美债2Y");
      }

      D.gold_macro.spread_10y_2y = computeSpread10y2y(D.gold_macro.series.us10y, D.gold_macro.series.us2y);
      const macroDates = Object.values(D.gold_macro.series)
        .map((m) => m && m.summary && m.summary.latest_date)
        .filter(Boolean);
      if (macroDates.length) D.gold_macro.latest_date = macroDates.sort().pop();

      const allGoldDates = [
        ...["gold_xau", "gold_stock_etf", "gold_etf"].map((k) => D.technical[k] && D.technical[k].summary && D.technical[k].summary.latest_date),
        D.gold_macro.latest_date,
      ].filter(Boolean);
      if (allGoldDates.length) D.meta.latest_market_date = allGoldDates.sort().pop();

      // Always regenerate live gold briefing from freshest data!
      D.gold_briefing = generateGoldBriefing(D, syncTime);
    } else {
      // Main Market 4-item dashboard (Gold separated to gold.html): fetch live feeds in parallel!
      const etfCodes = (D.national_team && D.national_team.etfs ? D.national_team.etfs.map((e) => e.code) : []);
      const quoteCodes = ["sh000300", "sh000688", "sz399006", ...etfCodes];

      const [
        quotesRes,
        star50Res,
        cybRes,
        csi300Res,
      ] = await Promise.allSettled([
        fetchTencentQuotes(quoteCodes),
        fetchTencentKline("sh000688", 520, "qfq"),
        fetchTencentKline("sz399006", 520, "qfq"),
        fetchTencentKline("sh000300", 60, ""),
      ]);

      const tq = quotesRes.status === "fulfilled" ? quotesRes.value : {};

      // 1. Update Module 1 (沪深300全收益 tail extension via live sh000300 daily returns)
      if (csi300Res.status === "fulfilled" && D.convergence && D.convergence.dates.length) {
        try {
          const c = D.convergence;
          let bars300 = mergeIntradayBar(csi300Res.value, tq.sh000300);
          const lastBaseDate = c.dates[c.dates.length - 1];
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

      // 4. Update Module 4 (创业板指 sz399006)
      if (cybRes.status === "fulfilled") {
        const prev = D.technical.cyb.meta;
        const merged = mergeIntradayBar(cybRes.value, tq.sz399006);
        D.technical.cyb = analyzeTechnicalSeries(merged, { ...prev, source: "腾讯财经实时直连" }, prev.decimals);
        if (tq.sz399006 && Number.isFinite(tq.sz399006.change_pct)) {
          D.technical.cyb.summary.change_pct = roundOpt(tq.sz399006.change_pct, 2);
        }
        synced.push("创业板指实时日K");
      } else {
        failed.push("创业板指");
      }

      const techDates = ["star50", "cyb"]
        .map((k) => D.technical[k] && D.technical[k].summary && D.technical[k].summary.latest_date)
        .filter(Boolean);
      if (techDates.length) {
        D.meta.latest_market_date = techDates.sort().pop();
      }

      // Always regenerate live briefing from freshest market data!
      D.morning_briefing = generateLiveBriefing(D, syncTime);
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
    generateLiveBriefing,
    generateGoldBriefing,
    nowCstFull,
  };
})(window);
