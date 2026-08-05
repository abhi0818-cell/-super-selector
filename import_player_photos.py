#!/usr/bin/env python3
"""
Super Selector — CPL 2026 player photo import pipeline
========================================================

Reads cpl_2026_player_photos.json, and for every player with a resolved
Cricinfo photo:

  1. Downloads the photo from Cricinfo's CDN (a face-cropped, larger-than-
     final-size version, so background removal has clean detail to work
     with — mirrors the lesson learned prototyping this: low source
     resolution produces jagged/artifacted edges after bg removal).
  2. Runs it through rembg (u2net model) to strip the background to
     transparent PNG.
  3. Crops to the subject's bounding box (from the alpha channel), pads it
     back out to a square, and resizes to a consistent final size.
  4. Uploads the transparent PNG to a Supabase Storage bucket.
  5. Writes a CSV (name, cricinfo_id, photo_url) mapping each player to
     their final Storage URL, for the admin "Manage Players" CSV import
     (NOTE: that import currently only accepts id,name,team,role,credits,
     overseas — it will need a small extension to also accept photo_url
     before this CSV can be imported as-is; see admin.js buildCsvRows()).

Run this LOCALLY (or anywhere with real internet access) — it will not
run inside a network-restricted sandbox, since it needs to reach both
Cricinfo's CDN and GitHub (for rembg's one-time model download) and your
Supabase project.

Setup
-----
    pip install rembg pillow numpy requests supabase scipy onnxruntime

    export SUPABASE_URL="https://<your-project-ref>.supabase.co"
    export SUPABASE_SERVICE_ROLE_KEY="<service role key, NOT the anon key>"
    export SUPABASE_BUCKET="player-photos"   # optional, defaults below

    Create the bucket once in the Supabase dashboard (Storage → New
    bucket), name it to match SUPABASE_BUCKET, and mark it Public (so the
    stored photo_url is directly usable by the app without signed URLs).

Usage
-----
    python3 import_player_photos.py                 # run on all "ok" players
    python3 import_player_photos.py --limit 3        # smoke-test on 3 players
    python3 import_player_photos.py --dry-run         # skip Supabase upload,
                                                        # just write local PNGs
                                                        # + CSV with local paths
    python3 import_player_photos.py --force 230558,604302
                                                        # re-fetch + reprocess
                                                        # these cricinfo_ids
                                                        # even if already cached
                                                        # (e.g. after re-sourcing
                                                        # an updated photo_url
                                                        # for someone already
                                                        # marked "ok")
"""

import argparse
import io
import json
import os
import re
import sys
import time
import unicodedata

import numpy as np
import requests
from PIL import Image
from scipy.ndimage import uniform_filter1d

INPUT_JSON = "cpl_2026_player_photos.json"
OUTPUT_DIR = "photo_import_output"
CSV_PATH = os.path.join(OUTPUT_DIR, "player_photos_import.csv")
FINAL_SIZE = 320          # final square canvas size, px
FETCH_SIZE = 400          # CDN fetch size — bigger than final so bg removal has detail
PADDING_FRAC = 0.12       # padding around the subject's bbox, as a fraction of final size
REQUEST_DELAY_S = 0.5     # be polite to Cricinfo's CDN between downloads


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or "player"


def cdn_fetch_url(raw_photo_url: str, size: int) -> str:
    """Insert a w_/h_/c_fill,g_face transform into a raw Cricinfo CDN URL."""
    return raw_photo_url.replace(
        "/image/upload/f_auto/",
        f"/image/upload/f_auto,w_{size},h_{size},c_fill,g_face/",
    )


def download_image(url: str) -> Image.Image:
    resp = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content)).convert("RGBA")


def remove_background(img: Image.Image) -> Image.Image:
    from rembg import remove  # imported lazily so --help works without the model
    result = remove(img)
    if result.mode != "RGBA":
        result = result.convert("RGBA")
    return result


def crop_to_head_and_neck(
    img: Image.Image,
    search_start_frac: float = 0.45,
    search_end_frac: float = 0.85,
    margin_rows: int = 22,
) -> Image.Image:
    """Cut off everything below the neck (shoulders, shirt collar, etc.) so
    the photo composites cleanly onto the jersey's collar instead of
    showing the player's real shirt underneath.

    Uses the alpha mask's row-width profile, restricted to the lower-middle
    band of the foreground bbox (well past hair and eyes, before shoulders
    would already have flared past that band in a typical Cricinfo
    w_400,h_400,c_fill,g_face headshot crop) and takes the narrowest point
    in that band as the neck.

    (First attempt scanned from the very top of the head looking for the
    first "narrowing" -- but curly/textured hair creates lots of small width
    dips that look like a neck long before the real one, cutting off the
    whole face. Restricting the search window to where the neck actually
    lives avoids that entirely.)
    """
    alpha = np.array(img.split()[3])
    fg = alpha > 128
    row_widths = fg.sum(axis=1).astype(float)
    nonzero = np.where(row_widths > 0)[0]
    if len(nonzero) == 0:
        return img
    top, bottom = int(nonzero.min()), int(nonzero.max())
    height = bottom - top

    band_start = top + int(height * search_start_frac)
    band_end = top + int(height * search_end_frac)
    band = row_widths[band_start:band_end]
    if len(band) < 5:
        return img

    smoothed = uniform_filter1d(band, size=max(3, len(band) // 15))
    neck_idx = int(np.argmin(smoothed))
    cutoff = min(band_start + neck_idx + margin_rows, bottom)

    new_alpha = alpha.copy()
    new_alpha[cutoff:, :] = 0
    out = img.copy()
    out.putalpha(Image.fromarray(new_alpha))
    return out


def crop_pad_resize(img: Image.Image, final_size: int, padding_frac: float) -> Image.Image:
    """Crop to the subject's alpha bbox, add padding, and letterbox to a square."""
    alpha = np.array(img.split()[3])
    ys, xs = np.where(alpha > 20)
    if len(xs) == 0:
        # nothing detected as foreground — bail out to a plain center-crop
        bbox = (0, 0, img.width, img.height)
    else:
        bbox = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)

    cropped = img.crop(bbox)
    side = max(cropped.width, cropped.height)
    pad = int(side * padding_frac)
    canvas_side = side + pad * 2

    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    canvas.paste(
        cropped,
        ((canvas_side - cropped.width) // 2, (canvas_side - cropped.height) // 2),
        cropped,
    )
    return canvas.resize((final_size, final_size), Image.LANCZOS)


def upload_to_supabase(local_path: str, storage_path: str) -> str:
    from supabase import create_client

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    bucket = os.environ.get("SUPABASE_BUCKET", "player-photos")

    client = create_client(url, key)
    with open(local_path, "rb") as f:
        client.storage.from_(bucket).upload(
            storage_path,
            f,
            file_options={"content-type": "image/png", "upsert": "true"},
        )
    return client.storage.from_(bucket).get_public_url(storage_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=None, help="only process the first N resolved players (smoke test)")
    parser.add_argument("--dry-run", action="store_true", help="skip the Supabase upload; write local PNGs + CSV with local paths only")
    parser.add_argument("--force", type=str, default="", help="comma-separated cricinfo_ids to re-fetch and reprocess even if a cached PNG already exists (use after re-sourcing a new photo_url for a player who was already 'ok')")
    args = parser.parse_args()

    force_ids = {cid.strip() for cid in args.force.split(",") if cid.strip()}

    with open(INPUT_JSON) as f:
        data = json.load(f)

    players = []
    for team in data["teams"]:
        for p in team["players"]:
            if p["status"] == "ok" and p.get("photo_url"):
                players.append({**p, "team": team["team"]})

    if args.limit:
        players = players[: args.limit]

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if not args.dry_run:
        missing = [v for v in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY") if v not in os.environ]
        if missing:
            print(f"Missing required env vars: {', '.join(missing)}. "
                  f"Set them, or pass --dry-run to skip the upload step.", file=sys.stderr)
            sys.exit(1)

    rows = [["name", "cricinfo_id", "team", "photo_url", "status"]]
    total = len(players)
    print(f"Processing {total} players...")

    for i, p in enumerate(players, 1):
        name, cid = p["name"], p["cricinfo_id"]
        print(f"[{i}/{total}] {name} ({cid})...", end=" ", flush=True)
        try:
            local_path = os.path.join(OUTPUT_DIR, f"{slugify(name)}-{cid}.png")
            forced = cid in force_ids

            if os.path.exists(local_path) and not forced:
                # Already processed in a previous run (or pre-seeded, e.g.
                # from a manual bg-removal test) — skip re-fetching/
                # re-running rembg and just reuse the cached PNG. Makes the
                # script idempotent across re-runs and lets you seed a few
                # players ahead of time to sanity-check before a full batch.
                final = Image.open(local_path).convert("RGBA")
                print("cached, skipping rembg...", end=" ", flush=True)
            else:
                if forced:
                    print("forced re-fetch...", end=" ", flush=True)
                fetch_url = cdn_fetch_url(p["photo_url"], FETCH_SIZE)
                raw = download_image(fetch_url)
                nobg = remove_background(raw)
                head_only = crop_to_head_and_neck(nobg)
                final = crop_pad_resize(head_only, FINAL_SIZE, PADDING_FRAC)
                final.save(local_path)

            if args.dry_run:
                photo_url = local_path
            else:
                storage_path = f"cpl-2026/{cid}.png"
                photo_url = upload_to_supabase(local_path, storage_path)

            rows.append([name, cid, p["team"], photo_url, "ok"])
            print("done")
        except Exception as e:
            rows.append([name, cid, p["team"], "", f"error: {e}"])
            print(f"FAILED ({e})")

        time.sleep(REQUEST_DELAY_S)

    with open(CSV_PATH, "w") as f:
        for row in rows:
            f.write(",".join('"' + str(c).replace('"', '""') + '"' for c in row) + "\n")

    ok_count = sum(1 for r in rows[1:] if r[-1] == "ok")
    print(f"\nDone. {ok_count}/{total} succeeded. CSV written to {CSV_PATH}")


if __name__ == "__main__":
    main()
