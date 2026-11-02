"""Independent offline verification of the M09 / M11 / M12 evidence produced by
`make_evidence.ts` (which drives Morrow's real document tools).

Checks use implementations that do NOT share code with Morrow's tools:
- M09: openpyxl (data_only=False keeps formulas) + LibreOffice Kit recalculate
       (must produce D4 = 21 from the real formulas);
- M11: python-docx reopen of the generated letter + input template sha256 unchanged;
- M12: invoice.pdf fixture provenance + the tool-extracted text/计算 numbers.

Run: <bundled python> verify_evidence.py
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

from docx import Document
from openpyxl import load_workbook

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]  # tests/unit/core/fixtures/documents -> project root
OUT = ROOT / "tmp" / "doc-evidence"
WS = OUT / "ws"

NODE = r"C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
LO_CLI = r"C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_m09(evidence: dict) -> dict:
    workbook_path = WS / "out" / "sales.xlsx"
    recalc_path = OUT / "sales-recalc.xlsx"
    formula_book = load_workbook(workbook_path, data_only=False)
    sheet = formula_book["Sales"]
    formulas = {
        "D2": sheet["D2"].value,
        "D3": sheet["D3"].value,
        "D4": sheet["D4"].value,
    }
    headers = [sheet.cell(row=1, column=column).value for column in range(1, 5)]
    data = [[sheet.cell(row=row, column=column).value for column in range(1, 5)] for row in (2, 3)]
    assert formulas == {"D2": "=B2*C2", "D3": "=B3*C3", "D4": "=SUM(D2:D3)"}, formulas
    assert headers == ["Item", "Qty", "Price", "Total"], headers
    assert data == [["Pen", 2, 3, "=B2*C2"], ["Book", 3, 5, "=B3*C3"]], data

    result = subprocess.run(
        [NODE, LO_CLI, "recalculate", "--input", str(workbook_path), "--output", str(recalc_path)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0 and recalc_path.exists(), f"LibreOffice recalculate failed: {result.stdout}\n{result.stderr}"
    recalculated = load_workbook(recalc_path, data_only=True)["Sales"]
    values = {"D2": recalculated["D2"].value, "D3": recalculated["D3"].value, "D4": recalculated["D4"].value}
    assert values == {"D2": 6, "D3": 15, "D4": 21}, values
    assert values["D4"] == evidence["m09"]["grand_total"] == 21
    return {
        "status": "PASS",
        "formulas_in_file": formulas,
        "headers": headers,
        "data_rows": data,
        "libreoffice_recalculated": values,
        "recalculated_file": str(recalc_path),
    }


def check_m11(evidence: dict) -> dict:
    letter = WS / "out" / "letter.docx"
    template = WS / "in" / "template.docx"
    document = Document(letter)
    paragraphs = [paragraph.text for paragraph in document.paragraphs]
    table = document.tables[0]
    cell_texts = [cell.text for row in table.rows for cell in row.cells]
    full_text = "\n".join(paragraphs) + "\n" + "\n".join(cell_texts)
    assert "Pilot Letter" in full_text, paragraphs
    assert "Dear 林宁" in full_text, paragraphs
    assert "CONFIDENTIAL - internal only" in full_text, paragraphs
    assert "{{NAME}}" not in full_text and "{{DATE}}" not in full_text
    assert cell_texts == ["Date", "2026-04-10"], cell_texts
    input_hash = sha256(template)
    assert input_hash == evidence["m11"]["input_sha256"], (input_hash, evidence["m11"]["input_sha256"])
    assert evidence["m11"]["output_placeholders"] == []
    return {
        "status": "PASS",
        "output_paragraphs": paragraphs,
        "table_cells": cell_texts,
        "input_unchanged_sha256": input_hash,
        "replacements": evidence["m11"]["replacements"],
    }


def check_m12(evidence: dict) -> dict:
    m12 = evidence["m12"]
    assert m12["invoice_id"] == "INV-0042", m12
    assert m12["calculated_total"] == 37, m12
    assert m12["printed_total"] == 38, m12
    assert m12["matches"] is False, m12
    pdf_text = (WS / "out" / "read_pdf.txt").read_text(encoding="utf-8")
    for needle in ("INV-0042", "Items: 12, 18, 7", "Printed total: 38"):
        assert needle in pdf_text, needle
    return {
        "status": "PASS",
        "invoice_id": m12["invoice_id"],
        "calculated_total": m12["calculated_total"],
        "printed_total": m12["printed_total"],
        "matches": m12["matches"],
        "extracted_text_file": str(WS / "out" / "read_pdf.txt"),
    }


def main() -> None:
    evidence = json.loads((OUT / "evidence.json").read_text(encoding="utf-8"))
    verification = {
        "verified_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "M09": check_m09(evidence),
        "M11": check_m11(evidence),
        "M12": check_m12(evidence),
    }
    (OUT / "verification.json").write_text(json.dumps(verification, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(verification, ensure_ascii=False, indent=2))
    print("\nALL INDEPENDENT CHECKS PASSED")
    sys.exit(0)


if __name__ == "__main__":
    main()
