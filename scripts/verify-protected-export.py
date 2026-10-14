"""Independent optional check: pip install PyMuPDF, then pass smoke artifact dir.
Only synthetic integration fixtures; never supply real passwords here.
"""
from pathlib import Path
import sys
import pymupdf

root = Path(sys.argv[1])
doc = pymupdf.open(root / "protected.pdf")
assert doc.is_encrypted and not doc.authenticate("wrong")
assert doc.authenticate("export-demo")
assert "Searchable secret fixture" in doc[0].get_text()
assert next(doc[0].widgets()).field_value == "Grace"
encrypt_ref = int(doc.xref_get_key(-1, "Encrypt")[1].split()[0])
assert "/R 6" in doc.xref_object(encrypt_ref)
assert "/V 5" in doc.xref_object(encrypt_ref)

redacted = pymupdf.open(root / "protected-redacted.pdf")
assert redacted.is_encrypted and not redacted.authenticate("wrong")
assert redacted.authenticate("safe-export")
text = " ".join(page.get_text() for page in redacted)
assert "REDACTION-SECRET" not in text
assert "NEW-VISIBLE" in text and "PUBLIC-REMAINS" in text
for xref in range(1, redacted.xref_length()):
    try:
        value = (redacted.xref_stream(xref) if redacted.xref_is_stream(xref)
                 else redacted.xref_object(xref).encode())
    except RuntimeError as error:
        # A writer can leave free/unused xref entries, which are not objects.
        if "cannot find object in xref" not in str(error):
            raise
        continue
    assert b"REDACTION-SECRET" not in value
    assert b"524544414354494f4e2d534543524554" not in value.lower()
print("PASS independent PyMuPDF: AES-256/R6 password protection, editable forms, "
      "public/replacement text preserved, redacted secret absent from decoded objects.")
