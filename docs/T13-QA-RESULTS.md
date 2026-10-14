# T13 – lokales Prüfergebnis

Basis: `24f8ea3eddeb6a7a19e0cabfd4170e69911c0189` (T12) plus T13-Änderungen.

- Saubere Installation per `npm ci`: erfolgreich; danach erneut Tests, Lint und Build erfolgreich.
- Vitest: **31 Suites / 238 Tests bestanden**.
- Gemeinsamer QA-Lauf: **27/27 Schritte bestanden**, darunter **22 Browserläufe**
  (21 Dev-Smokes und die echte Formular-Suite im gebauten Produktionsbundle).
- Gemischte Historie: **40 Aktionen**, jeder Undo-/Redo-Zustand exakt geprüft;
  Text, Strich, Form, Bild, Seitenreihenfolge und native Werte gemeinsam gespeichert.
- Unabhängiger PyMuPDF-Leser: Dev- und Produktions-Exporte sämtlich geöffnet und
  gerendert; native Felder erneut bearbeitet; XFA-XML-Pakete im KG1/W-9 bytegenau
  mit den Quellen verglichen; Scan-Overlay suchbar; verschlüsselte Ableitung geprüft.
- Separater verschlüsselter Schwärzungs-Export: Passwortschutz und AES-256/R6
  geprüft, Geheimtext fehlt auch in dekodierten PDF-Objekten; sichtbarer Ersatztext erhalten.

Lokale Umgebung: Linux, Node v24.14.1, Google Chrome for Testing 153.0.8010.12; PyMuPDF 1.28.2.

Der gemeinsame Lauf ist als `qa-artifacts/results.json` mit Einzel-Logs und
PDF-Ausgaben lokal reproduzierbar. Generierte PDFs werden nicht ins Repository
aufgenommen. Dieser Bericht behauptet **keinen bereits grünen GitHub-CI-Lauf**.

## Nicht als bestanden ausgegeben

- Acrobat und macOS Vorschau: hier nicht verfügbar; manuelle Freigabe offen.
- Tatsächlicher Browser-PDF-Viewer: separate manuelle Prüfliste (PDF.js/Editor ist
  kein Ersatz für diesen Viewer).
- Unabhängig beschaffter echter Scan: manuelle Stichprobe offen; automatisiert
  geprüft ist ein ausdrücklich gekennzeichnetes Scan-Surrogat aus echtem Formular.
- Zusätzliche eingebettete Open-Source-Fonts: dokumentiert zurückgestellt;
  aktuelle Standardschrift-/Unicode-Grenzen stehen im Abgleich.
- XFA-Bearbeitung bleibt vereinbarungsgemäß außerhalb des MVP.
- Windows: Pfade/Browserauswahl korrigiert, aber nicht auf Windows ausgeführt.

Details und manuelle Checkliste: [T13-MVP-QA.md](T13-MVP-QA.md).

## Gemeldeter CI-Lauf und Diagnose

Der erste GitHub-Lauf ist **nicht grün**: `shapes-smoke`, `shapes-repeat-smoke`
und `search-import-smoke` wurden als FAIL gemeldet. Die bisherige Zusammenfassung
enthält keine Assertion oder Stacktrace; eine konkrete Produktursache ist daraus
nicht ableitbar.

Die drei unveränderten Smokes wurden lokal zusätzlich mit dem zu Playwright 1.64.0
gehörigen Chromium 156.0.8078.4 und separat mit alternativen Linux-Schriftmetriken
(Liberation Sans) ausgeführt: alle drei bestanden. Das widerlegt nicht den CI-Fehler,
belegt aber auch keinen gemeinsamen Export-/Geometriemutationsfehler.

Der Runner zeigt deshalb nun die konkrete Fehlermeldung direkt im Actions-Log
(letzte 60 Zeilen), behält den vollständigen Log und wartet dessen Abschluss ab.
Vier neue Runner-Regressionstests bestätigen: Fehler bleiben FAIL, ursprünglicher
Exit-Code bleibt erhalten, Timeouts werden benannt, und volle Logs gehen nicht verloren.
Es wurden **keine** Shape-/PDF-/Schwärzungs-Exportregeln auf bloßen Verdacht geändert.
Der gemeldete CI-Fehler bleibt bis zur konkreten Assertion und Verifikation offen.

### Reproduzierter Layoutfehler (Ubuntu DejaVu)

Mit verifizierten Ubuntu-DejaVu-Schriften wurden zwei Fehler reproduziert:
`shapes-smoke` scheiterte am von der Palette verdeckten Rotationsgriff;
`shapes-repeat-smoke` startete eine Touch-Geste auf Palettenkontrollen statt Papier.
Beides lag vor der PDF-Exportprüfung. Die Palette belegte im 390×900-Viewport
355 von 371 Pixeln Arbeitsbereich, sodass Herunterschieben keinen Griff freilegte.

Korrektur: vorhandene scrollbare Formpalette auf höchstens 60% der Arbeitsfläche
begrenzen. Kein neues Bedienkonzept, keine Änderung der PDF-Serialisierung.
Ursprüngliche Fixtures/Viewportgrößen und reale Hit-Test-/Touch-/Cancel-Assertions
bleiben erhalten; zusätzliche Assertions prüfen freie Papierfläche und die
Erreichbarkeit der letzten Option per Palettenscroll.

`search-import-smoke` besteht auch unter DejaVu. Dessen gemeldeter CI-Fehler bleibt
mangels konkreter Assertion unbestätigt; er wird nicht als behoben ausgegeben.
