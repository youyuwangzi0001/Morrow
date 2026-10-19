#!/usr/bin/env python3
"""R10 验收 fixtures 构建器（零真实费用）。

生成：
- ws-main / ws-b：文件树、中文路径、二进制、大文件、只读文件、编辑冲突、旧 MEMORY.md、技能；
- 搜索素材：中文内容、node_modules 忽略项、跨工作区私密标记；
- 恶意技能 zip：zip-slip / 绝对路径 / 正常包；
- manifest.json：路径、大小、sha256，供 phase-a 自检。

用法：python tests/audit/r10/py/build_fixtures.py
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]  # tests/audit/r10/py -> Morrow
FIX = ROOT / "tmp" / "audit" / "r10" / "fixtures"


def write(path: Path, content: bytes | str, readonly: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, str):
        content = content.encode("utf-8")
    path.write_bytes(content)
    if readonly:
        os.chmod(path, stat.S_IREAD)


def write_repo_zip(zip_path: Path, entries: list[tuple[str, bytes]]) -> None:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            archive.writestr(name, data)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def force_remove_tree(path: Path) -> None:
    def on_error(func, target, _info):
        try:
            os.chmod(target, stat.S_IWRITE)
            func(target)
        except OSError:
            pass

    shutil.rmtree(path, onerror=on_error)


def main() -> int:
    if FIX.exists():
        force_remove_tree(FIX)
    main_ws = FIX / "ws-main"
    b_ws = FIX / "ws-b"

    # 文件树 / 中文 / 编码 / 大文件 / 二进制
    write(main_ws / "in" / "中文资料.txt", "编号 R10-A，金额 42。\n中文路径与内容必须可读写。\n")
    write(main_ws / "in" / "utf8-bom.txt", b"\xef\xbb\xbf" + "带 BOM 的中文文本\n".encode("utf-8"))
    write(main_ws / "in" / "notes.md", "# R10 笔记\n\n- 文件树\n- 编辑器\n- 搜索\n")
    write(main_ws / "in" / "big.txt", ("R10 大文件行\n" * 120_000))
    write(main_ws / "in" / "binary.bin", bytes(range(256)) * 64)
    write(main_ws / "in" / "readonly.txt", "只读内容，不允许修改。\n", readonly=True)
    write(main_ws / "in" / "nested" / "深" / "深层文件.ts", "export const r10 = 'deep'\n")
    write(main_ws / "out" / ".keep", "")
    write(main_ws / "docs" / "季度报告.md", "# 2026 年第二季度 销售分析\n\n环比增长 18.45%，重点客户为华东区。\n")
    write(main_ws / ".morrow" / "MEMORY.md", "- 编号 R10-LEGACY，项目记忆旧格式。\n- 偏好：简体中文输出。\n")
    write(main_ws / "skills" / "good-skill" / "SKILL.md", "---\nname: 中文技能\ndescription: R10 验收技能\n---\n\n# 步骤\n\n1. 读取 input\n2. 输出结果\n")
    write(main_ws / "node_modules" / "ignored" / "leak.txt", "R10_SEARCH_IGNORED_DIRECTORIES_SHOULD_NOT_MATCH\n")
    write(main_ws / ".git" / "config.json", '{"private": "R10_GIT_IGNORED_SHOULD_NOT_MATCH"}\n')

    # 编辑器/版本历史/冲突
    write(main_ws / "out" / "edit-me.txt", "line1\nline2\n")
    write(FIX / "conflict" / "baseline.txt", "version-1\n")
    write(FIX / "conflict" / "external-change.txt", "version-2-external\n")

    # 跨工作区隔离标记（B 私密；A 不得出现）
    write(b_ws / "in" / "private.md", "project=Cedar；marker=CROSS_WS_R10_SECRET\n")
    write(b_ws / "docs" / "secret.md", "CROSS_WS_R10_SECRET 不得出现在 A 搜索结果。\n")

    # 恶意 / 正常技能 zip
    write_repo_zip(
        FIX / "zips" / "skill-good.zip",
        [("good-skill/SKILL.md", b"---\nname: zip-skill\ndescription: normal zip\n---\n# ok\n")],
    )
    write_repo_zip(
        FIX / "zips" / "skill-zip-slip.zip",
        [
            ("good-skill/SKILL.md", b"---\nname: slip\n---\n"),
            ("../../r10-evil-relative.txt", b"R10_ZIP_SLIP_RELATIVE\n"),
            ("/r10-evil-absolute.txt", b"R10_ZIP_SLIP_ABSOLUTE\n"),
            ("../outside/evil.txt", b"R10_ZIP_SLIP_ESCAPE\n"),
        ],
    )
    # 无害但超大的技能包（用于大小限制检查；不要真的解压）
    write_repo_zip(FIX / "zips" / "skill-oversize.zip", [("big/SKILL.md", b"x" * (3 * 1024 * 1024))])

    entries: list[dict[str, object]] = []
    for path in sorted(FIX.rglob("*")):
        if path.is_file():
            entries.append(
                {
                    "path": str(path.relative_to(FIX)).replace("\\", "/"),
                    "size": path.stat().st_size,
                    "sha256": sha256(path),
                }
            )
    manifest = {
        "generatedAt": "r10",
        "workspaceMain": str(main_ws.relative_to(ROOT)).replace("\\", "/"),
        "workspaceB": str(b_ws.relative_to(ROOT)).replace("\\", "/"),
        "crossWorkspaceMarker": "CROSS_WS_R10_SECRET",
        "files": entries,
    }
    (FIX / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "fixtureRoot": str(FIX), "files": len(entries)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
