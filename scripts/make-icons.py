#!/usr/bin/env python3
"""从 2.5D 品牌图标源生成 Windows 多尺寸 .ico / .png。

流程：
  1. node scripts/render-icon.mjs   # build/icon-source.svg -> build/icon.png (1024, 透明底)
  2. python scripts/make-icons.py   # build/icon.png -> build/icon.ico + installerIcon.ico + icon-512.png

图标源文件：build/icon-source.svg（2.5D 地平线徽记）
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "build" / "icon.png"
ICON = ROOT / "build" / "icon.ico"
INSTALLER = ROOT / "build" / "installerIcon.ico"
PNG512 = ROOT / "build" / "icon-512.png"

SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    if not SRC.exists():
        raise SystemExit("缺少 build/icon.png，请先运行：node scripts/render-icon.mjs")
    source = Image.open(SRC).convert("RGBA")
    if source.size[0] < 256:
        raise SystemExit(f"build/icon.png 尺寸过小：{source.size}")
    frames = [source.resize((size, size), Image.LANCZOS) for size in SIZES]
    frames[-1].save(ICON, format="ICO", sizes=[(size, size) for size in SIZES], append_images=frames[:-1])
    frames[-1].save(INSTALLER, format="ICO", sizes=[(size, size) for size in SIZES], append_images=frames[:-1])
    source.resize((512, 512), Image.LANCZOS).save(PNG512)
    print(f"[icon] {ICON} / {INSTALLER} / {PNG512} 已生成（{SIZES}）")


if __name__ == "__main__":
    main()
