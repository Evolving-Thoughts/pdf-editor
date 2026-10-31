"""Independent check of T26 output, read by other software than the app.
pip install openpyxl odfpy, then pass the table-smoke artifact directory.
"""
from pathlib import Path
import json
import sys

from odf.opendocument import load
from odf.table import Table, TableCell, TableRow
from odf.text import P
from openpyxl import load_workbook

root = Path(sys.argv[1])
expected = json.loads((root / "expected.json").read_text(encoding="utf8"))["rows"]

book = load_workbook(root / "tabelle.xlsx")
sheet = book.active
assert not book.vba_archive, "no macros"
xlsx = [[cell.value for cell in row] for row in sheet.iter_rows()]
assert xlsx == expected, xlsx
for row in sheet.iter_rows():
    for cell in row:
        assert cell.data_type != "f", f"{cell.coordinate} must not be a formula"
        assert cell.hyperlink is None, f"{cell.coordinate} must not be a link"

document = load(str(root / "tabelle.ods"))
table = document.spreadsheet.getElementsByType(Table)[0]
ods = []
for row in table.getElementsByType(TableRow):
    values = []
    for cell in row.getElementsByType(TableCell):
        kind = cell.getAttribute("valuetype")
        assert cell.getAttribute("formula") is None, "must not be a formula"
        if kind == "float":
            value = float(cell.getAttribute("value"))
            values.append(int(value) if value.is_integer() else value)
        else:
            values.append("".join(str(part) for part in cell.getElementsByType(P)))
    ods.append(values)
assert ods == expected, ods
print("PASS independent table check: XLSX and ODS values and cell types match")
