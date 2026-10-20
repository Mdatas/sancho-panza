#!/usr/bin/env python3
"""
Fetch the in-game map icons for the maps that have a profile (data/knowledge/maps/*.md) and store small
copies in data/img/Maps/<key>.webp, plus SOURCES.json (where each file came from).

Source: Liquipedia Age of Empires wiki (MediaWiki API), files named "<Map>_AoE2DE.png" ("In game map icon",
copyright Microsoft; usable in non-profit fan projects under Microsoft's Game Content Usage Rules).
The script respects Liquipedia's API terms: descriptive User-Agent, gzip, one request every 2 seconds.

Run by .github/workflows/map-images.yml (GitHub's runners have open internet) or locally:
    python3 tools/fetch_map_images.py
"""
import io
import json
import os
import re
import sys
import time
from pathlib import Path

import requests
from PIL import Image, features

ROOT = Path(__file__).resolve().parents[1]
MAPS_DIR = ROOT / "data" / "knowledge" / "maps"
OUT_DIR = ROOT / "data" / "img" / "Maps"
API = "https://liquipedia.net/ageofempires/api.php"
UA = "SanchoPanzaFanCompanion/1.0 (https://github.com/Mdatas/sancho-panza; non-commercial fan tool; map icons)"
HEADERS = {"User-Agent": UA, "Accept-Encoding": "gzip"}
DELAY = 2.1  # seconds between requests (Liquipedia asks for >= 2 s)
SIZE = 256   # px, longest side


def key(s: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def read_maps():
    """[(name, [aliases])] from the frontmatter of each map profile."""
    out = []
    for f in sorted(MAPS_DIR.glob("*.md")):
        text = f.read_text(encoding="utf8")
        m = re.match(r"^---\n(.*?)\n---", text, re.S)
        name, aliases = f.stem, []
        if m:
            for line in m.group(1).splitlines():
                k, _, v = line.partition(":")
                k, v = k.strip(), v.strip()
                if k == "map" and v:
                    name = v.strip("'\"")
                elif k == "aliases":
                    aliases = [a.strip().strip("'\"") for a in v.strip("[]").split(",") if a.strip()]
        out.append((name, aliases))
    return out


def get(url, **params):
    time.sleep(DELAY)
    r = requests.get(url, params=params or None, headers=HEADERS, timeout=60)
    r.raise_for_status()
    return r


def chunks(xs, n):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def resolve_icons(maps):
    """{map name: (file title, url)} using the images embedded in each map's wiki page (files live in Liquipedia Commons,
    so list=allimages on the game wiki does not see them; prop=images + prop=imageinfo does)."""
    pat = re.compile(r"^File:(.+?)[ _]AoE2DE\.(png|jpg|jpeg|webp)$", re.I)  # the API returns titles with spaces
    chosen = {}
    names = [n for n, _ in maps]
    for group in chunks(names, 40):
        j = get(API, action="query", titles="|".join(group), prop="images", imlimit="500", redirects="1", format="json").json()
        q = j.get("query", {})
        # map the title we asked for -> the title the wiki answered with (normalized / redirected)
        back = {}
        for n in q.get("normalized", []) + q.get("redirects", []):
            back[n["to"]] = back.get(n["from"], n["from"])
        for page in q.get("pages", {}).values():
            title = page.get("title", "")
            asked = back.get(title, title)
            if "missing" in page:
                continue
            cands = [im["title"] for im in page.get("images", []) if pat.match(im["title"])]
            if not cands:
                continue
            exact = [c for c in cands if key(pat.match(c).group(1)) == key(asked) or key(pat.match(c).group(1)) == key(title)]
            pick = exact[0] if exact else (cands[0] if len(cands) == 1 else None)
            if pick:
                chosen[asked] = pick
    print(f"pages with an AoE2DE icon: {len(chosen)} of {len(names)}", file=sys.stderr)
    urls = {}
    for group in chunks(sorted(set(chosen.values())), 40):
        j = get(API, action="query", titles="|".join(group), prop="imageinfo", iiprop="url", format="json").json()
        for page in j.get("query", {}).get("pages", {}).values():
            ii = page.get("imageinfo") or []
            if ii and ii[0].get("url"):
                urls[page["title"]] = ii[0]["url"]
    return {m: (f.replace("File:", ""), urls[f]) for m, f in chosen.items() if f in urls}


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    maps = read_maps()
    icons = resolve_icons(maps)
    webp = features.check("webp")
    ext = "webp" if webp else "png"
    sources = {}
    if (OUT_DIR / "SOURCES.json").exists():
        try:
            sources = json.loads((OUT_DIR / "SOURCES.json").read_text(encoding="utf8"))
        except Exception:
            sources = {}
    missing, done = [], 0
    for name, aliases in maps:
        k = key(name)
        hit = icons.get(name)
        if not hit:
            missing.append(name)
            continue
        out = OUT_DIR / f"{k}.{ext}"
        if out.exists() and sources.get(k, {}).get("file") == hit[0]:
            done += 1
            continue
        try:
            data = get(hit[1]).content
            im = Image.open(io.BytesIO(data))
            im = im.convert("RGBA") if im.mode in ("P", "LA", "RGBA") else im.convert("RGB")
            im.thumbnail((SIZE, SIZE), Image.LANCZOS)
            if ext == "webp":
                im.save(out, "WEBP", quality=82, method=6)
            else:
                im.save(out, "PNG", optimize=True)
            sources[k] = {"map": name, "file": hit[0], "source": f"https://liquipedia.net/ageofempires/File:{hit[0]}", "copyright": "Microsoft Corporation (in-game map icon)"}
            done += 1
            print(f"ok  {name} <- {hit[0]}", file=sys.stderr)
        except Exception as e:  # keep going; report at the end
            print(f"ERR {name}: {e}", file=sys.stderr)
            missing.append(name)
    (OUT_DIR / "SOURCES.json").write_text(json.dumps(sources, ensure_ascii=False, indent=1), encoding="utf8")
    print(f"\n{done} map icons saved to {OUT_DIR.relative_to(ROOT)}; {len(missing)} without icon:", file=sys.stderr)
    for n in missing:
        print("  -", n, file=sys.stderr)
    (OUT_DIR / "MISSING.txt").write_text("\n".join(missing) + ("\n" if missing else ""), encoding="utf8")
    (OUT_DIR / "REPORT.txt").write_text(f"maps: {len(maps)}\nicons resolved: {len(icons)}\nsaved: {done}\nmissing: {len(missing)}\nsample resolved: {list(icons.items())[:5]}\n", encoding="utf8")


if __name__ == "__main__":
    main()
