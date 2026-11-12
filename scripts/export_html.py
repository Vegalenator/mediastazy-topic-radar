"""Produce a portable copy of the static site with the latest data embedded."""
import argparse
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
args = parser.parse_args()
site = Path(__file__).resolve().parent.parent / "site"
page = (site / "index.html").read_text(encoding="utf-8")
style = (site / "style.css").read_text(encoding="utf-8")
script = (site / "app.js").read_text(encoding="utf-8")
payloads = []
for kind in ("topics", "signals"):
    data = (site / "data" / (kind + ".json")).read_text(encoding="utf-8")
    payloads.append(f'<script id="{kind}-data" type="application/json">{data.replace("<", chr(92) + "u003c")}</script>')
page = page.replace('<link rel="stylesheet" href="./style.css">', "<style>\n" + style + "\n</style>")
page = page.replace('<script defer src="./app.js"></script>', "")
page = page.replace("</body>", "\n".join(payloads) + "\n<script>\n" + script + "\n</script>\n</body>")
args.output.write_text(page, encoding="utf-8")
