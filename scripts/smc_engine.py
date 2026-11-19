"""
SMC (Smart Money Concepts / 聪明钱) + 经典技术分析指标引擎
提炼自《浅谈Trading view上最热的“聪明钱”指标》（LuxAlgo SMC 框架）：
- 双层市场结构：波段结构 (Swing, 实线) + 内部结构 (Internal, 虚线)
- 收盘价突破判定 BOS (结构延续) / CHoCH (特征改变)
- Strong High / Weak Low 或 Strong Low / Weak High 角色赋值
- 波动率过滤订单块 (Order Block, OB) + High/Low 口径失效移除
- 公允价值缺口 (Fair Value Gap, FVG)
- 溢价 / 均衡 / 折价区 (Premium / Equilibrium / Discount)
- 等高/等低流动性参照 (EQH / EQL)
- 显式记录 confirm_date，提示支点滞后与防未来函数 (Anti-Repainting)
"""

from __future__ import annotations

import math
from typing import Any


def _round_opt(val: float | None, digits: int = 3) -> float | None:
    if val is None or (isinstance(val, float) and (math.isnan(val) or math.isinf(val))):
        return None
    return round(float(val), digits)


def calc_sma(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    window_sum = sum(values[:period])
    out[period - 1] = window_sum / period
    for i in range(period, len(values)):
        window_sum += values[i] - values[i - period]
        out[i] = window_sum / period
    return out


def calc_ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    k = 2.0 / (period + 1.0)
    out = [values[0]]
    for i in range(1, len(values)):
        out.append(values[i] * k + out[-1] * (1.0 - k))
    return out


def calc_boll(closes: list[float], period: int = 20, mult: float = 2.0) -> dict[str, list[float | None]]:
    mid = calc_sma(closes, period)
    up: list[float | None] = [None] * len(closes)
    dn: list[float | None] = [None] * len(closes)
    for i in range(period - 1, len(closes)):
        m = mid[i]
        if m is None:
            continue
        seg = closes[i - period + 1 : i + 1]
        var = sum((x - m) ** 2 for x in seg) / period
        sd = math.sqrt(var)
        up[i] = m + mult * sd
        dn[i] = m - mult * sd
    return {"mid": mid, "up": up, "dn": dn}


def calc_macd(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> dict[str, list[float | None]]:
    if not closes:
        return {"dif": [], "dea": [], "hist": []}
    ema_fast = calc_ema(closes, fast)
    ema_slow = calc_ema(closes, slow)
    dif = [ema_fast[i] - ema_slow[i] for i in range(len(closes))]
    dea = calc_ema(dif, signal)
    hist = [(dif[i] - dea[i]) * 2.0 for i in range(len(closes))]
    return {"dif": dif, "dea": dea, "hist": hist}


def calc_rsi(closes: list[float], period: int = 14) -> list[float | None]:
    n = len(closes)
    out: list[float | None] = [None] * n
    if n <= period:
        return out
    gains = [0.0] * n
    losses = [0.0] * n
    for i in range(1, n):
        diff = closes[i] - closes[i - 1]
        if diff >= 0:
            gains[i] = diff
        else:
            losses[i] = -diff
    avg_gain = sum(gains[1 : period + 1]) / period
    avg_loss = sum(losses[1 : period + 1]) / period
    out[period] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    for i in range(period + 1, n):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        out[i] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    return out


def calc_atr(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> list[float]:
    n = len(closes)
    if n == 0:
        return []
    trs = [highs[0] - lows[0]]
    for i in range(1, n):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        trs.append(tr)
    atr = [trs[0]] * n
    if n > period:
        seed = sum(trs[:period]) / period
        for i in range(period):
            atr[i] = sum(trs[: i + 1]) / (i + 1)
        atr[period - 1] = seed
        for i in range(period, n):
            atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period
    else:
        for i in range(n):
            atr[i] = sum(trs[: i + 1]) / (i + 1)
    return atr


def _detect_structure_layer(
    bars: list[dict[str, Any]],
    atr: list[float],
    length: int,
    layer_name: str,
    eq_atr_factor: float = 0.15,
    decimals: int = 2,
) -> dict[str, Any]:
    """Run LuxAlgo-style fractal pivot + BOS/CHoCH + volatility-filtered OB + EQH/EQL for one layer."""
    n = len(bars)
    dates = [b["date"] for b in bars]
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    closes = [b["close"] for b in bars]

    # Volatility-filtered parsed high/low (LuxAlgo rule: abnormal wide bar >= 2*ATR swaps high/low)
    parsed_high = []
    parsed_low = []
    for i in range(n):
        bar_range = highs[i] - lows[i]
        if atr[i] > 0 and bar_range >= 2.0 * atr[i]:
            parsed_high.append(lows[i])
            parsed_low.append(highs[i])
        else:
            parsed_high.append(highs[i])
            parsed_low.append(lows[i])

    trend = 0  # 1 bullish, -1 bearish, 0 undetermined
    last_high: dict[str, Any] | None = None
    last_low: dict[str, Any] | None = None
    prev_swing_high: dict[str, Any] | None = None
    prev_swing_low: dict[str, Any] | None = None

    events: list[dict[str, Any]] = []
    order_blocks: list[dict[str, Any]] = []
    eq_levels: list[dict[str, Any]] = []
    pivots: list[dict[str, Any]] = []

    for i in range(n):
        # 1. Confirm fractal pivot at p = i - length (requires `length` bars on both sides)
        p = i - length
        if p >= length and i < n:
            left_h = highs[p - length : p]
            right_h = highs[p + 1 : i + 1]
            if highs[p] >= max(left_h) and highs[p] > max(right_h):
                new_h = {"idx": p, "date": dates[p], "confirm_idx": i, "confirm_date": dates[i], "price": highs[p], "crossed": False}
                pivots.append({"type": "H", **new_h})
                if prev_swing_high is not None and atr[i] > 0:
                    if abs(new_h["price"] - prev_swing_high["price"]) <= eq_atr_factor * atr[i] and (p - prev_swing_high["idx"]) >= length:
                        eq_levels.append({
                            "type": "EQH",
                            "layer": layer_name,
                            "start_date": prev_swing_high["date"],
                            "end_date": new_h["date"],
                            "confirm_date": dates[i],
                            "price": round((prev_swing_high["price"] + new_h["price"]) / 2.0, decimals),
                        })
                prev_swing_high = new_h
                last_high = new_h

            left_l = lows[p - length : p]
            right_l = lows[p + 1 : i + 1]
            if lows[p] <= min(left_l) and lows[p] < min(right_l):
                new_l = {"idx": p, "date": dates[p], "confirm_idx": i, "confirm_date": dates[i], "price": lows[p], "crossed": False}
                pivots.append({"type": "L", **new_l})
                if prev_swing_low is not None and atr[i] > 0:
                    if abs(new_l["price"] - prev_swing_low["price"]) <= eq_atr_factor * atr[i] and (p - prev_swing_low["idx"]) >= length:
                        eq_levels.append({
                            "type": "EQL",
                            "layer": layer_name,
                            "start_date": prev_swing_low["date"],
                            "end_date": new_l["date"],
                            "confirm_date": dates[i],
                            "price": round((prev_swing_low["price"] + new_l["price"]) / 2.0, decimals),
                        })
                prev_swing_low = new_l
                last_low = new_l

        # 2. Check existing active OBs for High/Low mitigation (失效移除)
        for ob in order_blocks:
            if ob["active"] and i > ob["created_idx"]:
                if ob["bias"] == "bullish" and lows[i] < ob["bottom"]:
                    ob["active"] = False
                    ob["mitigated_date"] = dates[i]
                elif ob["bias"] == "bearish" and highs[i] > ob["top"]:
                    ob["active"] = False
                    ob["mitigated_date"] = dates[i]

        # 3. Check close-price breakout of active structure highs / lows
        if last_high is not None and not last_high["crossed"] and closes[i] > last_high["price"]:
            kind = "CHoCH" if trend == -1 else "BOS"
            trend = 1
            last_high["crossed"] = True
            events.append({
                "layer": layer_name,
                "kind": kind,
                "bias": "bullish",
                "pivot_date": last_high["date"],
                "break_date": dates[i],
                "price": round(last_high["price"], decimals),
                "close": round(closes[i], decimals),
            })
            # Volatility-filtered Bullish Order Block: scan [last_high.idx, i - 1]
            lo_idx = last_high["idx"]
            hi_idx = max(lo_idx + 1, i)
            best_idx = min(range(lo_idx, hi_idx), key=lambda k: parsed_low[k])
            ob_top = max(parsed_high[best_idx], parsed_low[best_idx])
            ob_bot = min(parsed_high[best_idx], parsed_low[best_idx])
            order_blocks.append({
                "layer": layer_name,
                "bias": "bullish",
                "start_date": dates[best_idx],
                "created_date": dates[i],
                "created_idx": i,
                "top": round(ob_top, decimals),
                "bottom": round(ob_bot, decimals),
                "active": True,
                "mitigated_date": None,
            })

        if last_low is not None and not last_low["crossed"] and closes[i] < last_low["price"]:
            kind = "CHoCH" if trend == 1 else "BOS"
            trend = -1
            last_low["crossed"] = True
            events.append({
                "layer": layer_name,
                "kind": kind,
                "bias": "bearish",
                "pivot_date": last_low["date"],
                "break_date": dates[i],
                "price": round(last_low["price"], decimals),
                "close": round(closes[i], decimals),
            })
            # Volatility-filtered Bearish Order Block: scan [last_low.idx, i - 1]
            lo_idx = last_low["idx"]
            hi_idx = max(lo_idx + 1, i)
            best_idx = max(range(lo_idx, hi_idx), key=lambda k: parsed_high[k])
            ob_top = max(parsed_high[best_idx], parsed_low[best_idx])
            ob_bot = min(parsed_high[best_idx], parsed_low[best_idx])
            order_blocks.append({
                "layer": layer_name,
                "bias": "bearish",
                "start_date": dates[best_idx],
                "created_date": dates[i],
                "created_idx": i,
                "top": round(ob_top, decimals),
                "bottom": round(ob_bot, decimals),
                "active": True,
                "mitigated_date": None,
            })

    # Trailing swing high & low for Strong/Weak roles and Premium/Discount
    trail_high = prev_swing_high
    trail_low = prev_swing_low
    if pivots:
        recent_h = [p for p in pivots if p["type"] == "H"]
        recent_l = [p for p in pivots if p["type"] == "L"]
        if recent_h:
            trail_high = recent_h[-1]
        if recent_l:
            trail_low = recent_l[-1]

    return {
        "trend": trend,
        "events": events,
        "order_blocks": order_blocks,
        "eq_levels": eq_levels,
        "trail_high": trail_high,
        "trail_low": trail_low,
    }


def _detect_fvgs(
    bars: list[dict[str, Any]],
    atr: list[float],
    min_gap_atr: float = 0.15,
    decimals: int = 2,
) -> list[dict[str, Any]]:
    """Detect 3-candle Fair Value Gaps (FVG) and track full mitigation."""
    n = len(bars)
    fvgs: list[dict[str, Any]] = []
    for i in range(2, n):
        # Mitigate existing active FVGs
        for g in fvgs:
            if g["active"]:
                if g["bias"] == "bullish" and bars[i]["low"] <= g["bottom"]:
                    g["active"] = False
                    g["mitigated_date"] = bars[i]["date"]
                elif g["bias"] == "bearish" and bars[i]["high"] >= g["top"]:
                    g["active"] = False
                    g["mitigated_date"] = bars[i]["date"]

        cur_atr = atr[i] if atr[i] > 0 else 0.0
        # Bullish FVG: candle[i].low > candle[i-2].high and middle candle is bullish
        bull_gap = bars[i]["low"] - bars[i - 2]["high"]
        if bull_gap > 0 and bars[i - 1]["close"] > bars[i - 1]["open"] and bull_gap >= min_gap_atr * cur_atr:
            fvgs.append({
                "bias": "bullish",
                "start_date": bars[i - 1]["date"],
                "created_date": bars[i]["date"],
                "top": round(bars[i]["low"], decimals),
                "bottom": round(bars[i - 2]["high"], decimals),
                "active": True,
                "mitigated_date": None,
            })

        # Bearish FVG: candle[i].high < candle[i-2].low and middle candle is bearish
        bear_gap = bars[i - 2]["low"] - bars[i]["high"]
        if bear_gap > 0 and bars[i - 1]["close"] < bars[i - 1]["open"] and bear_gap >= min_gap_atr * cur_atr:
            fvgs.append({
                "bias": "bearish",
                "start_date": bars[i - 1]["date"],
                "created_date": bars[i]["date"],
                "top": round(bars[i - 2]["low"], decimals),
                "bottom": round(bars[i]["high"], decimals),
                "active": True,
                "mitigated_date": None,
            })
    return fvgs


def analyze_technical_series(
    bars: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
    decimals: int = 2,
) -> dict[str, Any]:
    """Compute classic indicators + full SMC structure on daily OHLCV bars."""
    cfg = {
        "swing_length": 10,
        "internal_length": 3,
        "atr_period": 14,
        "eq_atr_factor": 0.15,
        "fvg_min_gap_atr": 0.15,
        "max_active_ob": 6,
        "max_active_fvg": 6,
    }
    if params:
        cfg.update(params)

    n = len(bars)
    if n == 0:
        raise ValueError("K线数据为空，无法进行技术分析")

    dates = [b["date"] for b in bars]
    opens = [float(b["open"]) for b in bars]
    highs = [float(b["high"]) for b in bars]
    lows = [float(b["low"]) for b in bars]
    closes = [float(b["close"]) for b in bars]
    volumes = [b.get("volume") for b in bars]

    # Classic technical indicators
    ma5 = [_round_opt(v, decimals) for v in calc_sma(closes, 5)]
    ma10 = [_round_opt(v, decimals) for v in calc_sma(closes, 10)]
    ma20 = [_round_opt(v, decimals) for v in calc_sma(closes, 20)]
    ma60 = [_round_opt(v, decimals) for v in calc_sma(closes, 60)]
    ma120 = [_round_opt(v, decimals) for v in calc_sma(closes, 120)]
    boll_raw = calc_boll(closes, 20, 2.0)
    boll = {
        "mid": [_round_opt(v, decimals) for v in boll_raw["mid"]],
        "up": [_round_opt(v, decimals) for v in boll_raw["up"]],
        "dn": [_round_opt(v, decimals) for v in boll_raw["dn"]],
    }
    macd_raw = calc_macd(closes, 12, 26, 9)
    macd_digits = max(decimals + 1, 3)
    macd = {
        "dif": [_round_opt(v, macd_digits) for v in macd_raw["dif"]],
        "dea": [_round_opt(v, macd_digits) for v in macd_raw["dea"]],
        "hist": [_round_opt(v, macd_digits) for v in macd_raw["hist"]],
    }
    rsi14 = [_round_opt(v, 2) for v in calc_rsi(closes, 14)]
    atr14 = calc_atr(highs, lows, closes, int(cfg["atr_period"]))

    # SMC Dual-Layer Structure
    swing = _detect_structure_layer(
        bars, atr14, int(cfg["swing_length"]), "swing", float(cfg["eq_atr_factor"]), decimals
    )
    internal = _detect_structure_layer(
        bars, atr14, int(cfg["internal_length"]), "internal", float(cfg["eq_atr_factor"]), decimals
    )
    fvgs = _detect_fvgs(bars, atr14, float(cfg["fvg_min_gap_atr"]), decimals)

    # Active Order Blocks (prefer swing OBs + latest internal OBs)
    active_swing_ob = [ob for ob in swing["order_blocks"] if ob["active"]][-int(cfg["max_active_ob"]) :]
    active_internal_ob = [ob for ob in internal["order_blocks"] if ob["active"]][-4:]
    active_obs = active_swing_ob + active_internal_ob
    active_fvgs = [g for g in fvgs if g["active"]][-int(cfg["max_active_fvg"]) :]

    # Strong / Weak High & Low + Premium / Equilibrium / Discount Zone
    # Use trailing swing high/low; expand if recent price broke beyond the confirmed pivot
    recent_window = bars[-min(n, 120) :]
    sw_high_val = swing["trail_high"]["price"] if swing["trail_high"] else max(b["high"] for b in recent_window)
    sw_high_date = swing["trail_high"]["date"] if swing["trail_high"] else recent_window[-1]["date"]
    sw_low_val = swing["trail_low"]["price"] if swing["trail_low"] else min(b["low"] for b in recent_window)
    sw_low_date = swing["trail_low"]["date"] if swing["trail_low"] else recent_window[-1]["date"]

    # Ensure range covers the actual extremes since the older pivot
    range_start_date = min(sw_high_date, sw_low_date)
    range_bars = [b for b in bars if b["date"] >= range_start_date]
    if range_bars:
        actual_max_bar = max(range_bars, key=lambda b: b["high"])
        actual_min_bar = min(range_bars, key=lambda b: b["low"])
        if actual_max_bar["high"] > sw_high_val:
            sw_high_val = actual_max_bar["high"]
            sw_high_date = actual_max_bar["date"]
        if actual_min_bar["low"] < sw_low_val:
            sw_low_val = actual_min_bar["low"]
            sw_low_date = actual_min_bar["date"]

    if sw_high_val <= sw_low_val:
        sw_high_val = max(highs[-min(n, 60) :])
        sw_low_val = min(lows[-min(n, 60) :])

    span = sw_high_val - sw_low_val
    eq_price = (sw_high_val + sw_low_val) / 2.0
    prem_price = sw_low_val + 0.75 * span
    disc_price = sw_low_val + 0.25 * span
    last_close = closes[-1]
    prev_close = closes[-2] if n >= 2 else closes[-1]
    day_chg_pct = ((last_close / prev_close) - 1.0) * 100.0 if prev_close else 0.0
    pos_pct = ((last_close - sw_low_val) / span * 100.0) if span > 0 else 50.0
    pos_pct_clamped = max(0.0, min(100.0, pos_pct))

    if pos_pct_clamped >= 75.0:
        zone_label = "深度溢价区 (Premium)"
    elif pos_pct_clamped > 50.0:
        zone_label = "溢价区 (Upper Half)"
    elif pos_pct_clamped <= 25.0:
        zone_label = "深度折价区 (Discount)"
    else:
        zone_label = "折价区 (Lower Half)"

    swing_trend = swing["trend"]
    internal_trend = internal["trend"]
    high_role = "Strong High (防守高点)" if swing_trend == -1 else "Weak High (目标高点)"
    low_role = "Weak Low (易测低点)" if swing_trend == -1 else "Strong Low (防守低点)"

    trend_text = {1: "偏多 (Bullish)", -1: "偏空 (Bearish)", 0: "震荡待确认 (Neutral)"}

    # Recent performance stats
    def _ret_n(k: int) -> float | None:
        if n <= k or closes[-1 - k] == 0:
            return None
        return round((closes[-1] / closes[-1 - k] - 1.0) * 100.0, 2)

    # 20-day annualized volatility
    rets = [(closes[i] / closes[i - 1] - 1.0) for i in range(max(1, n - 20), n) if closes[i - 1] > 0]
    vol20 = None
    if len(rets) >= 5:
        mean_r = sum(rets) / len(rets)
        sd_r = math.sqrt(sum((r - mean_r) ** 2 for r in rets) / len(rets))
        vol20 = round(sd_r * math.sqrt(252) * 100.0, 2)

    last_swing_evt = swing["events"][-1] if swing["events"] else None
    last_internal_evt = internal["events"][-1] if internal["events"] else None

    # Compact chart-friendly arrays
    ohlc = [[round(opens[i], decimals), round(closes[i], decimals), round(lows[i], decimals), round(highs[i], decimals)] for i in range(n)]

    # Keep clean subset of historical events (last 24 swing + last 36 internal) so chart stays legible
    swing_events = swing["events"][-24:]
    internal_events = internal["events"][-36:]
    eq_levels = (swing["eq_levels"][-6:] + internal["eq_levels"][-6:])[-10:]

    return {
        "dates": dates,
        "ohlc": ohlc,  # ECharts candlestick order: [open, close, low, high]
        "volumes": volumes,
        "indicators": {
            "ma5": ma5,
            "ma10": ma10,
            "ma20": ma20,
            "ma60": ma60,
            "ma120": ma120,
            "boll": boll,
            "macd": macd,
            "rsi14": rsi14,
            "atr14": [_round_opt(v, decimals) for v in atr14],
        },
        "smc": {
            "swing_trend": swing_trend,
            "swing_trend_label": trend_text[swing_trend],
            "internal_trend": internal_trend,
            "internal_trend_label": trend_text[internal_trend],
            "swing_events": swing_events,
            "internal_events": internal_events,
            "active_order_blocks": [
                {k: v for k, v in ob.items() if k != "created_idx"} for ob in active_obs
            ],
            "active_fvgs": active_fvgs,
            "eq_levels": eq_levels,
            "zones": {
                "start_date": range_start_date,
                "swing_high": round(sw_high_val, decimals),
                "swing_high_date": sw_high_date,
                "swing_high_role": high_role,
                "swing_low": round(sw_low_val, decimals),
                "swing_low_date": sw_low_date,
                "swing_low_role": low_role,
                "equilibrium": round(eq_price, decimals),
                "premium_75": round(prem_price, decimals),
                "discount_25": round(disc_price, decimals),
                "current_pos_pct": round(pos_pct_clamped, 1),
                "zone_label": zone_label,
            },
            "last_swing_event": last_swing_evt,
            "last_internal_event": last_internal_evt,
            "confirm_lag_days": {
                "swing": int(cfg["swing_length"]),
                "internal": int(cfg["internal_length"]),
            },
        },
        "summary": {
            "latest_date": dates[-1],
            "close": round(last_close, decimals),
            "open": round(opens[-1], decimals),
            "high": round(highs[-1], decimals),
            "low": round(lows[-1], decimals),
            "change_pct": round(day_chg_pct, 2),
            "ret_5d": _ret_n(5),
            "ret_20d": _ret_n(20),
            "ret_60d": _ret_n(60),
            "vol_20d_ann_pct": vol20,
            "rsi14": rsi14[-1],
            "macd_dif": macd["dif"][-1],
            "macd_dea": macd["dea"][-1],
            "macd_hist": macd["hist"][-1],
            "atr14": _round_opt(atr14[-1], decimals),
            "active_bull_ob_count": sum(1 for ob in active_obs if ob["bias"] == "bullish"),
            "active_bear_ob_count": sum(1 for ob in active_obs if ob["bias"] == "bearish"),
            "active_fvg_count": len(active_fvgs),
        },
    }
