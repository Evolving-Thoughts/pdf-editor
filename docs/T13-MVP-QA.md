# T13 – MVP-Härtetest

## Umfang und reproduzierbarer Lauf

Basis: gemergter T12-Stand `24f8ea3eddeb6a7a19e0cabfd4170e69911c0189`.
Kein neues Bedienkonzept; die gewählten UI-Varianten bleiben erhalten.

```sh
npm ci
npx playwright install chromium
npm run qa:ci
```

Voraussetzungen: von Vite unterstützte Node-Version, Chromium (oder explizites
`CHROMIUM_PATH`), Poppler/`pdftotext` im PATH für den vorhandenen Seiten-Randfalltest.
Die CI benötigt keine öffentlichen Echtdokument-Downloads. Für den optionalen
vollständigen lokalen Echtdokument-Lauf:

```sh
npm run fixtures:real
npm run qa
```

Python/PyMuPDF ist nur für die zusätzlichen unabhängigen Prüfungen erforderlich:

```sh
python -m pip install PyMuPDF
python scripts/verify-mvp-exports.py qa-artifacts/mvp-real-smoke
python scripts/verify-mvp-exports.py qa-artifacts/mvp-production
python scripts/verify-protected-export.py qa-artifacts/search-import-smoke
```

`npm run qa:ci` prüft Kern-Tests, Lint, Build und alle 20 synthetischen
Browser-Smokes. Echtdokument-Hashes, Echtdokument-Smoke und dessen Produktionslauf
werden ausdrücklich als **NOT_RUN** ausgewiesen, nicht als bestanden.

`npm run qa` prüft weiterhin Fixture-Hashes, Kern-Tests, Lint, Build, alle 21 Browser-Smokes
und denselben echten Formularablauf im **gebauten Produktionsbundle**. Jeder Smoke
bekommt isolierten Browser-Speicher und ein eigenes Artefaktverzeichnis. Bei Fehlschlägen erscheinen die letzten 60 Logzeilen (inklusive Assertion/Stack)
direkt im Job-Log; der vollständige Einzel-Log wird vorher vollständig geschrieben.
Vier Node-Regressionstests prüfen Fehlercode, Timeout, Begrenzung und Log-Erhalt. Logs und
PDFs liegen in `qa-artifacts/`; `results.json` und `results.md` dokumentieren auch
Fehlschläge. Ein Fehler führt zu einem Exit-Code ungleich null. Ein einzelner
Smoke hat ein Zeitlimit von vier Minuten.

`SMOKE_URL` kann einen bereits laufenden **Dev-Server** auswählen; die bisherigen
Smokes verwenden teilweise Dev-Imports. In diesem Modus wird der zusätzliche
Produktionslauf ausdrücklich als NOT_RUN dokumentiert. Für den vollständigen
Lauf die Variable nicht setzen. Die vom Runner gestarteten Server auf 5234/5235
werden beendet. Die echte Formular-Suite selbst hat keine Dev-Import-Abhängigkeit.

## Fixture-Herkunft

`scripts/real-fixtures.json` enthält URLs, SHA-256 und Herkunft. Änderungen an
öffentlichen Formularen werden **nicht stillschweigend akzeptiert**: neue Inhalte
und Hashes müssen bewusst geprüft werden. Downloads sind auf 15 MiB begrenzt.
Dateien bleiben unter dem ignorierten `tests/fixtures/real/`; keine Behörden-PDFs
oder personenbezogenen Daten werden im Repository veröffentlicht.

| Fixture | Herkunft / Kategorie | Geprüfte Struktur |
| --- | --- | --- |
| `kg1.pdf` | Öffentlicher leerer Kindergeld-Antrag, Bundesagentur für Arbeit | 5 Seiten, 95 Widgets; leerer Öffnungsschutz + **nicht unterstütztes XFA**: nur Erhalt/Hinweis, keine native Bearbeitung |
| `fw9.pdf` | Öffentliches leeres IRS-Formular W-9 | 6 Seiten, 23 Widgets plus **XFA**: Erhalt/Hinweis, keine native Bearbeitung |
| `dod_character.pdf` | Öffentliches, vorbestehendes Charakterbogen-AcroForm aus den pdf-lib-Beispielen | 1 Seite, 14 native Textfelder / 16 Widgets, kein XFA |
| `derived-character-scan.pdf` | **Erzeugtes Scan-Surrogat**, gerenderte Pixel der echten Charakterbogen-Seite; kein unabhängig beschaffter Scan | Bildseite ohne Textschicht; hinzugefügter Overlay-Text wird suchbar exportiert |
| `derived-character-encrypted.pdf` | **Erzeugte verschlüsselte Ableitung** des echten Charakterbogens | AES-256, falsches Passwort/Abbruch/richtiges Passwort; 14 Felder / 16 Widgets erhalten |
| `large-valid.pdf` | **Erzeugter Randfall**, gültige Bild-PDF mit Padding vor finalem EOF | über 50 MiB; Warnung statt Absturz |
| Bestehende synthetische Fixtures | Kontrollierte Testtexte, Geometrie und bekannte Geheimnisse | Präzise Erwartungen für Schwärzung, Textposition, Formen und Fehlerpfade |

Passwörter wie `fixture-only` sind öffentliche Testwerte, keine Nutzer-Zugangsdaten.
Die Scan-PDF ist bewusst eine Ableitung: Ein zusätzlicher unabhängig stammender
Scan gehört zur manuellen Stichprobe unten, nicht zu einem behaupteten Automatikergebnis.

## Abgleich mit der Spec

| Anforderung | Automatisierte Evidenz | Grenzen / Restprüfung |
| --- | --- | --- |
| PDF-Export mit echtem, kopierbarem Text | `exportPdf`, `exportOverlays`, `textbox-export-position-smoke`, `search-import-smoke`, `mvp-real-smoke`; zweiter Parser PDF.js | Acrobat und macOS Vorschau manuell |
| Native Formularwerte bleiben editierbar | `acroform-smoke`, echtes Charakterbogen-AcroForm: Schreiben, Export, erneutes Bearbeiten; KG1/W-9-XFA wird ausdrücklich nicht bearbeitet; optional PyMuPDF als dritter Leser | Signaturen, XFA, Buttons und PDF-JavaScript werden nicht ausgeführt |
| Entwurf nach Tab-Neustart | echtes Charakterbogen-AcroForm: Tab schließen, frischen Tab im selben Speicher öffnen; vorhandene Smokes für Text/Striche/Bilder/Formen/Seiten/Schwärzung | Kein pauschales Versprechen bei privatem Modus oder gelöschtem Browserspeicher |
| Alle Eingabetypen + Reihenfolge in einem Entwurf | `mvpHistory.test.ts`: Text, Strich, Form, Bild, native Werte und Seitenreihenfolge gemeinsam in IndexedDB; DB schließen/neu öffnen, frischer Store | Fake IndexedDB ergänzt echte Browser-Smokes; kein Ersatz für deren Speicherprüfung |
| Mindestens 20 gemischte Undo-Schritte | `mvpHistory.test.ts`: **40** Aktionen; jeder einzelne Zustand rückwärts/vorwärts verglichen, inkl. Drehen/Umsortieren/Formularwerten/Schwärzungsvormerkungen | Undo-Historie selbst ist sitzungslokal, nicht Teil des gespeicherten Entwurfs |
| Echte Schwärzung | `redaction-smoke`, `redaction-geometry-smoke`, Kern-Tests und verschlüsselter Roundtrip; Geheimtext in Text und dekodierten Objekten abwesend | Visuell und im Zielprogramm prüfen; nur Export weitergeben, Original/Entwurf bleiben vertraulich |
| Weiße Korrektur unter neuem Text | `shapes-smoke`, `exportShapes`, `textbox-export-position-smoke` | Überdecken allein ist keine sichere Schwärzung |
| >50 MB verständliche Warnung | echte Browserprüfung mit gültigem >50-MiB-Dokument | Keine universelle Performance-Garantie für alle PDFs/Geräte |
| Passwortfehler / leerer Öffnungsschutz ohne Dokumentverlust | `search-import-smoke` und verschlüsselte AcroForm-Ableitung | Falsches Passwort und Abbruch erhalten vorheriges Dokument; öffentlicher KG1 mit leerem Öffnungspasswort wird tatsächlich entschlüsselt, nicht mit ignoreEncryption als Arbeitskopie geladen |
| Leere Textbox nicht exportieren | `smoke`, `exportPdf` | vorhanden |
| Suche inkl. eingefügter Textseiten / Overlays | `search-import-smoke`, `search` | Kein OCR; gerasterter Originaltext ist nicht suchbar |
| Optionale Komprimierung + Passwortschutz | `compression-smoke`, `compressPdf`, `unlockPdf`; Defaults aus, Sicherheits- und Abbruchpfade | Ersparnis dokumentabhängig, nicht garantiert |
| 1–2 zusätzlich eingebettete Open-Source-Fonts | **Nicht implementiert; dokumentiert zurückgestellt** | Aktuell PDF-Standardschriften. Native Formularwerte außerhalb deren Zeichensatz führen zu einer Fehlermeldung; Overlay-Text verwendet die bestehende Zeichenersetzung (z. B. `?`) für nicht unterstützte Glyphen. Kein behauptetes vollständiges Erfüllen der Font-Vorgabe. |

## Offene manuelle Freigabe

Automatisierte PDF.js-/pdf-lib-/PyMuPDF-Checks sind **keine** Acrobat- oder
macOS-Vorschau-Prüfung. Hier stehen diese Programme nicht zur Verfügung.

- [ ] In Acrobat: echte Formular-Exporte öffnen, Darstellung prüfen, Feld erneut
      ändern/speichern/öffnen; Overlay-Text markieren und kopieren.
- [ ] In macOS Vorschau: dieselben Exporte und geschützte/komprimierte Ausgaben
      öffnen; Layout, lesbare kleine Schrift, Passwort und Feldänderung prüfen.
- [ ] Im tatsächlichen Browser-PDF-Viewer (nicht nur Editor/PDF.js): Exporte öffnen,
      suchen/kopieren, falsches/richtiges Passwort, beide Komprimierungszustände.
- [ ] Einen unabhängig stammenden, nicht vertraulichen echten Scan durchspielen
      (kein OCR erwarten); Overlay ergänzen, exportieren und visuell prüfen.
- [ ] Schwärzungs-Export im Zielprogramm visuell prüfen und betroffene Geheimnisse
      per Suche/Kopieren prüfen; Original und Entwurf nicht weitergeben.
- [ ] Entscheidung zur dokumentiert zurückgestellten Open-Source-Font-Erweiterung.

T13 bleibt bis zur manuellen Freigabe **In Arbeit**. Ein grüner automatisierter
Lauf bedeutet nicht automatisch „alle MVP-Kriterien vollständig bestanden“.

## Befunde und Korrekturen

- `replaceRedactions` bewahrte beim ersten Undo einen ursprünglich nicht gesetzten
  Zustand nicht exakt (`undefined` wurde `[]`). Die vorherige Darstellung war
  gleich; jetzt wird der ursprüngliche Snapshot exakt wiederhergestellt. Der
  40-Schritte-Test prüft jeden Zustand statt nur das Endergebnis.
- Öffentliche PDFs mit Berechtigungsschutz und leerem Benutzerpasswort (echter
  KG1) öffnen jetzt ohne unnötige Passwortabfrage. Die Arbeitskopie wird **wirklich
  entschlüsselt**; nichtleere/falsche Passwörter bleiben geschützt. Regression
  mit vorhandener verschlüsselter Fixture plus realem KG1. W-9 enthält ebenfalls XFA; native Bearbeitung wird daher mit dem separaten Charakterbogen geprüft.
- Der Hinweis beim geschützten Import nennt jetzt den gemeinsamen Exportdialog
  und dessen „Mit Passwort schützen“-Option statt des entfernten T11-Buttons.
- Browserpfade verwenden eine gemeinsame Chromium-Erkennung mit geprüftem
  `CHROMIUM_PATH`, Playwright-Browser oder Systembrowser. Fixture-Dateipfade
  werden über `fileURLToPath` dekodiert (auch Windows/Laufwerksbuchstaben).
  **Windows selbst wurde hier nicht ausgeführt**; die Portabilitätskorrektur ist
  kein behaupteter Windows-Kompatibilitätstest.
- Der Repeat-Smoke traf beim Touch-Abbruch in die nach T12 höher geklemmte
  Formpalette statt aufs Papier. Nur die Testgeste wurde nach oben auf freie
  Papierfläche verschoben (gleiche Größe, gleicher mobiler Viewport). Hit-Test,
  echter Touch-Abbruch, Wiederholungs-, Undo-/Redo- und Auswahlassertions bleiben.
  Kein UI-Layout wurde dafür verändert.

## CI

`.github/workflows/mvp-qa.yml` führt für Pull Requests und `main` ausschließlich
`npm run qa:ci` aus: Runner-Regressionen, synthetische Fixtures, Kern-Tests, Lint,
Build und 20 synthetische Browser-Smokes (Node 22, Playwright-Chromium, Poppler).
Die unabhängige PyMuPDF-Prüfung des **synthetischen** passwortgeschützten und
geschwärzten Exports bleibt aktiv.

Auf Wunsch des Projekt-Owners sind öffentliche Real-PDF-Downloads, deren Cache,
Hashprüfung, Real-PDF-Smoke, Real-PDF-Produktionslauf und die zugehörigen
unabhängigen Real-PDF-Prüfer **nicht mehr Teil der CI**. Der Produktionsbuild
bleibt geprüft; eine Browserprüfung mit echten PDFs gegen diesen Build ist nun
manuell/lokal. Die betreffenden Skripte und Prüflisten bleiben erhalten.
Für automatisierte lokale Real-PDF-Prüfungen zuerst `npm run fixtures:real`, dann
`npm run qa` und die oben genannten unabhängigen Prüfer ausführen. Fehlende oder
veränderte Fixtures lassen diesen vollständigen lokalen Lauf weiterhin fehlschlagen.

Es werden nur Logs und Ergebnislisten als CI-Artefakte hochgeladen, **keine
Quell-PDFs oder exportierten Formulare**. Ausgeschlossene Real-PDF-Schritte werden
als NOT_RUN dokumentiert; grüne CI ist kein Nachweis für Echtdokument-Kompatibilität.
Der CI-Status ist separat vom lokalen Testergebnis zu betrachten.
