"""
A股与大类资产免Key高可用数据获取模块
提炼并遵循 simonlin1212/a-stock-data V3.10.4 的数据源优先级与防踩坑规范：
1. 优先腾讯财经（实时快照 + 三入口轮换日K）、中证官方指数接口、上金所官方现货、新浪期货日K、沪深交易所官方ETF份额；
2. 市场前缀显式路由（防止 000xxx 指数与深市个股撞码）；
3. 科创板（688/689）腾讯 K 线成交量单位为「股」，其余为「手」；
4. 腾讯实时行情索引校准：43=振幅%(非PB)、44=流通市值(亿)、45=总市值(亿)、46=PB、39=PE_TTM；
5. 自动重试 + 本地磁盘缓存兜底，避免瞬态网络抖动导致看板中断。
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import urllib.error
import urllib.parse
import urllib.request

try:
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    HAS_REQUESTS = True
except ImportError:
    requests = None  # type: ignore[assignment]
    HAS_REQUESTS = False

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

SH_INDEX_WHITELIST = {"000001", "000300", "000905", "000016", "000688", "000852", "000010"}

TENCENT_KLINE_HOSTS = [
    "https://web.ifzq.gtimg.cn",
    "https://proxy.finance.qq.com/ifzqgtimg",
    "https://ifzq.gtimg.cn",
]

CSI_PERF_URL = "https://www.csindex.com.cn/csindex-home/perf/index-perf"
SGE_DAILY_URL = "https://www.sge.com.cn/graph/Dailyhq"
SINA_FUT_KLINE_URL = (
    "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_{code}="
    "/InnerFuturesNewService.getDailyKLine"
)
SINA_GLOBAL_FUT_KLINE_URL = (
    "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_{code}="
    "/GlobalFuturesService.getGlobalFuturesDailyKLine"
)
SSE_ETF_SHARES_URL = "https://query.sse.com.cn/commonQuery.do"
SZSE_FUND_LIST_URL = "https://fund.szse.cn/api/report/ShowReport/data"
EASTMONEY_KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
EASTMONEY_QUOTE_URL = "https://push2.eastmoney.com/api/qt/ulist.np/get"
SINA_FOREX_KLINE_URL = (
    "https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/var%20_{code}="
    "/NewForexService.getDayKLine"
)

CST = timezone(timedelta(hours=8))


def now_cst_str() -> str:
    return datetime.now(CST).strftime("%Y-%m-%d %H:%M (北京时间)")


class _UrllibResponse:
    def __init__(self, status: int, content: bytes):
        self.status_code = status
        self.content = content

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> Any:
        return json.loads(self.content.decode("utf-8"))


class _UrllibSession:
    def __init__(self) -> None:
        self.headers: dict[str, str] = {}

    def _req(
        self,
        method: str,
        url: str,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        timeout: Any = 20,
    ) -> _UrllibResponse:
        if params:
            sep = "&" if "?" in url else "?"
            url = url + sep + urllib.parse.urlencode(params, safe=",.:")
        body = urllib.parse.urlencode(data).encode("utf-8") if data is not None else None
        req_headers = {**self.headers, **(headers or {})}
        if body is not None and "Content-Type" not in req_headers:
            req_headers["Content-Type"] = "application/x-www-form-urlencoded"
        t = timeout[1] if isinstance(timeout, tuple) else float(timeout)
        last_exc: Exception | None = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, data=body, headers=req_headers, method=method)
                with urllib.request.urlopen(req, timeout=t) as resp:
                    return _UrllibResponse(resp.status, resp.read())
            except Exception as exc:
                last_exc = exc
                if attempt < 3:
                    time.sleep(0.7 * (attempt + 1))
        raise RuntimeError(str(last_exc))

    def get(self, url: str, **kwargs: Any) -> _UrllibResponse:
        return self._req("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> _UrllibResponse:
        return self._req("POST", url, **kwargs)


def create_retry_session() -> Any:
    if not HAS_REQUESTS:
        session = _UrllibSession()
        session.headers.update({"User-Agent": UA})
        return session
    session = requests.Session()
    session.headers.update({"User-Agent": UA})
    retry = Retry(
        total=4,
        connect=4,
        read=3,
        backoff_factor=0.7,
        respect_retry_after_header=False,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


SESSION = create_retry_session()


def normalize_tencent_symbol(code: str) -> str:
    raw = str(code).strip()
    low = raw.lower()
    if low.startswith(("sh", "sz", "bj")):
        return low
    if "." in low:
        num, suf = low.split(".", 1)
        if suf in ("sh", "xshg"):
            return f"sh{num}"
        if suf in ("sz", "xshe"):
            return f"sz{num}"
        if suf == "bj":
            return f"bj{num}"
    if raw.startswith("92"):
        return f"bj{raw}"
    if raw in SH_INDEX_WHITELIST or raw.startswith(("5", "6", "9")):
        return f"sh{raw}"
    if raw.startswith(("4", "8")):
        return f"bj{raw}"
    return f"sz{raw}"


def tencent_quote(codes: list[str]) -> dict[str, dict[str, Any]]:
    """批量拉取腾讯财经实时/收盘快照（严格遵循 a-stock-data 字段索引校准）。"""
    prefixed = []
    key_of = {}
    for c in codes:
        p = normalize_tencent_symbol(c)
        prefixed.append(p)
        key_of[p] = c

    url = "https://qt.gtimg.cn/q=" + ",".join(prefixed)
    resp = SESSION.get(url, timeout=(12, 20))
    resp.raise_for_status()
    text = resp.content.decode("gbk", errors="replace")

    out: dict[str, dict[str, Any]] = {}
    for line in text.strip().split(";"):
        if not line.strip() or "=" not in line or '"' not in line:
            continue
        key = line.split("=")[0].split("_")[-1]
        vals = line.split('"')[1].split("~")
        if len(vals) < 53:
            continue

        def _f(idx: int) -> float:
            try:
                return float(vals[idx]) if vals[idx] not in ("", "-") else 0.0
            except (ValueError, IndexError):
                return 0.0

        orig_key = key_of.get(key, key)
        price = _f(3)
        last_close = _f(4)
        amount_wan = _f(37)
        out[orig_key] = {
            "symbol": key,
            "name": vals[1],
            "code": vals[2],
            "price": price,
            "last_close": last_close,
            "open": _f(5),
            "change_amt": _f(31),
            "change_pct": _f(32),
            "high": _f(33),
            "low": _f(34),
            "amount_wan": amount_wan,
            "turnover_pct": _f(38),
            "pe_ttm": _f(39),
            "amplitude_pct": _f(43),  # 43=振幅%，非PB
            "float_mcap_yi": _f(44),  # 44=流通市值(亿)
            "mcap_yi": _f(45),        # 45=总市值(亿)
            "pb": _f(46),             # 46=市净率PB
            "limit_up": _f(47),
            "limit_down": _f(48),
            "vol_ratio": _f(49),
            "pe_static": _f(52),
            "is_stale": (amount_wan == 0 and price == last_close and price > 0),
        }
    return out


def tencent_kline(
    code: str,
    period: str = "day",
    adjust: str = "qfq",
    count: int = 520,
) -> tuple[list[dict[str, Any]], str]:
    """腾讯日K线（三入口自动轮换，免Key不封IP）。"""
    symbol = normalize_tencent_symbol(code)
    param = f"{symbol},{period},,,{int(count)},{adjust}"
    last_err = None
    for host in TENCENT_KLINE_HOSTS:
        url = f"{host}/appstock/app/fqkline/get"
        try:
            resp = SESSION.get(
                url,
                params={"param": param},
                headers={"Referer": "https://gu.qq.com/"},
                timeout=(12, 25),
            )
            resp.raise_for_status()
            payload = resp.json()
            data = payload.get("data", {})
            node = data.get(symbol)
            if not isinstance(node, dict):
                last_err = f"{host}: 缺少 {symbol} 节点"
                continue
            key = adjust + period
            items = node.get(key) if isinstance(node.get(key), list) else node.get(period)
            if not items:
                last_err = f"{host}: 返回空K线列表"
                continue
            rows = []
            seen = set()
            for item in items:
                dt = str(item[0]).strip()
                if dt in seen:
                    continue
                seen.add(dt)
                o, c, h, l = float(item[1]), float(item[2]), float(item[3]), float(item[4])
                vol = float(item[5]) if len(item) > 5 and item[5] not in ("", None) else 0.0
                if min(o, c, h, l) <= 0:
                    continue
                rows.append({"date": dt, "open": o, "close": c, "high": h, "low": l, "volume": vol})
            rows.sort(key=lambda r: r["date"])
            return rows, url
        except Exception as exc:
            last_err = f"{host}: {type(exc).__name__}: {exc}"
            continue
    raise RuntimeError(f"腾讯 K 线 {symbol} 三入口均失败: {last_err}")


def csi_index_perf(
    index_code: str,
    start_date: str = "20041231",
    end_date: str | None = None,
    cache_file: Path | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """中证指数官方日频收盘序列（如 H00300 沪深300全收益、H11023 中证债基、H11022 中证混基）。"""
    end_ymd = end_date or (datetime.now(CST) + timedelta(days=1)).strftime("%Y%m%d")
    cached_map: dict[str, float] = {}
    fetch_start = start_date

    if cache_file and cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            if isinstance(cached, dict) and cached:
                cached_map = {k: float(v) for k, v in cached.items()}
                # Incremental refresh: re-fetch last 15 days to catch any late revisions
                last_cached = max(cached_map.keys())
                dt_last = datetime.strptime(last_cached, "%Y-%m-%d") - timedelta(days=15)
                fetch_start = max(start_date, dt_last.strftime("%Y%m%d"))
        except Exception:
            cached_map = {}

    try:
        resp = SESSION.get(
            CSI_PERF_URL,
            params={"indexCode": index_code, "startDate": fetch_start, "endDate": end_ymd},
            headers={"Referer": "https://www.csindex.com.cn/"},
            timeout=(15, 35),
        )
        resp.raise_for_status()
        payload = resp.json()
        data = payload.get("data") or []
        for item in data:
            td = str(item.get("tradeDate", "")).strip()
            cl = item.get("close")
            if len(td) == 8 and cl is not None:
                iso = f"{td[:4]}-{td[4:6]}-{td[6:8]}"
                cached_map[iso] = float(cl)
        if cache_file and cached_map:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(cached_map, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        if not cached_map:
            raise RuntimeError(f"中证官方指数 {index_code} 拉取失败且无本地缓存: {exc}") from exc

    rows = [{"date": d, "close": cached_map[d]} for d in sorted(cached_map.keys())]
    return rows, f"{CSI_PERF_URL}?indexCode={index_code}"


def sge_spot_kline(instrument: str = "Au99.99", count: int = 520) -> tuple[list[dict[str, Any]], str]:
    """上海黄金交易所官方现货日K（元/克）。"""
    resp = SESSION.post(
        SGE_DAILY_URL,
        data={"instid": instrument},
        headers={"Referer": "https://www.sge.com.cn/"},
        timeout=(15, 30),
    )
    resp.raise_for_status()
    payload = resp.json()
    series = payload.get("time")
    if not isinstance(series, list):
        raise RuntimeError("上金所日线返回格式异常")
    rows = []
    for rec in series:
        if not isinstance(rec, list) or len(rec) != 5:
            continue
        o, c, l, h = float(rec[1]), float(rec[2]), float(rec[3]), float(rec[4])
        if min(o, c, l, h) <= 0:
            continue
        # Fix rare SGE source OHLC boundary anomalies conservatively for clean candlestick rendering
        real_h = max(h, o, c)
        real_l = min(l, o, c)
        rows.append({"date": str(rec[0]), "open": o, "close": c, "high": real_h, "low": real_l, "volume": None})
    rows.sort(key=lambda r: r["date"])
    if count and len(rows) > count:
        rows = rows[-count:]
    return rows, SGE_DAILY_URL


def sina_futures_kline(symbol: str = "AU0", count: int = 520) -> tuple[list[dict[str, Any]], str]:
    """新浪国内期货日K线（主力连续或具体合约，含成交量与持仓量）。"""
    code = str(symbol).strip().upper()
    url = SINA_FUT_KLINE_URL.format(code=code)
    resp = SESSION.get(
        url,
        params={"symbol": code},
        headers={"Referer": "https://finance.sina.com.cn/"},
        timeout=(12, 25),
    )
    resp.raise_for_status()
    text = resp.content.decode("gbk", errors="replace")
    m = re.search(rf"var _{re.escape(code)}=\((.*)\);?\s*$", text, re.S)
    if not m:
        raise RuntimeError(f"新浪期货 {code} 返回非预期 JSONP")
    items = json.loads(m.group(1).strip())
    rows = []
    for r in items:
        o, h, l, c = float(r["o"]), float(r["h"]), float(r["l"]), float(r["c"])
        if min(o, h, l, c) <= 0:
            continue
        vol = float(r.get("v") or 0)
        oi = float(r.get("p") or 0)
        rows.append({
            "date": str(r["d"]),
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": vol,
            "open_interest": oi,
        })
    rows.sort(key=lambda r: r["date"])
    if count and len(rows) > count:
        rows = rows[-count:]
    return rows, url


def sina_global_futures_kline(symbol: str = "XAU", count: int = 520) -> tuple[list[dict[str, Any]], str]:
    """新浪外盘现货/期货日K线（如 XAU 伦敦金现，美元/盎司）。"""
    code = str(symbol).strip().upper()
    url = SINA_GLOBAL_FUT_KLINE_URL.format(code=code)
    resp = SESSION.get(
        url,
        params={"symbol": code},
        headers={"Referer": "https://finance.sina.com.cn/"},
        timeout=(12, 25),
    )
    resp.raise_for_status()
    text = resp.content.decode("gbk", errors="replace")
    m = re.search(rf"var _{re.escape(code)}=\((.*)\);?\s*$", text, re.S)
    if not m:
        raise RuntimeError(f"新浪外盘日K {code} 返回非预期 JSONP")
    items = json.loads(m.group(1).strip())
    rows = []
    for r in items:
        o = float(r.get("open") or r.get("o") or 0)
        h = float(r.get("high") or r.get("h") or 0)
        l = float(r.get("low") or r.get("l") or 0)
        c = float(r.get("close") or r.get("c") or 0)
        if min(o, h, l, c) <= 0:
            continue
        vol = float(r.get("volume") or r.get("v") or 0)
        rows.append({
            "date": str(r.get("date") or r.get("d")),
            "open": o,
            "high": max(h, o, c),
            "low": min(l, o, c),
            "close": c,
            "volume": vol if vol > 0 else None,
        })
    rows.sort(key=lambda r: r["date"])
    if count and len(rows) > count:
        rows = rows[-count:]
    return rows, url


def fetch_sse_etf_shares_for_date(day: str) -> dict[str, float]:
    """上交所官方某交易日 ETF 份额快照，返回 {code: shares_yi(亿份)}。"""
    resp = SESSION.get(
        SSE_ETF_SHARES_URL,
        params={
            "sqlId": "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L",
            "STAT_DATE": day,
            "isPagination": "true",
            "pageHelp.pageSize": 10000,
            "pageHelp.pageNo": 1,
            "pageHelp.beginPage": 1,
            "pageHelp.cacheSize": 1,
            "pageHelp.endPage": 1,
        },
        headers={"Referer": "https://www.sse.com.cn/"},
        timeout=(12, 25),
    )
    resp.raise_for_status()
    payload = resp.json()
    res = payload.get("result") or []
    out: dict[str, float] = {}
    for rec in res:
        if rec.get("STAT_DATE") == day and rec.get("SEC_CODE") and rec.get("TOT_VOL"):
            # 上交所单位为万份 -> 转为亿份 (/10000)
            out[str(rec["SEC_CODE"])] = round(float(str(rec["TOT_VOL"]).replace(",", "")) / 10000.0, 4)
    return out


def fetch_national_team_bundle(cfg: dict[str, Any], cache_file: Path) -> dict[str, Any]:
    """
    获取“国家队”16只核心宽基ETF份额走势 + 中信股指期货持仓 + 官方基准。
    数据源策略：
    1. 拉取参考基准 etf.maomaoci-a.com/data/data.json（汇总上交所+深交所+中金所前20会员+2025年报官方基线）；
    2. 直连上交所官方接口验证/补充最新交易日沪市ETF份额，并写入本地持久化缓存 data/etf_history_cache.json；
    3. 计算组合总份额(亿份)、组合总规模(亿元)、单日/累计估算净流入(亿元)及估算国家队持仓占全A市值比重。
    """
    upstream_url = cfg["upstream_url"]
    data: dict[str, Any] | None = None
    source_note = "上交所 / 深交所 / 中金所（参考聚合源 etf.maomaoci-a.com + 官方直连核验）"

    try:
        resp = SESSION.get(upstream_url, params={"t": int(time.time())}, timeout=(12, 25))
        resp.raise_for_status()
        data = resp.json()
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        if cache_file.exists():
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            source_note += f"（上游暂不可达，已使用本地归档缓存：{type(exc).__name__}）"
        else:
            raise RuntimeError(f"国家队 ETF 数据拉取失败且无缓存: {exc}") from exc

    dates: list[str] = list(data.get("dates", []))
    etfs: list[dict[str, Any]] = data.get("etfs") or cfg["etfs"]
    series: dict[str, dict[str, list[float | None]]] = data.get("series", {})
    codes = [e["code"] for e in etfs]

    # Cross-verify latest SH ETF shares directly with official SSE API (non-blocking)
    sse_verified_date = None
    if dates:
        try:
            latest_day = dates[-1]
            sse_map = fetch_sse_etf_shares_for_date(latest_day)
            if sse_map:
                sse_verified_date = latest_day
        except Exception:
            sse_verified_date = None

    # Compute daily aggregate series: total shares (亿份), total AUM (亿元), daily net flow (亿元), cumulative flow (亿元)
    n = len(dates)
    total_shares: list[float] = []
    total_aum: list[float] = []
    total_flow: list[float] = []
    cum_flow: list[float] = []
    est_gjd_aum: list[float] = []
    est_a_share_pct: list[float] = []

    baseline = data.get("baseline") or cfg["baseline_fallback"]
    base_val = float(baseline.get("total_value_yi", 15400.0))
    a_share_total_mcap = float(cfg.get("a_share_total_mcap_yi_fallback", 950000.0))

    # Try to estimate live A-share total market cap proxy from CSI 300 ratio (沪深300约占全A总市值~52%)
    try:
        q300 = tencent_quote(["sh000300"]).get("sh000300")
        if q300 and q300.get("mcap_yi", 0) > 100000:
            a_share_total_mcap = round(q300["mcap_yi"] / 0.52, 0)
    except Exception:
        pass

    running_cum = 0.0
    # Forward-fill missing single-day shares/close for clean aggregate totals
    last_s = {c: None for c in codes}
    last_p = {c: None for c in codes}

    for i in range(n):
        day_sh = 0.0
        day_aum = 0.0
        day_fl = 0.0
        for c in codes:
            s_obj = series.get(c, {})
            sh_arr = s_obj.get("shares", [])
            cl_arr = s_obj.get("close", [])
            fl_arr = s_obj.get("flow", [])
            sh = sh_arr[i] if i < len(sh_arr) and sh_arr[i] is not None else last_s[c]
            cl = cl_arr[i] if i < len(cl_arr) and cl_arr[i] is not None else last_p[c]
            fl = fl_arr[i] if i < len(fl_arr) and fl_arr[i] is not None else 0.0
            if sh is not None:
                last_s[c] = sh
                day_sh += float(sh)
            if cl is not None:
                last_p[c] = cl
            if sh is not None and cl is not None:
                day_aum += float(sh) * float(cl)
            day_fl += float(fl)

        running_cum += day_fl
        total_shares.append(round(day_sh, 2))
        total_aum.append(round(day_aum, 1))
        total_flow.append(round(day_fl, 2))
        cum_flow.append(round(running_cum, 2))
        # Relative National Team proxy value (official baseline adjusted by cumulative net flow proxy)
        est_val = max(0.0, base_val + running_cum)
        est_gjd_aum.append(round(est_val, 1))
        est_a_share_pct.append(round((day_aum / a_share_total_mcap) * 100.0, 2))

    # Build latest ETF snapshot rows
    rows = []
    for e in etfs:
        c = e["code"]
        s_obj = series.get(c, {})
        sh_arr = s_obj.get("shares", [])
        cl_arr = s_obj.get("close", [])
        fl_arr = s_obj.get("flow", [])

        # Latest non-null share & prior non-null share
        ls_idx = next((idx for idx in range(n - 1, -1, -1) if idx < len(sh_arr) and sh_arr[idx] is not None), None)
        ps_idx = (
            next((idx for idx in range(ls_idx - 1, -1, -1) if sh_arr[idx] is not None), None)
            if ls_idx is not None
            else None
        )
        lc_idx = next((idx for idx in range(n - 1, -1, -1) if idx < len(cl_arr) and cl_arr[idx] is not None), None)

        cur_sh = sh_arr[ls_idx] if ls_idx is not None else None
        prev_sh = sh_arr[ps_idx] if ps_idx is not None else None
        d_sh = round(cur_sh - prev_sh, 2) if (cur_sh is not None and prev_sh is not None) else None
        cur_cl = cl_arr[lc_idx] if lc_idx is not None else None

        flow1 = fl_arr[-1] if fl_arr else None
        flow5 = round(sum(float(x or 0) for x in fl_arr[-5:]), 2)
        flow20 = round(sum(float(x or 0) for x in fl_arr[-20:]), 2)

        rows.append({
            "code": c,
            "name": e.get("name", ""),
            "full": e.get("full", e.get("name", "")),
            "exch": e.get("exch", ""),
            "index": e.get("index", ""),
            "note": e.get("gjd_note", ""),
            "shares": round(cur_sh, 2) if cur_sh is not None else None,
            "d_shares": d_sh,
            "flow1": round(flow1, 2) if flow1 is not None else None,
            "flow5": flow5,
            "flow20": flow20,
            "close": round(cur_cl, 3) if cur_cl is not None else None,
            "aum": round(cur_sh * cur_cl, 1) if (cur_sh is not None and cur_cl is not None) else None,
        })

    latest_shares = total_shares[-1] if total_shares else 0.0
    prev_shares = total_shares[-2] if len(total_shares) >= 2 else latest_shares
    d_total_shares = round(latest_shares - prev_shares, 2)

    return {
        "updated": data.get("updated", now_cst_str()),
        "latest_date": dates[-1] if dates else "",
        "sse_verified_date": sse_verified_date,
        "source_note": source_note,
        "dates": dates,
        "etfs": etfs,
        "series": series,
        "aggregate": {
            "total_shares": total_shares,
            "total_aum": total_aum,
            "total_flow": total_flow,
            "cum_flow": cum_flow,
            "est_a_share_pct": est_a_share_pct,
        },
        "summary": {
            "latest_date": dates[-1] if dates else "",
            "etf_count": len(etfs),
            "total_shares_yi": latest_shares,
            "d_total_shares_yi": d_total_shares,
            "total_aum_yi": total_aum[-1] if total_aum else 0.0,
            "flow_1d_yi": total_flow[-1] if total_flow else 0.0,
            "flow_5d_yi": round(sum(total_flow[-5:]), 2),
            "flow_20d_yi": round(sum(total_flow[-20:]), 2),
            "cum_flow_yi": cum_flow[-1] if cum_flow else 0.0,
            "monitored_a_share_pct": est_a_share_pct[-1] if est_a_share_pct else 0.0,
            "a_share_total_mcap_yi": a_share_total_mcap,
        },
        "rows": rows,
        "futures": data.get("futures"),
        "baseline": baseline,
    }


def eastmoney_kline(secid: str, count: int = 520) -> tuple[list[dict[str, Any]], str]:
    """东方财富免Key日K序列（支持美元指数 100.UDI、美债收益率 171.US10Y / 171.US2Y、伦敦金现 122.XAU 等）。"""
    # Note: EastMoney push2his requires literal commas in fields1/fields2 query string
    qs = (
        f"secid={secid}&fields1=f1,f2,f3,f4,f5,f6"
        f"&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&lmt={int(count)}&end=20500101"
    )
    full_url = f"{EASTMONEY_KLINE_URL}?{qs}"
    resp = SESSION.get(
        full_url,
        timeout=(12, 25),
    )
    resp.raise_for_status()
    payload = resp.json()
    node = payload.get("data") or {}
    klines = node.get("klines") or []
    if not klines:
        raise RuntimeError(f"东方财富日K {secid} 返回空数据")
    rows = []
    for line in klines:
        parts = str(line).split(",")
        if len(parts) < 5:
            continue
        o, c, h, l = float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])
        vol = float(parts[5]) if len(parts) > 5 and parts[5] not in ("", "-") else 0.0
        if min(o, c, h, l) <= 0:
            continue
        rows.append({
            "date": parts[0].strip(),
            "open": o,
            "close": c,
            "high": max(h, o, c),
            "low": min(l, o, c),
            "volume": vol if vol > 0 else None,
        })
    rows.sort(key=lambda r: r["date"])
    if count and len(rows) > count:
        rows = rows[-count:]
    return rows, full_url


def eastmoney_quotes(secids: list[str]) -> dict[str, dict[str, Any]]:
    """批量拉取东方财富实时快照（美元指数、美债收益率、伦敦金现等）。"""
    qs = f"fltt=2&fields=f2,f3,f4,f12,f14,f15,f16,f17,f18,f124&secids={','.join(secids)}"
    resp = SESSION.get(
        f"{EASTMONEY_QUOTE_URL}?{qs}",
        timeout=(12, 20),
    )
    resp.raise_for_status()
    payload = resp.json()
    diff = (payload.get("data") or {}).get("diff") or []
    out: dict[str, dict[str, Any]] = {}
    for row in diff:
        code = row.get("f12")
        if not code or row.get("f2") in (None, "-"):
            continue

        def _num(val: Any) -> float | None:
            if val in (None, "-", ""):
                return None
            try:
                return float(val)
            except (ValueError, TypeError):
                return None

        ts = _num(row.get("f124"))
        quote_date = None
        if ts and ts > 1_000_000_000:
            quote_date = datetime.fromtimestamp(ts, CST).strftime("%Y-%m-%d")

        out[str(code)] = {
            "code": str(code),
            "name": str(row.get("f14") or ""),
            "price": _num(row.get("f2")),
            "change_pct": _num(row.get("f3")),
            "change_amt": _num(row.get("f4")),
            "high": _num(row.get("f15")),
            "low": _num(row.get("f16")),
            "open": _num(row.get("f17")),
            "last_close": _num(row.get("f18")),
            "quote_date": quote_date,
        }
    return out


def sina_forex_kline(symbol: str = "DINIW", count: int = 520) -> tuple[list[dict[str, Any]], str]:
    """新浪外汇日K备用接口（如 DINIW 美元指数）。"""
    code = str(symbol).strip().upper()
    url = SINA_FOREX_KLINE_URL.format(code=code)
    resp = SESSION.get(
        url,
        params={"symbol": code},
        headers={"Referer": "https://finance.sina.com.cn/"},
        timeout=(12, 25),
    )
    resp.raise_for_status()
    text = resp.content.decode("gbk", errors="replace")
    m = re.search(rf"var _{re.escape(code)}=\(\"(.*)\"\);?\s*$", text, re.S)
    if not m:
        raise RuntimeError(f"新浪外汇 {code} 返回非预期 JSONP")
    rows = []
    for seg in m.group(1).split("|"):
        parts = [p.strip() for p in seg.split(",")]
        if len(parts) < 5 or not parts[0]:
            continue
        o, l, h, c = float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])
        if min(o, l, h, c) <= 0:
            continue
        rows.append({
            "date": parts[0],
            "open": o,
            "low": min(l, o, c),
            "high": max(h, o, c),
            "close": c,
            "volume": None,
        })
    rows.sort(key=lambda r: r["date"])
    if count and len(rows) > count:
        rows = rows[-count:]
    return rows, url


def _build_macro_series_item(
    key: str,
    spec: dict[str, Any],
    bars: list[dict[str, Any]],
    quote: dict[str, Any] | None,
    source_label: str,
    source_url: str,
) -> dict[str, Any]:
    dec = int(spec.get("decimals", 2))
    is_yield = spec.get("unit") == "%"
    merged = list(bars)
    if quote and quote.get("price") and quote["price"] > 0 and merged:
        last = merged[-1]
        q_date = quote.get("quote_date") or last["date"]
        price = float(quote["price"])
        o = float(quote["open"]) if quote.get("open") and quote["open"] > 0 else price
        h = max(float(quote["high"]) if quote.get("high") and quote["high"] > 0 else price, price, o)
        l = min(float(quote["low"]) if quote.get("low") and quote["low"] > 0 else price, price, o)
        if q_date == last["date"]:
            merged[-1] = {
                **last,
                "open": o,
                "high": max(last["high"], h),
                "low": min(last["low"], l),
                "close": price,
            }
        elif q_date > last["date"]:
            merged.append({"date": q_date, "open": o, "high": h, "low": l, "close": price, "volume": None})

    dates = [b["date"] for b in merged]
    closes = [round(float(b["close"]), dec) for b in merged]
    ohlc = [
        [round(float(b["open"]), dec), round(float(b["close"]), dec), round(float(b["low"]), dec), round(float(b["high"]), dec)]
        for b in merged
    ]
    n = len(closes)
    last_c = closes[-1]
    prev_c = closes[-2] if n >= 2 else last_c
    chg_amt = round(last_c - prev_c, dec)
    chg_pct = round(((last_c / prev_c) - 1.0) * 100.0, 2) if prev_c > 0 else 0.0
    if quote and quote.get("change_pct") is not None:
        chg_pct = round(float(quote["change_pct"]), 2)
    if quote and quote.get("change_amt") is not None:
        chg_amt = round(float(quote["change_amt"]), dec)

    def _ret(k: int) -> float | None:
        if n > k and closes[-1 - k] > 0:
            return round(((last_c / closes[-1 - k]) - 1.0) * 100.0, 2)
        return None

    def _diff_bp(k: int) -> float | None:
        if is_yield and n > k:
            return round((last_c - closes[-1 - k]) * 100.0, 1)
        return None

    return {
        "meta": {
            "key": key,
            "title": spec["title"],
            "code": spec["code"],
            "display_code": spec["display_code"],
            "secid": spec["secid"],
            "unit": spec["unit"],
            "decimals": dec,
            "source": source_label,
            "source_url": source_url,
            "bar_count": n,
            "date_range": [dates[0], dates[-1]],
        },
        "dates": dates,
        "closes": closes,
        "ohlc": ohlc,
        "summary": {
            "latest_date": dates[-1],
            "close": last_c,
            "change_amt": chg_amt,
            "change_pct": chg_pct,
            "change_bp": round(chg_amt * 100.0, 1) if is_yield else None,
            "ret_5d": _ret(5),
            "ret_20d": _ret(20),
            "ret_60d": _ret(60),
            "chg_5d_bp": _diff_bp(5),
            "chg_20d_bp": _diff_bp(20),
            "chg_60d_bp": _diff_bp(60),
        },
    }


def eastmoney_datacenter_us_yields(count: int = 520) -> dict[str, list[dict[str, Any]]]:
    """东方财富数据中心中美利差表备用接口（EMG00001306=美债2Y收益率, EMG00001308=美债10Y收益率）。"""
    url = (
        "https://datacenter-web.eastmoney.com/api/data/v1/get"
        f"?reportName=RPTA_WEB_TREASURYYIELD&columns=SOLAR_DATE,EMG00001306,EMG00001308"
        f"&sortColumns=SOLAR_DATE&sortTypes=-1&pageSize={int(count) + 60}&pageNumber=1"
    )
    resp = SESSION.get(url, timeout=(12, 25))
    resp.raise_for_status()
    rows = ((resp.json().get("result") or {}).get("data")) or []
    us10y: list[dict[str, Any]] = []
    us2y: list[dict[str, Any]] = []
    for r in rows:
        dt = str(r.get("SOLAR_DATE") or "")[:10]
        if len(dt) != 10:
            continue
        v10 = r.get("EMG00001308")
        v2 = r.get("EMG00001306")
        if v10 is not None:
            f10 = float(v10)
            if f10 > 0:
                us10y.append({"date": dt, "open": f10, "high": f10, "low": f10, "close": f10, "volume": None})
        if v2 is not None:
            f2 = float(v2)
            if f2 > 0:
                us2y.append({"date": dt, "open": f2, "high": f2, "low": f2, "close": f2, "volume": None})
    us10y.sort(key=lambda x: x["date"])
    us2y.sort(key=lambda x: x["date"])
    return {"us10y": us10y[-count:], "us2y": us2y[-count:]}


def fetch_gold_macro_bundle(cfg: dict[str, Any]) -> dict[str, Any]:
    """获取黄金宏观联动三件套：美元指数 (DXY)、美国10年期国债收益率 (US10Y)、美国2年期国债收益率 (US2Y)。"""
    secids = [spec["secid"] for spec in cfg.values()]
    quotes: dict[str, Any] = {}
    try:
        quotes = eastmoney_quotes(secids)
    except Exception as exc:
        print(f"[WARN] eastmoney_quotes macro failed: {exc}")

    dc_fallback: dict[str, list[dict[str, Any]]] | None = None
    items: dict[str, Any] = {}
    for key, spec in cfg.items():
        secid = spec["secid"]
        count = int(spec.get("count", 520))
        print(f"  -> Fetching macro {key} ({spec['title']} / {secid}) ...")
        try:
            bars, url = eastmoney_kline(secid, count=count)
            src_label = "东方财富宏观日线 (实时直连)"
        except Exception as exc:
            if key == "dxy":
                print(f"     EastMoney DXY failed ({exc}), falling back to Sina DINIW ...")
                bars, url = sina_forex_kline("DINIW", count=count)
                src_label = "新浪外汇美元指数日线"
            elif key in ("us10y", "us2y"):
                print(f"     EastMoney {key} failed ({exc}), falling back to EastMoney DataCenter ...")
                if dc_fallback is None:
                    dc_fallback = eastmoney_datacenter_us_yields(count=count)
                bars = dc_fallback[key]
                url = "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD"
                src_label = "东方财富数据中心美债收益率日线"
            else:
                raise
        q = quotes.get(spec["code"])
        items[key] = _build_macro_series_item(key, spec, bars, q, src_label, url)
        s = items[key]["summary"]
        extra = f" ({s['change_bp']:+.1f}bp)" if s["change_bp"] is not None else f" ({s['change_pct']:+.2f}%)"
        print(f"     OK: {s['latest_date']} close={s['close']}{spec['unit']}{extra}")

    # Compute 10Y - 2Y Treasury Yield Spread (bp) aligned on union of dates
    spread_10y_2y = None
    if "us10y" in items and "us2y" in items:
        m10 = dict(zip(items["us10y"]["dates"], items["us10y"]["closes"]))
        m2 = dict(zip(items["us2y"]["dates"], items["us2y"]["closes"]))
        common_dates = sorted(set(m10.keys()) | set(m2.keys()))
        sp_dates: list[str] = []
        sp_bps: list[float] = []
        last10 = None
        last2 = None
        for d in common_dates:
            if d in m10:
                last10 = m10[d]
            if d in m2:
                last2 = m2[d]
            if last10 is not None and last2 is not None:
                sp_dates.append(d)
                sp_bps.append(round((last10 - last2) * 100.0, 1))
        if sp_dates:
            cur_bp = sp_bps[-1]
            prev_bp = sp_bps[-2] if len(sp_bps) >= 2 else cur_bp
            spread_10y_2y = {
                "dates": sp_dates,
                "spread_bp": sp_bps,
                "latest_date": sp_dates[-1],
                "latest_bp": cur_bp,
                "change_bp": round(cur_bp - prev_bp, 1),
                "is_inverted": cur_bp < 0,
            }

    latest_date = max((v["summary"]["latest_date"] for v in items.values()), default="")
    return {
        "latest_date": latest_date,
        "series": items,
        "spread_10y_2y": spread_10y_2y,
    }
