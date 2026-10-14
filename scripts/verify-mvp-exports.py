"""Independent render/read/edit checks. Requires PyMuPDF; no Acrobat claim.
Usage: python scripts/verify-mvp-exports.py qa-artifacts/mvp-production
Only public blank forms and fixture-only passwords; never use private documents.
"""
from pathlib import Path
import sys
import re
import pymupdf

root = Path(sys.argv[1])
for filename, pages, widgets in [("dod_character.pdf-edited.pdf", 1, 16),
                                 ("character-unlocked.pdf", 1, 16)]:
    doc = pymupdf.open(root / filename)
    assert not doc.is_encrypted and len(doc) == pages
    fields = [(i, widget.field_name, widget.field_value)
              for i, page in enumerate(doc) for widget in page.widgets()]
    assert len(fields) == widgets, (filename, len(fields))
    if "edited" in filename:
        edited = next((i, name) for i, name, value in fields if value == "MVP REAL FORM")
        page = doc[edited[0]]
        widget = next(w for w in page.widgets() if w.field_name == edited[1])
        widget.field_value = "PYMUPDF SECOND READER EDIT"
        widget.update()
        output = doc.tobytes()
        reloaded = pymupdf.open(stream=output, filetype="pdf")
        assert any(w.field_value == "PYMUPDF SECOND READER EDIT"
                   for page in reloaded for w in page.widgets())
    for page in doc:
        pixels = page.get_pixmap(matrix=pymupdf.Matrix(1, 1))
        assert pixels.width > 0 and pixels.height > 0
    print("PASS independent native fields + rendering:", filename)
for name, count, widget_count in [("kg1.pdf", 5, 95), ("fw9.pdf", 6, 23)]:
    doc = pymupdf.open(root / (name + "-preserved.pdf"))
    assert len(doc) == count and not doc.is_encrypted
    form_ref = int(doc.xref_get_key(doc.pdf_catalog(), "AcroForm")[1].split()[0])
    assert doc.xref_get_key(form_ref, "XFA")[0] == "array"
    original = pymupdf.open(Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "real" / name)
    original_ref = int(original.xref_get_key(original.pdf_catalog(), "AcroForm")[1].split()[0])
    def packets(pdf, ref):
        value = pdf.xref_get_key(ref, "XFA")[1]
        refs = re.findall(r"(\d+)\s+\d+\s+R", value)
        return [pdf.xref_stream(int(xref)) for xref in refs]
    assert packets(original, original_ref) == packets(doc, form_ref), "XFA XML packets changed"

    assert sum(1 for page in doc for _ in page.widgets()) == widget_count
    for page in doc:
        assert page.get_pixmap().width > 0
    print("PASS independent XFA preservation (not native editing):", name)
scan = pymupdf.open(root / "derived-character-scan.pdf")
assert not scan[0].get_text().strip() and scan[0].get_images()
overlaid = pymupdf.open(root / "scan-with-text.pdf")
assert "SCAN OVERLAY SEARCHABLE" in overlaid[0].get_text()
protected = pymupdf.open(root / "derived-character-encrypted.pdf")
assert protected.is_encrypted and not protected.authenticate("wrong")
assert protected.authenticate("fixture-only")
assert len(protected) == 1
print("PASS independent image-only scan, searchable overlay and encrypted real-form derivative")
