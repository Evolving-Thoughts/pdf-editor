# T25: Lokale Texterkennung und ihre Bestandteile

Die Erkennung läuft vollständig im Browser. Sie nutzt Tesseract als WebAssembly. Es gibt kein Sprachmodell-Backend, keinen Server, keinen API-Schlüssel und keinen Dokument-Upload. Sie startet nur über den Button „Erkennung starten“ im Dialog, nie beim Öffnen eines Dokuments.

## Versionen und Herkunft

| Bestandteil | Version | Herkunft | Lizenz |
| --- | --- | --- | --- |
| tesseract.js | 7.0.0 | npm, `naptha/tesseract.js` | Apache-2.0 |
| tesseract.js-core (Engine als WASM) | 7.0.0 | npm, `naptha/tesseract.js-core` | Apache-2.0 |
| Tesseract (in der Engine) | Fork `Balearica/tesseract` | über tesseract.js-core | Apache-2.0 |
| Sprachmodelle Deutsch, Englisch | `@tesseract.js-data/*` 1.0.0, Ordner `4.0.0_best_int` | npm, Quelle `naptha/tessdata`, abgeleitet von `tesseract-ocr/tessdata_best` | Apache-2.0 |
| fflate (für T26) | 0.8.3 | npm | MIT |

Die npm-Pakete der Sprachmodelle nennen MIT, die Quelle der Modelle nennt Apache-2.0. Das Projekt behandelt die Modelle wie Apache-2.0.

In die Engine sind weitere Bibliotheken einkompiliert (laut `.gitmodules` von tesseract.js-core):

| Bibliothek | Lizenz |
| --- | --- |
| Leptonica | BSD-artig (2 Klauseln) |
| libpng | libpng-Lizenz |
| zlib | zlib-Lizenz |
| libwebp | BSD-3-Clause |
| libjpeg | IJG-Lizenz |
| libtiff | libtiff-Lizenz |
| giflib | MIT-artig |
| openlibm | BSD, ISC und MIT; die LGPL-Dateien im Repository sind Testprogramme und nicht Teil der Bibliothek |

Das sind freizügige Lizenzen, die auch kommerzielle Nutzung erlauben. Pflicht ist, Lizenz- und Copyright-Hinweise mitzuliefern. Dafür erzeugt `scripts/copy-ocr-assets.mjs` die Datei `ocr/LICENSES.txt` im ausgelieferten Build. Diese Einordnung ist keine Rechtsberatung.

## Integrität

- Versionen sind in `package.json` exakt festgeschrieben, dazu kommt `package-lock.json`.
- `src/core/ocr/ocrAssets.json` enthält SHA-256-Werte für Engine, Worker und Modelle. `scripts/copy-ocr-assets.mjs` bricht beim Bauen ab, wenn eine Datei abweicht.
- Die App prüft vor jedem Start die SHA-256-Werte der Sprachmodelle im Browser. Ein beschädigtes Modell wird abgelehnt.
- `workerPath`, `corePath` und `langPath` zeigen auf die eigene Adresse der App. Die CDN-Vorgaben von tesseract.js werden nicht genutzt.
- `cacheMethod: 'none'`: Modelle werden nicht im Browser-Speicher von tesseract.js abgelegt.
- `tesseract.js` hat ein `postinstall`-Skript (`opencollective-postinstall`), das nur eine Spendenbitte ausgibt. Es gehört zur Installation, nicht zum ausgelieferten Build.

## Sicherheitsgrenzen

- Der Build liefert drei Engine-Varianten aus. Der Browser wählt die passende, geladen wird nur diese eine.
- Die Engine läuft in einem eigenen Worker und bekommt nur ein gerendertes Bild der Seite, nie die PDF-Datei.
- Ein Abbruch beendet den Worker. Ein Zeitlimit von 3 Minuten pro Seite beendet festhängende Läufe.
- Die Bildgröße ist auf 16 Megapixel begrenzt, die Auflösung liegt bei höchstens 300 dpi.
- WASM-Code von Dritten läuft im Browser-Sandkasten. Das Projekt hat ihn nicht selbst geprüft. Bei einem Update müssen Hashes und diese Tabelle neu bewertet werden.

## Grenzen der Erkennung

- Erkannter Text liegt unsichtbar über dem Bild, das sichtbare Bild ändert sich nicht.
- Die Erkennung kann Fehler enthalten und liefert bei Handschrift oder schlechten Scans wenig. Der Dialog zeigt das Ergebnis vor der Übernahme und markiert die Zahl unsicherer Wörter.
- Die unsichtbare Schrift ist Helvetica. Zeichen außerhalb von WinAnsi fehlen im unsichtbaren Text.
- Beim Schwärzen verliert die betroffene Seite ihren erkannten Text.
