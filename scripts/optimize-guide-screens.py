"""Compress guide screenshots without changing filenames.

- Downscale to at most 1600 px wide (docs render far below this).
- Quantize to a 256-color palette and re-encode with optimize.
- Keep the manifest dimensions in sync.

Usage: python scripts/optimize-guide-screens.py
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SCREENS = ROOT / "docs" / "guide" / "screens"
MANIFEST = SCREENS / "manifest.json"
MAX_WIDTH = 1600
COLORS = 256


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    before_total = 0
    after_total = 0
    for entry in manifest["images"]:
        path = SCREENS / entry["file"]
        if not path.exists():
            raise SystemExit(f"missing screenshot: {path}")
        before = path.stat().st_size
        before_total += before
        with Image.open(path) as source:
            image = source.convert("RGB")
            if image.width > MAX_WIDTH:
                height = round(image.height * MAX_WIDTH / image.width)
                image = image.resize((MAX_WIDTH, height), Image.Resampling.LANCZOS)
            quantized = image.quantize(colors=COLORS, method=Image.MEDIANCUT, dither=Image.Dither.NONE)
            quantized.save(path, optimize=True)
            entry["width"], entry["height"] = quantized.size
        after = path.stat().st_size
        after_total += after
        print(f"{entry['file']}: {before / 1024:.0f} KB -> {after / 1024:.0f} KB")
    manifest["optimized"] = {
        "maxWidth": MAX_WIDTH,
        "colors": COLORS,
        "format": "PNG-8",
        "updatedAt": date.today().isoformat(),
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"total: {before_total / 1024 / 1024:.1f} MB -> {after_total / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
