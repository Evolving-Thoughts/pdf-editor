# PDF-Editor

Clientseitiger PDF-Editor: React + TypeScript + Vite, PDF.js und pdf-lib. Dateien,
Bearbeitungen und Entwürfe bleiben lokal; lokale Entwürfe sind **unverschlüsselt**.

## Lokal starten

```sh
npm ci
npm run dev
```

Nach dem Aktualisieren des Git-Stands `npm ci` erneut ausführen, wenn sich die
Abhängigkeiten geändert haben. `npm run build`, `npm run lint` und `npm test`
prüfen Build, Lint und Kernfunktionen.

## MVP-Härtetest (T13)

```sh
npx playwright install chromium
npm run fixtures:real
npm run qa
```

Zusätzlich benötigt der bestehende `pages-edges-smoke` **Poppler (`pdftotext`) im
PATH**. `CHROMIUM_PATH` kann alternativ auf einen installierten Chromium zeigen.
Der gemeinsame Runner startet eigene lokale Server (Ports 5234/5235), führt die
Smokes nacheinander aus und schreibt Logs, PDF-Ausgaben und `results.json` nach
`qa-artifacts/`. Fehlgeschlagene Tests ergeben einen Exit-Code ungleich null.
Die Server werden anschließend beendet.

`fixtures:real` ist ein expliziter Netzwerk-Schritt zum Herunterladen öffentlicher,
leerer Formulare. Bereits heruntergeladene Dateien werden per SHA-256 geprüft.
Die Editor-App selbst benötigt hierfür keinen Server und lädt keine Nutzer-PDFs
hoch. Fixtures und QA-Artefakte werden nicht ins Repository eingecheckt.

Details, Abdeckung und **offene manuelle Acrobat-/Vorschau-Prüfungen**:
[docs/T13-MVP-QA.md](docs/T13-MVP-QA.md).
