"""
多资产每日投研监控看板 - 每日自动更新主控脚本
运行方式：
    python scripts/update_daily.py
输出：
    data/dashboard_data.json
"""

from __future__ import annotations

import json
import math
import sys
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any

# Ensure scripts directory is importable regardless of cwd
SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from briefing_engine import (
    analyze_elliott_wave,
    analyze_price_channel,
    generate_gold_briefing,
    generate_morning_briefing,
)
from data_sources import (
    CST,
    csi_index_perf,
    fetch_gold_macro_bundle,
    fetch_national_team_bundle,
    now_cst_str,
    sge_spot_kline,
    sina_futures_kline,
    sina_global_futures_kline,
    tencent_kline,
    tencent_quote,
)
from smc_engine import analyze_technical_series


def _ann_stats(nav_series: list[float]) -> dict[str, float]:
    n = len(nav_series)
    if n < 2:
        return {"cagr_pct": 0.0, "vol_pct": 0.0, "max_dd_pct": 0.0}
    years = (n - 1) / 242.0
    cagr = (nav_series[-1] / nav_series[0]) ** (1.0 / years) - 1.0 if years > 0 else 0.0
    rets = [nav_series[i] / nav_series[i - 1] - 1.0 for i in range(1, n) if nav_series[i - 1] > 0]
    mean_r = sum(rets) / len(rets) if rets else 0.0
    vol = math.sqrt(sum((r - mean_r) ** 2 for r in rets) / max(1, len(rets))) * math.sqrt(242.0)
    peak = nav_series[0]
    max_dd = 0.0
    for v in nav_series:
        if v > peak:
            peak = v
        dd = (v / peak - 1.0) if peak > 0 else 0.0
        if dd < max_dd:
            max_dd = dd
    return {
        "cagr_pct": round(cagr * 100.0, 2),
        "vol_pct": round(vol * 100.0, 2),
        "max_dd_pct": round(max_dd * 100.0, 2),
    }


def build_convergence_module(cfg: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    """模块1：沪深300全收益指数 vs 二级债基指数（重建）波动收敛走势。"""
    base_date = cfg["base_date"]
    start_ymd = base_date.replace("-", "")
    bond_w = float(cfg.get("bond_weight", 0.82))
    mixed_w = float(cfg.get("mixed_weight", 0.18))
    anchors: dict[str, float] = {str(k): float(v) for k, v in cfg.get("wind_885007_annual_anchors", {}).items()}
    merge_gap = int(cfg.get("episode_merge_gap_days", 50))

    h300_rows, url_300 = csi_index_perf(cfg["csi300_tri_code"], start_ymd, cache_file=cache_dir / "csi_H00300.json")
    hbond_rows, url_bond = csi_index_perf(cfg["csi_bond_fund_code"], start_ymd, cache_file=cache_dir / "csi_H11023.json")
    hmix_rows, _ = csi_index_perf(cfg["csi_mixed_fund_code"], start_ymd, cache_file=cache_dir / "csi_H11022.json")

    map_300 = {r["date"]: r["close"] for r in h300_rows}
    map_bond = {r["date"]: r["close"] for r in hbond_rows}
    map_mix = {r["date"]: r["close"] for r in hmix_rows}

    # Align on H00300 trading calendar; forward-fill 1-day lag if bond fund index settles T+1
    dates = sorted(d for d in map_300.keys() if d >= base_date)
    if not dates:
        raise RuntimeError("沪深300全收益指数数据为空")

    base_300 = map_300[dates[0]]
    first_bond_date = next((d for d in dates if d in map_bond), None)
    first_mix_date = next((d for d in dates if d in map_mix), None)
    if not first_bond_date or not first_mix_date:
        raise RuntimeError("中证基金指数数据缺失")

    # Fill daily bond/mix close aligned to H00300 dates
    aligned_bond: list[float] = []
    aligned_mix: list[float] = []
    cur_b = map_bond[first_bond_date]
    cur_m = map_mix[first_mix_date]
    for d in dates:
        if d in map_bond:
            cur_b = map_bond[d]
        if d in map_mix:
            cur_m = map_mix[d]
        aligned_bond.append(cur_b)
        aligned_mix.append(cur_m)

    # Raw daily composite returns (0.82 * H11023 + 0.18 * H11022)
    raw_daily_rets = [0.0]
    for i in range(1, len(dates)):
        rb = aligned_bond[i] / aligned_bond[i - 1] - 1.0
        rm = aligned_mix[i] / aligned_mix[i - 1] - 1.0
        raw_daily_rets.append(bond_w * rb + mixed_w * rm)

    # Group indices by calendar year to align completed years to Wind 885007.WI annual returns
    year_indices: dict[str, list[int]] = {}
    for i, d in enumerate(dates):
        if i == 0:
            continue
        year_indices.setdefault(d[:4], []).append(i)

    adj_daily_rets = list(raw_daily_rets)
    for year, idxs in year_indices.items():
        if year in anchors and len(idxs) > 0:
            target_ann = anchors[year]
            raw_prod = 1.0
            for idx in idxs:
                raw_prod *= (1.0 + raw_daily_rets[idx])
            if raw_prod > 0 and (1.0 + target_ann) > 0:
                log_drift = (math.log(1.0 + target_ann) - math.log(raw_prod)) / len(idxs)
                for idx in idxs:
                    adj_daily_rets[idx] = math.exp(math.log(max(1e-6, 1.0 + raw_daily_rets[idx])) + log_drift) - 1.0

    # Compound NAVs (base = 1.0 on 2004-12-31)
    nav_300: list[float] = []
    nav_bond2: list[float] = []
    nav_csi_bond: list[float] = []
    cur_b2 = 1.0
    base_csi_bond = aligned_bond[0]

    for i, d in enumerate(dates):
        n300 = map_300[d] / base_300
        if i > 0:
            cur_b2 *= (1.0 + adj_daily_rets[i])
        nav_300.append(n300)
        nav_bond2.append(cur_b2)
        nav_csi_bond.append(aligned_bond[i] / base_csi_bond)

    # Convert to cumulative return % and log-friendly index (NAV * 100)
    pct_300 = [round((v - 1.0) * 100.0, 2) for v in nav_300]
    pct_bond2 = [round((v - 1.0) * 100.0, 2) for v in nav_bond2]
    pct_csi_bond = [round((v - 1.0) * 100.0, 2) for v in nav_csi_bond]
    spread_pct = [round(pct_300[i] - pct_bond2[i], 2) for i in range(len(dates))]

    # Detect episodes where 沪深300全收益 < 二级债基指数（重建）
    raw_episodes: list[list[int]] = []
    in_ep = False
    for i in range(len(dates)):
        below = nav_300[i] < nav_bond2[i]
        if below and not in_ep:
            raw_episodes.append([i, i])
            in_ep = True
        elif below and in_ep:
            raw_episodes[-1][1] = i
        elif not below and in_ep:
            in_ep = False

    # Merge micro-bounces separated by <= merge_gap calendar days
    merged_idx: list[list[int]] = []
    for st, ed in raw_episodes:
        if merged_idx:
            d_prev = datetime.strptime(dates[merged_idx[-1][1]], "%Y-%m-%d")
            d_cur = datetime.strptime(dates[st], "%Y-%m-%d")
            if (d_cur - d_prev).days <= merge_gap:
                merged_idx[-1][1] = ed
                continue
        merged_idx.append([st, ed])

    # Build episode bands & trough red circles (exclude trivial 1-day opening jitter if < 2 days and spread > -1%)
    episodes = []
    for st, ed in merged_idx:
        trough_i = min(range(st, ed + 1), key=lambda k: pct_300[k] - pct_bond2[k])
        min_spread = round(pct_300[trough_i] - pct_bond2[trough_i], 2)
        # Keep genuine cross-below episodes
        if (ed - st) == 0 and min_spread > -1.0:
            continue
        episodes.append({
            "start_date": dates[st],
            "end_date": dates[ed],
            "trading_days": ed - st + 1,
            "trough_date": dates[trough_i],
            "trough_300_pct": pct_300[trough_i],
            "trough_bond2_pct": pct_bond2[trough_i],
            "trough_300_nav": round(nav_300[trough_i], 4),
            "min_spread_pct": min_spread,
        })

    # Compute rolling 250-day annualized volatility comparison (latest)
    def _roll_vol(navs: list[float], win: int = 250) -> float:
        seg = navs[-min(len(navs), win + 1) :]
        rs = [seg[k] / seg[k - 1] - 1.0 for k in range(1, len(seg)) if seg[k - 1] > 0]
        if len(rs) < 10:
            return 0.0
        m = sum(rs) / len(rs)
        return round(math.sqrt(sum((x - m) ** 2 for x in rs) / len(rs)) * math.sqrt(242.0) * 100.0, 2)

    stats_300 = _ann_stats(nav_300)
    stats_bond2 = _ann_stats(nav_bond2)

    return {
        "base_date": dates[0],
        "latest_date": dates[-1],
        "bond_latest_date": max(map_bond.keys()),
        "source_note": f"中证官方日频指数 ({cfg['csi300_tri_code']} 沪深300全收益、{cfg['csi_bond_fund_code']} 中证债基、{cfg['csi_mixed_fund_code']} 中证混基)；二级债基2005–2025年度收益对齐Wind 885007.WI披露值，2026年起按0.82×中证债基+0.18×中证混基实时日频外推",
        "source_urls": [url_300, url_bond],
        "dates": dates,
        "csi300_tri_pct": pct_300,
        "bond2_pct": pct_bond2,
        "csi_bond_pct": pct_csi_bond,
        "spread_pct": spread_pct,
        "csi300_tri_nav": [round(v, 4) for v in nav_300],
        "bond2_nav": [round(v, 4) for v in nav_bond2],
        "csi_bond_nav": [round(v, 4) for v in nav_csi_bond],
        "episodes": episodes,
        "summary": {
            "csi300_cum_pct": pct_300[-1],
            "bond2_cum_pct": pct_bond2[-1],
            "csi_bond_cum_pct": pct_csi_bond[-1],
            "spread_pct": spread_pct[-1],
            "ratio_300_to_bond2": round(nav_300[-1] / nav_bond2[-1], 3),
            "episode_count": len(episodes),
            "last_episode_date": episodes[-1]["trough_date"] if episodes else "—",
            "is_currently_below": nav_300[-1] < nav_bond2[-1],
            "csi300_cagr_pct": stats_300["cagr_pct"],
            "csi300_vol_pct": stats_300["vol_pct"],
            "csi300_max_dd_pct": stats_300["max_dd_pct"],
            "csi300_vol_1y_pct": _roll_vol(nav_300, 250),
            "bond2_cagr_pct": stats_bond2["cagr_pct"],
            "bond2_vol_pct": stats_bond2["vol_pct"],
            "bond2_max_dd_pct": stats_bond2["max_dd_pct"],
            "bond2_vol_1y_pct": _roll_vol(nav_bond2, 250),
        },
    }


def build_technical_modules(cfg: dict[str, Any]) -> dict[str, Any]:
    """模块3/4/5：科创50、创业板50、黄金（AU0/Au99.99/518880）、燕东微 日K + SMC 技术分析。"""
    assets_cfg = cfg["technical_assets"]
    smc_params = cfg["smc_params"]
    results: dict[str, Any] = {}

    # Batch fetch Tencent real-time/close quotes for A-share indices/ETFs/stocks
    tq_codes = [
        item["code"]
        for item in assets_cfg.values()
        if item["source"] == "tencent"
    ]
    quotes: dict[str, Any] = {}
    try:
        quotes = tencent_quote(tq_codes)
    except Exception as exc:
        print(f"[WARN] tencent_quote failed: {exc}")

    for key, spec in assets_cfg.items():
        src = spec["source"]
        code = spec["code"]
        count = int(spec.get("count", 520))
        decimals = int(spec.get("decimals", 2))
        print(f"  -> Fetching {key} ({spec['title']} / {code}) via {src} ...")

        if src == "tencent":
            bars, url = tencent_kline(code, period="day", adjust="qfq", count=count)
            source_label = "腾讯财经日K (前复权)" if spec["asset_type"] in ("stock_star", "etf") else "腾讯财经日K"
        elif src == "sge":
            bars, url = sge_spot_kline(code, count=count)
            source_label = "上海黄金交易所官方日线"
        elif src == "sina_futures":
            bars, url = sina_futures_kline(code, count=count)
            source_label = "新浪期货主力连续日K (SHFE)"
        elif src == "sina_global_futures":
            bars, url = sina_global_futures_kline(code, count=count)
            source_label = "新浪外盘伦敦金现日K (XAU/USD)"
        else:
            raise ValueError(f"Unsupported source: {src}")

        analyzed = analyze_technical_series(bars, params=smc_params, decimals=decimals)
        q = quotes.get(code)
        analyzed["meta"] = {
            "key": key,
            "title": spec["title"],
            "code": code,
            "display_code": spec["display_code"],
            "asset_type": spec["asset_type"],
            "price_unit": spec["price_unit"],
            "volume_unit": spec["volume_unit"],
            "decimals": decimals,
            "source": source_label,
            "source_url": url,
            "bar_count": len(bars),
            "date_range": [bars[0]["date"], bars[-1]["date"]],
        }
        if q:
            analyzed["quote"] = {
                "price": q["price"],
                "change_pct": q["change_pct"],
                "change_amt": q["change_amt"],
                "turnover_pct": q["turnover_pct"],
                "amplitude_pct": q["amplitude_pct"],
                "pe_ttm": q["pe_ttm"],
                "pe_static": q["pe_static"],
                "pb": q["pb"],
                "float_mcap_yi": q["float_mcap_yi"],
                "mcap_yi": q["mcap_yi"],
                "amount_wan": q["amount_wan"],
                "vol_ratio": q["vol_ratio"],
                "is_stale": q["is_stale"],
            }
        results[key] = analyzed
        s = analyzed["summary"]
        smc = analyzed["smc"]
        print(
            f"     OK: {s['latest_date']} close={s['close']} ({s['change_pct']:+.2f}%), "
            f"Swing={smc['swing_trend_label']}, OB={s['active_bull_ob_count']}多/{s['active_bear_ob_count']}空, FVG={s['active_fvg_count']}"
        )

    return results


def main() -> int:
    cfg = json.loads((ROOT_DIR / "config.json").read_text(encoding="utf-8"))
    data_dir = ROOT_DIR / "data"
    cache_dir = data_dir / "cache"
    data_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    output_path = data_dir / "dashboard_data.json"
    existing_data: dict[str, Any] = {}
    if output_path.exists():
        try:
            existing_data = json.loads(output_path.read_text(encoding="utf-8"))
        except Exception:
            existing_data = {}

    status_log: dict[str, dict[str, Any]] = {}

    print("[1/3] Updating Module 1: 沪深300全收益 vs 二级债基指数（波动收敛）...")
    try:
        convergence = build_convergence_module(cfg["convergence"], cache_dir)
        status_log["convergence"] = {
            "ok": True,
            "latest_date": convergence["latest_date"],
            "note": f"H00300 更新至 {convergence['latest_date']}，跌破次数 {convergence['summary']['episode_count']} 次",
        }
        print(f"  -> OK: latest={convergence['latest_date']}, 300TRI={convergence['summary']['csi300_cum_pct']}%, Bond2={convergence['summary']['bond2_cum_pct']}%, episodes={convergence['summary']['episode_count']}")
    except Exception as exc:
        traceback.print_exc()
        if "convergence" in existing_data:
            convergence = existing_data["convergence"]
            status_log["convergence"] = {"ok": False, "latest_date": convergence.get("latest_date", ""), "note": f"沿用上次缓存（{exc}）"}
        else:
            raise

    print("[2/3] Updating Module 2: 国家队持有全A宽基ETF份额走势...")
    try:
        national_team = fetch_national_team_bundle(cfg["national_team"], data_dir / "etf_history_cache.json")
        status_log["national_team"] = {
            "ok": True,
            "latest_date": national_team["latest_date"],
            "note": f"16只宽基ETF总份额 {national_team['summary']['total_shares_yi']} 亿份",
        }
        print(f"  -> OK: latest={national_team['latest_date']}, shares={national_team['summary']['total_shares_yi']}亿份, flow1d={national_team['summary']['flow_1d_yi']:+.2f}亿元")
    except Exception as exc:
        traceback.print_exc()
        if "national_team" in existing_data:
            national_team = existing_data["national_team"]
            status_log["national_team"] = {"ok": False, "latest_date": national_team.get("latest_date", ""), "note": f"沿用上次缓存（{exc}）"}
        else:
            raise

    print("[3/3] Updating Modules 3-5: 科创50 / 创业板50 / 黄金 / 燕东微 技术分析与SMC...")
    try:
        technical = build_technical_modules(cfg)
        latest_tech_dates = [v["summary"]["latest_date"] for v in technical.values()]
        status_log["technical"] = {
            "ok": True,
            "latest_date": max(latest_tech_dates) if latest_tech_dates else "",
            "note": f"共 {len(technical)} 个标的全部更新成功",
        }
    except Exception as exc:
        traceback.print_exc()
        if "technical" in existing_data:
            technical = existing_data["technical"]
            status_log["technical"] = {"ok": False, "latest_date": "", "note": f"沿用上次缓存（{exc}）"}
        else:
            raise

    print("[4/5] Updating Gold Macro Bundle: 美元指数(DXY) / 美国10年期与2年期国债收益率...")
    try:
        gold_macro = fetch_gold_macro_bundle(cfg["gold_macro"])
        status_log["gold_macro"] = {
            "ok": True,
            "latest_date": gold_macro["latest_date"],
            "note": f"DXY / US10Y / US2Y 更新至 {gold_macro['latest_date']}",
        }
    except Exception as exc:
        traceback.print_exc()
        if "gold_macro" in existing_data:
            gold_macro = existing_data["gold_macro"]
            status_log["gold_macro"] = {"ok": False, "latest_date": gold_macro.get("latest_date", ""), "note": f"沿用上次缓存（{exc}）"}
        else:
            gold_macro = {"latest_date": "", "series": {}, "spread_10y_2y": None}
            status_log["gold_macro"] = {"ok": False, "latest_date": "", "note": f"拉取失败（{exc}）"}

    all_dates = [
        convergence.get("latest_date", ""),
        national_team.get("latest_date", ""),
        gold_macro.get("latest_date", ""),
        *[v["summary"]["latest_date"] for v in technical.values()],
    ]
    latest_market_date = max((d for d in all_dates if d), default="")

    # Attach latest wave & channel chart overlays to every technical asset
    for k, item in technical.items():
        bars = [
            {
                "date": item["dates"][i],
                "open": item["ohlc"][i][0],
                "close": item["ohlc"][i][1],
                "low": item["ohlc"][i][2],
                "high": item["ohlc"][i][3],
            }
            for i in range(len(item["dates"]))
        ]
        dec = int(item["meta"]["decimals"])
        thresh = 0.045 if k in ("gold_xau", "gold_etf") else 0.06
        item["wave"] = analyze_elliott_wave(bars, decimals=dec, pct_threshold=thresh)
        item["channel"] = analyze_price_channel(bars, window_len=60, decimals=dec)

    # Always generate fresh live briefings from latest market snapshot
    now_cst = datetime.now(CST)
    today_cst = now_cst.strftime("%Y-%m-%d")
    gen_ts = now_cst_str()
    briefings_dir = data_dir / "briefings"
    briefings_dir.mkdir(parents=True, exist_ok=True)
    today_briefing_file = briefings_dir / f"{today_cst}.json"
    latest_briefing_file = data_dir / "morning_briefing.json"

    print(f"[5/5] Generating Live Briefings (Wave + Channel + Macro) for {today_cst} ...")
    morning_briefing = generate_morning_briefing(
        convergence=convergence,
        national_team=national_team,
        technical=technical,
        generated_at=gen_ts,
        edition_date=today_cst,
    )
    briefing_compact = {k: v for k, v in morning_briefing.items() if k != "overlays"}
    today_briefing_file.write_text(json.dumps(briefing_compact, ensure_ascii=False, indent=2), encoding="utf-8")
    latest_briefing_file.write_text(json.dumps(briefing_compact, ensure_ascii=False, indent=2), encoding="utf-8")

    gold_briefing = generate_gold_briefing(
        technical=technical,
        gold_macro=gold_macro,
        generated_at=gen_ts,
        edition_date=today_cst,
    )
    print(f"  -> OK: live briefings generated ({today_briefing_file.name})")

    payload = {
        "meta": {
            "title": cfg["dashboard_title"],
            "updated_at": gen_ts,
            "latest_market_date": latest_market_date,
            "schedule_note": cfg["schedule_note"],
            "status": status_log,
        },
        "morning_briefing": briefing_compact,
        "gold_briefing": gold_briefing,
        "convergence": convergence,
        "national_team": national_team,
        "gold_macro": gold_macro,
        "technical": technical,
    }

    json_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    tmp_path = data_dir / "dashboard_data.json.tmp"
    tmp_path.write_text(json_text, encoding="utf-8")
    tmp_path.replace(output_path)

    # 1. Also write data/dashboard_data.js so HTML works seamlessly via file:// double-click
    js_path = data_dir / "dashboard_data.js"
    js_tmp = data_dir / "dashboard_data.js.tmp"
    js_tmp.write_text("window.__DASHBOARD_DATA__=" + json_text + ";\n", encoding="utf-8")
    js_tmp.replace(js_path)

    # 2. Build THREE self-contained single-file shareable HTML snapshots:
    #    - dist/market-dashboard-share.html (主市场 4 大核心项目)
    #    - dist/gold-share.html (黄金 + 美元指数 + 美国10Y/2Y国债收益率独立看板)
    #    - dist/yandongwei-share.html (燕东微独立看板)
    market_payload = {
        "meta": payload["meta"],
        "morning_briefing": payload["morning_briefing"],
        "convergence": payload["convergence"],
        "national_team": payload["national_team"],
        "technical": {k: payload["technical"][k] for k in ("star50", "cyb") if k in payload["technical"]},
    }
    market_json = json.dumps(market_payload, ensure_ascii=False, separators=(",", ":"))
    market_share = build_single_file_snapshot(ROOT_DIR, "index.html", "market-dashboard-share.html", market_json)

    gold_payload = {
        "meta": payload["meta"],
        "gold_briefing": payload["gold_briefing"],
        "gold_macro": payload["gold_macro"],
        "technical": {k: payload["technical"][k] for k in ("gold_xau", "gold_stock_etf", "gold_etf") if k in payload["technical"]},
    }
    gold_json = json.dumps(gold_payload, ensure_ascii=False, separators=(",", ":"))
    gold_share = build_single_file_snapshot(ROOT_DIR, "gold.html", "gold-share.html", gold_json)

    ydw_payload = {
        "meta": payload["meta"],
        "technical": {"yandongwei": payload["technical"]["yandongwei"]},
    }
    ydw_json = json.dumps(ydw_payload, ensure_ascii=False, separators=(",", ":"))
    ydw_share = build_single_file_snapshot(ROOT_DIR, "yandongwei.html", "yandongwei-share.html", ydw_json)

    size_kb = output_path.stat().st_size / 1024.0
    parts = [f"{output_path.name} ({size_kb:.1f} KB)"]
    if market_share:
        parts.append(f"{market_share.name} ({market_share.stat().st_size / 1024.0:.1f} KB)")
    if gold_share:
        parts.append(f"{gold_share.name} ({gold_share.stat().st_size / 1024.0:.1f} KB)")
    if ydw_share:
        parts.append(f"{ydw_share.name} ({ydw_share.stat().st_size / 1024.0:.1f} KB)")
    print(f"\n[DONE] Generated {' | '.join(parts)} | latest_market_date={latest_market_date}")
    return 0


def build_single_file_snapshot(root_dir: Path, template_name: str, out_name: str, json_text: str) -> Path | None:
    """打包完全自包含的单文件离线 HTML（含样式、ECharts、数据和脚本），可直接通过微信/邮件分享打开。"""
    index_path = root_dir / template_name
    css_path = root_dir / "assets" / "styles.css"
    app_path = root_dir / "assets" / "app.js"
    echarts_path = root_dir / "assets" / "vendor" / "echarts.min.js"
    if not (index_path.exists() and css_path.exists() and app_path.exists()):
        return None

    html_src = index_path.read_text(encoding="utf-8")
    css_src = css_path.read_text(encoding="utf-8")
    app_src = app_path.read_text(encoding="utf-8")

    # Safely escape </script> inside embedded JS/JSON
    safe_json = json_text.replace("</", "<\\/")
    safe_app = app_src.replace("</script>", "<\\/script>")

    import re as _re
    html_out = _re.sub(
        r'<link rel="stylesheet" href="assets/styles\.css(?:\?[^"]*)?"\s*/>',
        lambda _: f"<style>\n{css_src}\n</style>",
        html_src,
    )

    if echarts_path.exists():
        echarts_src = echarts_path.read_text(encoding="utf-8", errors="ignore").replace("</script>", "<\\/script>")
        echarts_tag = (
            '<script src="assets/vendor/echarts.min.js"\n'
            '          onerror="document.write(\'<script src=&quot;https://cdn.bootcdn.net/ajax/libs/echarts/5.5.0/echarts.min.js&quot;><\\/script>\')"></script>'
        )
        if echarts_tag in html_out:
            html_out = html_out.replace(echarts_tag, f"<script>\n{echarts_src}\n</script>")

    html_out = html_out.replace(
        '<script src="data/dashboard_data.js"></script>',
        f"<script>window.__DASHBOARD_DATA__={safe_json};</script>",
    )
    live_engine_path = root_dir / "assets" / "live_engine.js"
    if live_engine_path.exists():
        live_src = live_engine_path.read_text(encoding="utf-8").replace("</script>", "<\\/script>")
        html_out = _re.sub(
            r'<script src="assets/live_engine\.js(?:\?[^"]*)?"></script>',
            lambda _: f"<script>\n{live_src}\n</script>",
            html_out,
        )
    html_out = _re.sub(
        r'<script src="assets/app\.js(?:\?[^"]*)?"></script>',
        lambda _: f"<script>\n{safe_app}\n</script>",
        html_out,
    )

    dist_dir = root_dir / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)
    out_file = dist_dir / out_name
    tmp_file = dist_dir / (out_name + ".tmp")
    tmp_file.write_text(html_out, encoding="utf-8")
    tmp_file.replace(out_file)
    return out_file


if __name__ == "__main__":
    raise SystemExit(main())
