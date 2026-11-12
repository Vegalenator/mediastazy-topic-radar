"""Validate the public catalog and collected snapshot before Pages deployment."""
import json
from pathlib import Path

from collect import canonical, date

site = Path("site")
catalog = json.loads((site / "data/topics.json").read_text(encoding="utf-8"))
snapshot = json.loads((site / "data/signals.json").read_text(encoding="utf-8"))
assert catalog["version"] == 3
for group in ("topics", "shorts"):
    ids = set()
    for row in catalog[group]:
        assert row["id"] not in ids and row["title"].strip()
        ids.add(row["id"])
        assert len(row["scores"]) == (5 if group == "topics" else 4)
        assert all(canonical(source["url"]) for source in row.get("sources", []))

assert snapshot["version"] == 1 and date(snapshot["generatedAt"])
assert set(snapshot["signals"]) == {"news", "research", "trends", "videos"}
assert any(source["status"] == "ok" for source in snapshot["sources"]), "Все источники недоступны"
beats = {beat["id"] for beat in snapshot["beats"]}
for kind, items in snapshot["signals"].items():
    assert len({item["id"] for item in items}) == len(items)
    for item in items:
        assert item["kind"] == kind and item["title"] and canonical(item["url"])
        assert date(item["publishedAt"]) and set(item["beats"]) <= beats
        if kind == "videos":
            assert date(item["observedAt"]) and isinstance(item["views"], int) and item["views"] >= 0

print("Проверено:", {k: len(catalog[k]) for k in ("topics", "shorts")},
      {k: len(v) for k, v in snapshot["signals"].items()})
