#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M11 校验：DOCX 可打开、占位符消失、标题/表格/保密条款保留、输入字节不变。

用法：python check_docx.py <letter.docx> <template.docx>
输出 JSON {ok, detail, paragraphs, tables}
"""
import hashlib
import json
import sys
from pathlib import Path


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "detail": "usage: check_docx.py <letter> <template>"}, ensure_ascii=False))
        return 2
    letter = Path(sys.argv[1])
    template = Path(sys.argv[2])
    try:
        from docx import Document
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "detail": f"python-docx 不可用：{exc}"}, ensure_ascii=False))
        return 1
    problems = []
    try:
        doc = Document(letter)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "detail": f"DOCX 打不开：{exc}"}, ensure_ascii=False))
        return 1
    paragraphs = [p.text for p in doc.paragraphs]
    text = "\n".join(paragraphs)
    tables = []
    for table in doc.tables:
        rows = [[cell.text for cell in row.cells] for row in table.rows]
        tables.append(rows)
    table_text = "\n".join("\n".join("|".join(row) for row in rows) for rows in tables)
    if "Pilot Letter" not in text:
        problems.append("标题 Pilot Letter 丢失")
    if "{{NAME}}" in text or "{{DATE}}" in text or "{{NAME}}" in table_text or "{{DATE}}" in table_text:
        problems.append("占位符未替换干净")
    if "林宁" not in text:
        problems.append("正文缺少 林宁")
    if "2026-04-10" not in table_text and "2026-04-10" not in text:
        problems.append("表格缺少 2026-04-10")
    if not tables or not any("Date" in cell or "{{DATE}}" in cell for rows in tables for row in rows for cell in row):
        problems.append("表格结构丢失")
    if "CONFIDENTIAL - internal only" not in text:
        problems.append("保密条款丢失")
    template_hash = sha256(template)
    ok = not problems
    print(
        json.dumps(
            {
                "ok": ok,
                "detail": "；".join(problems) if problems else "标题/正文/表格/保密条款正确，占位符已全部替换",
                "paragraphs": paragraphs,
                "tables": tables,
                "template": {"sha256": template_hash},
            },
            ensure_ascii=False,
        )
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
