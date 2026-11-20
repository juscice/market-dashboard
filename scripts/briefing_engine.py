"""
每日 09:00 晨间投研简报引擎（波浪理论 Elliott Wave + 通道理论 Price Channel）
基于 5 大市场模块真实日K及宏观资金面数据，全定量生成：
1. 沪深300全收益 vs 二级债基（股债周期定位）
2. 国家队宽基ETF资金面（平准底仓脉动）
3. 科创50 / 创业板指 / 伦敦金现（兼顾黄金股ETF & 黄金ETF）的：
   - 波浪理论：自适应 ZigZag 转折点、浪型阶段判定（推动浪/调整浪）、斐波那契回撤/扩展关键位
   - 通道理论：60日线性回归主趋势通道（上轨/中轨/下轨、斜率、通道内分位）+ 20日唐奇安突破带
   - 同步输出图表叠加坐标（wave_points、channel_lines），支持前端一键在日K图上可视化校验
"""

from __future__ import annotations

import math
from typing import Any


def _r(v: float | None, d: int = 2) -> float | None:
    if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
        return None
    return round(float(v), d)


def detect_zigzag(bars: list[dict[str, Any]], pct_threshold: float = 0.055, decimals: int = 2) -> list[dict[str, Any]]:
    """
    自适应 ZigZag 峰谷转折点提取（基于收盘/高低极值，过滤小级别毛刺，用于波浪数浪基准）。
    返回交替出现的 H / L 拐点列表：[{idx, date, price, type}]
    """
    n = len(bars)
    if n < 10:
        return []

    pivots: list[dict[str, Any]] = []
    # Initialize with first bar
    direction = 0  # 1 = searching for high, -1 = searching for low
    ext_idx = 0
    ext_price = float(bars[0]["close"])

    for i in range(1, n):
        hi = float(bars[i]["high"])
        lo = float(bars[i]["low"])

        if direction == 0:
            if hi >= ext_price * (1.0 + pct_threshold):
                pivots.append({"idx": ext_idx, "date": bars[ext_idx]["date"], "price": _r(bars[ext_idx]["low"], decimals), "type": "L"})
                direction = 1
                ext_idx = i
                ext_price = hi
            elif lo <= ext_price * (1.0 - pct_threshold):
                pivots.append({"idx": ext_idx, "date": bars[ext_idx]["date"], "price": _r(bars[ext_idx]["high"], decimals), "type": "H"})
                direction = -1
                ext_idx = i
                ext_price = lo
            else:
                if hi > ext_price:
                    ext_price = hi
                    ext_idx = i
        elif direction == 1:
            if hi >= ext_price:
                ext_price = hi
                ext_idx = i
            elif lo <= ext_price * (1.0 - pct_threshold):
                pivots.append({"idx": ext_idx, "date": bars[ext_idx]["date"], "price": _r(ext_price, decimals), "type": "H"})
                direction = -1
                ext_idx = i
                ext_price = lo
        else:
            if lo <= ext_price:
                ext_price = lo
                ext_idx = i
            elif hi >= ext_price * (1.0 + pct_threshold):
                pivots.append({"idx": ext_idx, "date": bars[ext_idx]["date"], "price": _r(ext_price, decimals), "type": "L"})
                direction = 1
                ext_idx = i
                ext_price = hi

    # Append trailing unconfirmed extreme as live developing wave endpoint
    if direction != 0:
        pivots.append({
            "idx": ext_idx,
            "date": bars[ext_idx]["date"],
            "price": _r(ext_price, decimals),
            "type": "H" if direction == 1 else "L",
            "developing": True,
        })
    return pivots


def analyze_elliott_wave(bars: list[dict[str, Any]], decimals: int = 2, pct_threshold: float = 0.055) -> dict[str, Any]:
    """波浪理论定量分析：提取波段拐点、判定推动/调整浪位置并计算斐波那契关键价位。"""
    window = bars[-min(len(bars), 260) :]
    pivots = detect_zigzag(window, pct_threshold=pct_threshold, decimals=decimals)
    # If too few pivots (low volatility asset), relax threshold automatically
    if len(pivots) < 4:
        pivots = detect_zigzag(window, pct_threshold=pct_threshold * 0.65, decimals=decimals)

    last_close = float(window[-1]["close"])
    last_date = window[-1]["date"]

    if len(pivots) < 3:
        hi = max(float(b["high"]) for b in window)
        lo = min(float(b["low"]) for b in window)
        return {
            "wave_stage": "窄幅蓄势（待确立主浪）",
            "bias": "neutral",
            "summary": f"近一年波幅收敛，区间 {lo:.{decimals}f}–{hi:.{decimals}f}，等待有效突破确立新一轮推动浪方向。",
            "fib_levels": {
                "f382": _r(lo + 0.382 * (hi - lo), decimals),
                "f500": _r(lo + 0.500 * (hi - lo), decimals),
                "f618": _r(lo + 0.618 * (hi - lo), decimals),
            },
            "pivots": [],
        }

    # Take last 6 pivots to label wave structure
    recent = pivots[-min(len(pivots), 6) :]
    p_last = recent[-1]
    p_prev = recent[-2]
    p_prev2 = recent[-3]

    leg_curr = p_last["price"] - p_prev["price"]
    leg_prev = p_prev["price"] - p_prev2["price"]
    curr_up = leg_curr > 0

    # Retracement ratio of current leg relative to previous leg
    retrace_ratio = abs(leg_curr / leg_prev) if abs(leg_prev) > 1e-9 else 0.0

    # Determine higher-level structure (HH/HL vs LH/LL)
    highs = [p["price"] for p in recent if p["type"] == "H"]
    lows = [p["price"] for p in recent if p["type"] == "L"]
    hh = len(highs) >= 2 and highs[-1] > highs[-2]
    hl = len(lows) >= 2 and lows[-1] > lows[-2]
    lh = len(highs) >= 2 and highs[-1] < highs[-2]
    ll = len(lows) >= 2 and lows[-1] < lows[-2]

    labels: list[str] = []
    if curr_up:
        if hh and hl:
            wave_stage = "上升推动浪（第3/5浪延伸）"
            bias = "bullish"
            labels = ["0", "1", "2", "3", "4", "5"][-len(recent) :]
            detail = f"高低点逐级抬升，当前处于多头主升/延伸结构（本段较前段回撤/推进比 {retrace_ratio:.2f}x），回调不破前低 {p_prev['price']:.{decimals}f} 则维持多头浪型。"
        elif retrace_ratio < 0.786 and lh:
            wave_stage = "下跌途中的 B 浪反弹"
            bias = "bearish"
            labels = ["0", "A", "B"][-min(3, len(recent)) :]
            detail = f"前序仍为高点下移结构，本轮自 {p_prev['price']:.{decimals}f} 反弹幅度约为前跌浪的 {retrace_ratio*100:.1f}%，未突破前高 {p_prev2['price']:.{decimals}f} 前按 B 浪反弹对待。"
        else:
            wave_stage = "底部转折（疑似新1浪启动）"
            bias = "bullish"
            labels = ["A", "B", "C", "1"][-min(4, len(recent)) :]
            detail = f"自低点 {p_prev['price']:.{decimals}f} 强力反攻，已收复前跌浪 {retrace_ratio*100:.1f}%，关注能否放量站稳前高 {p_prev2['price']:.{decimals}f} 确认1→3主升切换。"
    else:
        if lh and ll:
            if retrace_ratio >= 1.0:
                wave_stage = "主跌浪 / 延长 C 浪"
                bias = "bearish"
                labels = ["0", "A", "B", "C"][-min(4, len(recent)) :]
                detail = f"高点与低点同步下移，本段下行幅度已达前段反弹的 {retrace_ratio:.2f}x（跌破前低），处于空头主跌/延长C浪；右侧需等待止跌底分型与反破前高。"
            else:
                wave_stage = "下跌推动 / C 浪探底"
                bias = "bearish"
                labels = ["0", "A", "B", "C"][-min(4, len(recent)) :]
                detail = f"自 {p_prev['price']:.{decimals}f} 回落并刷新阶段低点，空头浪型延续，重点观察下方斐波那契支撑区能否形成背离企稳。"
        elif hl or retrace_ratio < 0.618:
            wave_stage = "上升途中的 2/4 浪回踩"
            bias = "neutral"
            labels = ["0", "1", "2", "3", "4"][-min(5, len(recent)) :]
            detail = f"前期呈多头波段，当前自 {p_prev['price']:.{decimals}f} 回撤约为前涨浪的 {retrace_ratio*100:.1f}%；若守住 0.618 关键位，仍属健康回调蓄势。"
        else:
            wave_stage = "ABC 深度调整浪"
            bias = "bearish"
            labels = ["0", "A", "B", "C"][-min(4, len(recent)) :]
            detail = f"自高点 {p_prev['price']:.{decimals}f} 回调幅度已达前涨浪的 {retrace_ratio*100:.1f}%，调整偏深，需防范演变为大级别下跌浪。"

    # Build Fibonacci levels anchored on the latest major leg (p_prev2 -> p_prev or p_prev -> p_last)
    hi_ref = max(p_prev["price"], p_prev2["price"], p_last["price"])
    lo_ref = min(p_prev["price"], p_prev2["price"], p_last["price"])
    span = max(hi_ref - lo_ref, 1e-6)
    fib_levels = {
        "anchor_high": _r(hi_ref, decimals),
        "anchor_low": _r(lo_ref, decimals),
        "f236": _r(lo_ref + 0.236 * span, decimals),
        "f382": _r(lo_ref + 0.382 * span, decimals),
        "f500": _r(lo_ref + 0.500 * span, decimals),
        "f618": _r(lo_ref + 0.618 * span, decimals),
    }

    # Assign labels to last `len(labels)` pivots for chart rendering
    chart_pivots = []
    offset = len(recent) - len(labels)
    for idx_i, p in enumerate(recent):
        lbl = labels[idx_i - offset] if idx_i >= offset else ""
        chart_pivots.append({
            "date": p["date"],
            "price": p["price"],
            "type": p["type"],
            "label": lbl,
            "developing": bool(p.get("developing", False)),
        })

    # Ensure last actual date is reflected if trailing pivot is earlier than latest bar
    if chart_pivots and chart_pivots[-1]["date"] < last_date:
        chart_pivots.append({
            "date": last_date,
            "price": _r(last_close, decimals),
            "type": "C",
            "label": "现",
            "developing": True,
        })

    return {
        "wave_stage": wave_stage,
        "bias": bias,
        "retrace_pct": _r(retrace_ratio * 100.0, 1),
        "summary": detail,
        "fib_levels": fib_levels,
        "pivots": chart_pivots,
    }


def analyze_price_channel(bars: list[dict[str, Any]], window_len: int = 60, decimals: int = 2) -> dict[str, Any]:
    """
    通道理论定量分析：
    - 60日线性回归通道（中轨=OLS回归线，上/下轨=±2.0σ 平行轨道）
    - 20日唐奇安通道（近20日最高/最低价突破参照）
    """
    n = len(bars)
    w = min(n, window_len)
    seg = bars[-w:]
    closes = [float(b["close"]) for b in seg]
    highs = [float(b["high"]) for b in seg]
    lows = [float(b["low"]) for b in seg]

    # Ordinary Least Squares regression y = intercept + slope * x for x = 0..w-1
    x_mean = (w - 1) / 2.0
    y_mean = sum(closes) / w
    num = sum((i - x_mean) * (closes[i] - y_mean) for i in range(w))
    den = sum((i - x_mean) ** 2 for i in range(w))
    slope = num / den if den > 0 else 0.0
    intercept = y_mean - slope * x_mean

    fitted = [intercept + slope * i for i in range(w)]
    residuals = [closes[i] - fitted[i] for i in range(w)]
    sigma = math.sqrt(sum(r * r for r in residuals) / max(1, w))
    # Envelope band width: max of 2*sigma or 90% of max high/low deviation for clean visual fit
    band = max(2.0 * sigma, 1e-6)

    mid_start = fitted[0]
    mid_end = fitted[-1]
    up_start = mid_start + band
    up_end = mid_end + band
    dn_start = mid_start - band
    dn_end = mid_end - band

    last_close = closes[-1]
    ch_width = up_end - dn_end
    ch_pos_pct = max(0.0, min(100.0, ((last_close - dn_end) / ch_width * 100.0) if ch_width > 0 else 50.0))

    # Annualized slope % relative to mean price
    slope_ann_pct = (slope * 242.0 / y_mean * 100.0) if y_mean > 0 else 0.0

    if slope_ann_pct >= 12.0:
        direction = "上行通道"
        bias = "bullish"
    elif slope_ann_pct <= -12.0:
        direction = "下行通道"
        bias = "bearish"
    else:
        direction = "横向箱体通道"
        bias = "neutral"

    if last_close > up_end:
        pos_state = "突破上轨（短线超买/加速）"
    elif ch_pos_pct >= 78.0:
        pos_state = "逼近上轨压力区"
    elif ch_pos_pct >= 52.0:
        pos_state = "中轨上方运行（通道偏强）"
    elif ch_pos_pct >= 22.0:
        pos_state = "中轨下方运行（通道偏弱）"
    elif last_close >= dn_end:
        pos_state = "回踩下轨支撑区"
    else:
        pos_state = "跌破下轨（短线超卖/加速）"

    # 20-day Donchian breakout reference
    d20 = bars[-min(n, 20) :]
    donchian_hi = max(float(b["high"]) for b in d20)
    donchian_lo = min(float(b["low"]) for b in d20)

    summary = (
        f"60日回归呈{direction}（年化斜率 {slope_ann_pct:+.1f}%），"
        f"下轨支撑 {dn_end:.{decimals}f} / 中轨 {mid_end:.{decimals}f} / 上轨压力 {up_end:.{decimals}f}；"
        f"现价处于通道 {ch_pos_pct:.0f}% 分位，{pos_state}。"
    )

    return {
        "direction": direction,
        "bias": bias,
        "slope_ann_pct": _r(slope_ann_pct, 1),
        "pos_pct": _r(ch_pos_pct, 1),
        "pos_state": pos_state,
        "upper": _r(up_end, decimals),
        "mid": _r(mid_end, decimals),
        "lower": _r(dn_end, decimals),
        "donchian_20_high": _r(donchian_hi, decimals),
        "donchian_20_low": _r(donchian_lo, decimals),
        "summary": summary,
        "lines": {
            "start_date": seg[0]["date"],
            "end_date": seg[-1]["date"],
            "upper": [_r(up_start, decimals), _r(up_end, decimals)],
            "mid": [_r(mid_start, decimals), _r(mid_end, decimals)],
            "lower": [_r(dn_start, decimals), _r(dn_end, decimals)],
        },
    }


def _bars_from_tech(item: dict[str, Any]) -> list[dict[str, Any]]:
    dates = item["dates"]
    ohlc = item["ohlc"]
    vols = item.get("volumes") or [None] * len(dates)
    return [
        {"date": dates[i], "open": ohlc[i][0], "close": ohlc[i][1], "low": ohlc[i][2], "high": ohlc[i][3], "volume": vols[i]}
        for i in range(len(dates))
    ]


def generate_morning_briefing(
    convergence: dict[str, Any],
    national_team: dict[str, Any],
    technical: dict[str, Any],
    generated_at: str,
    edition_date: str,
) -> dict[str, Any]:
    """生成 5 大主市场项目的每日 09:00 波浪理论 + 通道理论晨间简报。"""
    # Compute wave & channel overlays for all technical assets (including gold ETFs)
    wc_map: dict[str, dict[str, Any]] = {}
    for key, item in technical.items():
        bars = _bars_from_tech(item)
        dec = int(item["meta"]["decimals"])
        thresh = 0.045 if key in ("gold_xau", "gold_etf") else 0.06
        wave = analyze_elliott_wave(bars, decimals=dec, pct_threshold=thresh)
        channel = analyze_price_channel(bars, window_len=60, decimals=dec)
        wc_map[key] = {"wave": wave, "channel": channel}

    # Build 5 concise briefing items corresponding 1-to-1 to the 5 main dashboard modules
    cs = convergence["summary"]
    gs = national_team["summary"]

    # Item 1: 股债收敛
    if cs["is_currently_below"]:
        conv_tag = "极值跌破·高赔率区间"
        conv_bias = "bullish"
        conv_view = f"沪深300全收益已跌破二级债基基准（剪刀差 {cs['spread_pct']:+.1f}pct），历史上仅出现 {cs['episode_count']} 次同类极值，长期股债性价比处于右侧配置窗口。"
    elif cs["spread_pct"] < 60:
        conv_tag = "收敛蓄势·中性偏积极"
        conv_bias = "neutral"
        conv_view = f"300全收益较二级债基领先 {cs['spread_pct']:+.1f}pct（净值比 {cs['ratio_300_to_bond2']}x），处于中低溢价收敛带，可结合成长宽基通道企稳节奏分批布局。"
    else:
        conv_tag = "权益溢价·防波动回撤"
        conv_bias = "neutral"
        conv_view = f"300全收益累计 {cs['csi300_cum_pct']:+.1f}% 领先二级债基 {cs['spread_pct']:+.1f}pct（净值比 {cs['ratio_300_to_bond2']}x），距历史7次跌破极值区尚有缓冲，注重波段节奏与回撤控制。"

    # Item 2: 国家队份额
    f1 = gs["flow_1d_yi"]
    f5 = gs["flow_5d_yi"]
    f20 = gs["flow_20d_yi"]
    if f1 > 50 or f5 > 100:
        gjd_tag = "显著净申购·托底信号强"
        gjd_bias = "bullish"
        gjd_view = f"16只重仓宽基ETF总份额升至 {gs['total_shares_yi']:.1f} 亿份，单日估算净流入 {f1:+.1f} 亿元（近5日 {f5:+.1f} 亿），大资金低位托底意愿明显。"
    elif f1 < -50 or f5 < -100:
        gjd_tag = "阶段净赎回·逢高兑现"
        gjd_bias = "bearish"
        gjd_view = f"监控宽基ETF总份额 {gs['total_shares_yi']:.1f} 亿份，单日净流出 {f1:+.1f} 亿元（近5日 {f5:+.1f} 亿），需留意权重宽基上方筹码消化压力。"
    else:
        gjd_tag = "份额平稳·存量博弈"
        gjd_bias = "neutral"
        gjd_view = f"监控宽基ETF总份额 {gs['total_shares_yi']:.1f} 亿份，单日净申赎 {f1:+.1f} 亿元（近20日 {f20:+.1f} 亿），平准资金整体按兵不动，市场以存量结构轮动为主。"

    def _tech_card(idx_num: int, sec_href: str, key: str, label: str, extra_hint: str = "") -> dict[str, Any]:
        it = technical[key]
        s = it["summary"]
        dec = int(it["meta"]["decimals"])
        u = it["meta"]["price_unit"]
        w = wc_map[key]["wave"]
        ch = wc_map[key]["channel"]
        # Synthesize combined actionable technical view
        if w["bias"] == "bearish" and ch["pos_pct"] <= 25:
            action = f"波浪偏空叠加通道下轨超卖（分位 {ch['pos_pct']:.0f}%），切忌盲目追空，重点观察 {ch['lower']:.{dec}f} 支撑位是否出现底背离或内部 CHoCH 企稳信号。"
        elif w["bias"] == "bullish" and ch["pos_pct"] >= 78:
            action = f"多头推动浪运行至通道上轨压力区（{ch['upper']:.{dec}f}），顺势持有同时防范短线乖离回踩中轨 {ch['mid']:.{dec}f}。"
        elif w["bias"] == "bullish":
            action = f"波浪与通道共振偏多，以中轨 {ch['mid']:.{dec}f} / 斐波那契 50% ({w['fib_levels']['f500']:.{dec}f}) 为防守参照。"
        else:
            action = f"当前处于{w['wave_stage']}与{ch['direction']}共振区，上方阻力看中轨 {ch['mid']:.{dec}f}，下方防守看下轨 {ch['lower']:.{dec}f}。"
        if extra_hint:
            action += " " + extra_hint

        return {
            "index": idx_num,
            "href": sec_href,
            "key": key,
            "title": label,
            "code": it["meta"]["display_code"],
            "price_text": f"{s['close']:.{dec}f} {u}",
            "change_pct": s["change_pct"],
            "bias": w["bias"],
            "wave_stage": w["wave_stage"],
            "channel_stage": f"{ch['direction']} · {ch['pos_state'].split('（')[0]}（{ch['pos_pct']:.0f}%）",
            "key_levels": {
                "support": f"{ch['lower']:.{dec}f}",
                "mid": f"{ch['mid']:.{dec}f}",
                "resistance": f"{ch['upper']:.{dec}f}",
                "fib50": f"{w['fib_levels']['f500']:.{dec}f}",
            },
            "view": action,
        }

    # Gold extra cross-check note (黄金股ETF & 黄金ETF)
    g_stk = technical.get("gold_stock_etf", {}).get("summary", {})
    g_etf = technical.get("gold_etf", {}).get("summary", {})
    gold_extra = ""
    if g_stk and g_etf:
        gold_extra = f"联动参考：黄金股ETF {g_stk['close']:.3f}（{g_stk['change_pct']:+.2f}%），黄金ETF {g_etf['close']:.3f}（{g_etf['change_pct']:+.2f}%）。"

    items = [
        {
            "index": 1,
            "href": "#sec-convergence",
            "key": "convergence",
            "title": "股债波动收敛",
            "code": "H00300 vs 885007",
            "price_text": f"剪刀差 {cs['spread_pct']:+.1f} pct",
            "change_pct": None,
            "bias": conv_bias,
            "wave_stage": f"长周期估值锚 · 历史跌破 {cs['episode_count']} 次",
            "channel_stage": conv_tag,
            "key_levels": {
                "support": "0% 跌破线",
                "mid": f"300: {cs['csi300_cum_pct']:+.0f}%",
                "resistance": f"债基: {cs['bond2_cum_pct']:+.0f}%",
            },
            "view": conv_view,
        },
        {
            "index": 2,
            "href": "#sec-gjd",
            "key": "national_team",
            "title": "国家队宽基份额",
            "code": "16只核心宽基ETF",
            "price_text": f"{gs['total_shares_yi']:.1f} 亿份",
            "change_pct": None,
            "bias": gjd_bias,
            "wave_stage": f"单日净流入 {f1:+.1f} 亿元",
            "channel_stage": gjd_tag,
            "key_levels": {
                "support": f"5日 {f5:+.0f}亿",
                "mid": f"20日 {f20:+.0f}亿",
                "resistance": f"规模 {gs['total_aum_yi']:.0f}亿",
            },
            "view": gjd_view,
        },
        _tech_card(3, "#sec-star50", "star50", "科创50"),
        _tech_card(4, "#sec-cyb", "cyb", "创业板指"),
        _tech_card(5, "#sec-gold", "gold_xau", "伦敦金现 (黄金)", extra_hint=gold_extra),
    ]

    # Overall executive headline verdict
    bear_cnt = sum(1 for k in ("star50", "cyb", "gold_xau") if wc_map[k]["wave"]["bias"] == "bearish")
    bull_cnt = sum(1 for k in ("star50", "cyb", "gold_xau") if wc_map[k]["wave"]["bias"] == "bullish")
    if bear_cnt >= 2 and gjd_bias == "bullish":
        headline = "核心定调：成长宽基与黄金处于下行通道/调整浪探底区，但国家队宽基ETF出现显著净申购托底，重点观察通道下轨与波浪背离共振企稳机会。"
    elif bear_cnt >= 2:
        headline = "核心定调：主要风险资产仍处下行通道与空头调整浪内，多看少动、紧盯通道下轨支撑与内部结构 CHoCH 反转确认。"
    elif bull_cnt >= 2:
        headline = "核心定调：多头推动浪与上行通道共振延续，顺势跟踪同时留意通道上轨压力与中轨防守。"
    else:
        headline = "核心定调：大类资产呈结构性分化与箱体震荡，紧扣各标的通道上下轨与波浪关键位高抛低吸。"

    # Plain-text copyable morning report for WeChat / Feishu / DingTalk
    lines = [
        f"【每日 09:00 晨间波浪与通道简报｜{edition_date}】",
        headline,
        "",
    ]
    for it in items:
        chg_str = f"（{it['change_pct']:+.2f}%）" if it["change_pct"] is not None else ""
        lines.append(f"{it['index']}. {it['title']}（{it['code']}）{it['price_text']}{chg_str}")
        lines.append(f"   · 波浪/周期：{it['wave_stage']} ｜ 通道/资金：{it['channel_stage']}")
        lv = it["key_levels"]
        lines.append(f"   · 关键参照：下沿/支撑 {lv['support']} ｜ 中轴 {lv['mid']} ｜ 上沿/压力 {lv['resistance']}")
        lines.append(f"   · 简评：{it['view']}")
    lines.append("")
    lines.append(f"生成时间：{generated_at}（数据仅供参考，不构成投资建议）")

    return {
        "edition_date": edition_date,
        "scheduled_time": "09:00 (北京时间)",
        "generated_at": generated_at,
        "headline": headline,
        "items": items,
        "plain_text": "\n".join(lines),
        "overlays": wc_map,
    }
