# T11 – Suche, PDF-Drop und geschützte PDFs

Basis: gemergter T10-Stand `b4659468852eebd6223fe9fadd1e5c76b2471c93`.
Freigegeben: Suchfenster C; beide Pfeile und Schließen in einer Zeile.
Zusätzlich freigegeben: optionaler passwortgeschützter Export.

## Bedienung

- „Suchen“ oder Strg/⌘+F öffnet das kleine Fenster über dem Dokument.
- PDF-Text, eingefügte Textseiten und zusätzliche Textboxen werden durchsucht.
  Aktueller Treffer wird hervorgehoben und in die Ansicht gescrollt.
- Enter/Shift+Enter im Suchfeld oder Pfeile wechseln vor/zurück (umlaufend).
  Escape oder × schließt. Leere Suche und keine Treffer deaktivieren die Pfeile.
- Suche ist literal, ohne Beachtung der Groß-/Kleinschreibung. Leerraum über
  PDF-Textitems/Zeilen hinweg wird vereinheitlicht. Keine OCR; Bildseiten und
  gerasterte Originale liefern keinen Text. Neue Textboxen darauf bleiben suchbar.
- Separate Textboxen/Seiten werden nicht zu einem einzigen Suchtext verkettet.
  Native Formularwerte gehören nicht zum Textindex; sie bleiben nativ editierbar.
- Schriftmessung approximiert einzelne PDF-Glyphenbreiten. Bei ungewöhnlichen
  eingebetteten Fonts kann die Markierung etwas von der exakten Glyphenform abweichen.
- Eine PDF-Datei in den Editor ziehen öffnet ein neues Dokument. Der aktuelle
  Entwurf wird vorher gespeichert. Fehler beim Speichern/Öffnen oder Abbruch
  behalten den bisherigen Stand. Mehrfach-Drops werden abgewiesen. Der bestehende
  PNG/JPG-Drop auf eine Seite bleibt erhalten. Dateien anhängen weiterhin über
  „Seiten verwalten“ → „Seiten einfügen“.

## Verschlüsselung und Vertraulichkeit

- Geschützte PDFs werden mit einem lokalen Passwortdialog geöffnet. Falsches
  Passwort: erneut versuchen oder abbrechen. Auch ein explizit leeres Passwort
  zum Öffnen ist möglich. Nicht unterstützte Schutzverfahren erhalten eine
  verständliche Fehlermeldung, keine Raster-Ersatzlösung.
- PDF.js allein entsperrt nur die Darstellung. Deshalb entschlüsselt ein isolierter
  Adapter mit `@cantoo/pdf-lib` (exakt 2.11.1) eine lokale Arbeitskopie. Alle anderen
  Editoroperationen verwenden weiterhin upstream `pdf-lib`.
- Originaldatei unverändert. **Lokale Arbeitskopie und Auto-Entwürfe sind
  unverschlüsselt.** Der Passwortdialog und die Speicherinfo benennen dies.
- Bestehendes „Exportieren“ bleibt ein direkter unverschlüsselter Export.
  „Mit Passwort exportieren …“ verlangt ein nicht leeres Passwort und dessen
  Wiederholung; Ausgabe AES-256 (Revision 6), ohne zusätzliche Bearbeitungsverbote.
- Kein ursprüngliches Passwort wird wiederverwendet; kein Passwort gelangt in
  Modell, IndexedDB oder Logs. Passwortfelder verschwinden bei Ende/Abbruch.
- PDF/A erlaubt keine Verschlüsselung; geschützter Export wird dort verständlich
  abgewiesen. Digitale Signaturen werden nicht neu erstellt und eine veränderte
  Datei ist nicht automatisch weiterhin signaturgültig.
- Keine serverseitige Übertragung. Bei Schwärzung weiterhin nur den geprüften
  Export weitergeben; Original/Entwürfe können vertrauliche Inhalte enthalten.
- Verschlüsselte PDFs als eingefügte Anlagen sind nicht Teil dieses Öffnungsflusses;
  die Seiten-Einfügefunktion meldet weiterhin nicht lesbare Dateien.

## Tests

- `npm test`, `npm run lint`, `npm run build`
- `SMOKE_URL=http://localhost:5221 node scripts/search-import-smoke.mjs`
  (App vorher mit Vite starten; lokales Chromium erforderlich.)
- Optional unabhängiger Reader: `python scripts/verify-protected-export.py <SMOKE_ARTIFACT_DIR>`
  (benötigt PyMuPDF). Prüft AES-256/R6, Passwort-Abweisung, AcroForms und entschlüsselte
  Objektstreams des geschwärzten Exports.
- Bestehende `redaction-smoke.mjs` und `thumbnails-smoke.mjs` für T10/T8-Regressionen.
- `tests/pdfEncryptionFixtures.json`: unabhängig mit PyMuPDF erzeugte synthetische
  Dateien (keine Nutzerdaten), AES-256, AES-128, RC4-128, verschlüsselte Objektstreams,
  leeres User-Passwort. Werte `demo`, `owner-demo` sind ausschließlich Testpasswörter.
  Tests prüfen Entschlüsselung, falsches Passwort, Owner-Passwort, unveränderte
  Eingabebytes und editierbare AcroForms. Kryptografie-Roundtrip alleine ist kein
  unabhängiger Beweis: Browser-PDF.js und unabhängiges PyMuPDF lesen den Export zurück.
