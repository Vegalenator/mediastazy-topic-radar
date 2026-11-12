"""Collect public signals and publish an atomic static snapshot."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
import hashlib
import html
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


CONFIG = json.loads(Path(__file__).with_name("sources.json").read_text(encoding="utf-8"))
LIMITS = {"news": 10, "trends": 3, "videos": 30, "research": 100}
BEATS = [(beat, re.compile(beat["pattern"], re.I)) for beat in CONFIG["beats"]]
MAX_BYTES = 2_000_000
VIDEO_WINDOW = 30


def stamp(value):
    return value.astimezone(UTC).isoformat(timespec="seconds")


def date(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
        except (ValueError, TypeError):
            return None
    return parsed.replace(tzinfo=parsed.tzinfo or UTC).astimezone(UTC)


def plain(value, limit=500):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", value or "")).split())[:limit]


def canonical(value):
    if not value:
        return None
    try:
        u = urlsplit(value.strip())
        if u.scheme not in {"http", "https"} or not u.hostname or u.username or u.password:
            return None
        query = [(k, v) for k, v in parse_qsl(u.query) if not k.lower().startswith("utm_")
                 and k.lower() not in {"fbclid", "gclid", "mc_cid", "mc_eid"}]
        return urlunsplit((u.scheme, u.netloc.lower(), u.path, urlencode(query), ""))
    except ValueError:
        return None


def request(url):
    for attempt in range(2):
        try:
            with urlopen(Request(url, headers={
                "User-Agent": "MediastazyTopicRadar/3.0 (public RSS and metadata)",
            }), timeout=12) as response:
                body = response.read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES:
                    raise ValueError("Размер ответа выше допустимого")
                return body
        except HTTPError as error:
            if error.code not in {408, 429, 500, 502, 503, 504} or attempt:
                raise
        except (TimeoutError, URLError):
            if attempt:
                raise
        time.sleep(1)


def local_tag(node):
    return node.tag.rsplit("}", 1)[-1]


def child(node, *names):
    return next((n for n in node if local_tag(n) in names), None)


def val(node, *names):
    result = child(node, *names)
    return "".join(result.itertext()).strip() if result is not None else ""


def beat_ids(title, description=""):
    return [beat["id"] for beat, pattern in BEATS if pattern.search(title + " " + description)]


def make_signal(kind, title, url, published, source, tags, **details):
    link = canonical(url)
    title = plain(title, 300)
    if not title or not link or not published:
        return None
    id_hash = hashlib.sha256(link.encode()).hexdigest()[:20]
    return {"id": f"{kind}-{id_hash}", "kind": kind, "title": title, "url": link,
            "publishedAt": stamp(published), "source": source, "beats": tags, **details}


def parse_feed(body, job, now):
    if re.search(br"<!\s*(?:doctype|entity)\b", body, re.I):
        raise ValueError("Неожиданное объявление XML")
    root = ET.fromstring(body)
    if local_tag(root) not in {"rss", "feed", "RDF"}:
        raise ValueError("Формат ленты не распознан")
    kind, _, source, _, extra = job
    records = []
    for entry in root.iter():
        if local_tag(entry) not in {"item", "entry"}:
            continue
        title = plain(val(entry, "title"), 300)
        description = plain(val(entry, "description", "summary"), 1200)
        published = date(val(entry, "pubDate", "published", "date") or val(entry, "updated"))
        link_node = next((n for n in entry if local_tag(n) == "link"
                          and n.get("rel", "alternate") == "alternate"), None)
        link = (link_node.get("href") or link_node.text) if link_node is not None else ""
        details = {}
        tags = beat_ids(title, description[:500]) if kind == "news" else beat_ids(title)
        if kind == "trends":
            link = "https://trends.google.com/trending?" + urlencode({"geo": extra, "q": title})
            details = {"geo": extra, "traffic": plain(val(entry, "approx_traffic"), 50)}
            related_titles = " ".join(val(item, "news_item_title") for item in entry
                                      if local_tag(item) == "news_item")
            tags = beat_ids(title, related_titles)
        if kind == "videos":
            group = child(entry, "group")
            community = child(group, "community") if group is not None else None
            stats = child(community, "statistics") if community is not None else None
            views = stats.get("views", "") if stats is not None else ""
            video_id = val(entry, "videoId")
            if not views.isdecimal() or not re.fullmatch(r"[\w-]{11}", video_id):
                continue
            link = "https://www.youtube.com/watch?v=" + video_id
            tags = beat_ids(title, plain(val(group, "description"), 220))
            details = {"views": int(views), "observedAt": stamp(now),
                       "short": "/shorts/" in (link_node.get("href") or "") if link_node is not None else False}
        if not tags and kind == "news":
            continue
        item = make_signal(kind, title, link, published, source, tags, **details)
        if item and fresh(item, now):
            records.append(item)
    return records


def parse_crossref(body, job, now):
    result = json.loads(body)["message"]
    records = []
    for item in result["items"]:
        titles = item.get("title") or []
        parts = item.get("published", {}).get("date-parts", [[]])[0]
        if not titles or len(parts) < 3 or not item.get("DOI"):
            continue
        published = date(f"{parts[0]:04d}-{parts[1]:02d}-{parts[2]:02d}")
        title = plain(titles[0], 300)
        tags = beat_ids(title)
        journal = plain(next(iter(item.get("container-title") or []), ""), 180)
        signal = make_signal("research", title, "https://doi.org/" + quote(item["DOI"].lower(), safe="/"),
                             published, journal or "Crossref", tags,
                             subtype=item.get("type", ""), doi=item["DOI"])
        if signal and fresh(signal, now) and len(title) > 15:
            records.append(signal)
    return records


def fresh(item, now):
    published = date(item.get("publishedAt"))
    if not published or not now - timedelta(days=LIMITS[item["kind"]]) <= published <= now + timedelta(hours=12):
        return False
    if item["kind"] != "videos":
        return True
    observed = date(item.get("observedAt"))
    return bool(observed and observed >= now - timedelta(days=2))


def jobs(now):
    result = [("news", id_, label, url, "") for id_, label, url in CONFIG["news"]]
    result += [("trends", geo, f"Google Trends · {label}",
                f"https://trends.google.com/trending/rss?geo={geo}", geo)
               for geo, label in CONFIG["trends"]]
    from_date = (now - timedelta(days=LIMITS["research"])).date().isoformat()
    result += [("research", id_, f"Crossref · {label}", "https://api.crossref.org/works?" + urlencode({
        "query.bibliographic": query,
        "filter": f"from-pub-date:{from_date},until-pub-date:{now.date()},type:journal-article",
        "rows": 22,
        "select": "DOI,title,published,container-title,type",
    }), "") for id_, label, query in CONFIG["research"]]
    result += [("videos", id_, label, f"https://www.youtube.com/feeds/videos.xml?channel_id={id_}", "")
               for id_, label in CONFIG["videos"]]
    return result


def fetch(job, previous, now):
    kind, id_, label, url, _ = job
    key = kind + ":" + id_
    state = {"id": key, "kind": kind, "label": label, "url": url, "checkedAt": stamp(now)}
    prior = previous.get(key, {})
    retained = [item for item in prior.get("items", []) if fresh(item, now)]
    try:
        body = request(url)
        parse = parse_crossref if kind == "research" else parse_feed
        items = parse(body, job, now)
    except (OSError, ValueError, KeyError, TypeError, ET.ParseError) as error:
        state.update(status="stale" if retained else "error",
                     lastSuccessAt=prior.get("lastSuccessAt"),
                     message=f"HTTP {error.code}" if isinstance(error, HTTPError) else "Ответ недоступен или не распознан",
                     items=retained)
    else:
        # News can roll off a short feed between runs. Video statistics must be current.
        saved = retained if kind == "news" else []
        by_id = {item["id"]: item for item in saved + items}
        state.update(status="ok", lastSuccessAt=stamp(now),
                     items=sorted(by_id.values(), key=lambda item: item["publishedAt"], reverse=True)[:120])
    print(f"{key}: {state['status']} ({len(state['items'])})", flush=True)
    return state


def dedupe(records):
    by_id = {}
    for item in records:
        current = by_id.get(item["id"])
        if current is None or item["publishedAt"] >= current["publishedAt"]:
            by_id[item["id"]] = item
    return list(by_id.values())


def build_snapshot(states, now):
    groups = {}
    for kind, limit in {"news": 110, "trends": 55, "research": 60, "videos": 36}.items():
        records = dedupe(item for source in states if source["kind"] == kind for item in source["items"])
        if kind == "videos":
            relevant = [item for item in records if item["beats"]]
            if relevant:
                records = relevant
            records.sort(key=lambda item: (item["views"], item["publishedAt"]), reverse=True)
        elif kind == "trends":
            records.sort(key=lambda item: (bool(item["beats"]), item["publishedAt"]), reverse=True)
        else:
            records.sort(key=lambda item: (bool(item["beats"]), item["publishedAt"]), reverse=True)
        groups[kind] = records[:limit]
    summaries = [{k: v for k, v in state.items() if k != "items"} | {"count": len(state["items"])}
                 for state in states]
    return {"version": 1, "generatedAt": stamp(now), "videoWindowDays": VIDEO_WINDOW,
            "beats": [{k: v for k, v in beat.items() if k != "pattern"} for beat, _ in BEATS],
            "sources": summaries, "signals": groups}


def load(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("site/data/signals.json"))
    parser.add_argument("--state", type=Path, default=Path(".radar-cache/sources.json"))
    args = parser.parse_args()
    now = datetime.now(UTC)
    previous = load(args.state, {})
    with ThreadPoolExecutor(max_workers=8) as pool:
        states = list(pool.map(lambda job: fetch(job, previous, now), jobs(now)))
    write(args.state, {source["id"]: source for source in states})
    write(args.output, build_snapshot(states, now))
    print("Signals:", {kind: len(items) for kind, items in load(args.output, {})["signals"].items()})


if __name__ == "__main__":
    main()
