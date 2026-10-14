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
