# T14 – Toolbar, README und gezieltes Aufräumen

## Grundlage und Entscheidung

Basis: `main` nach PR #13, Commit `6b5cacdde5614a0abc3b400719f2f98613db7679`.
Der Owner hat nach drei visuellen Prototypen **Variante A** gewählt: zwei
geordnete Leisten oben. Keine neue Werkzeugfunktion und kein neues Bedienmodell
für PDF-Inhalte, Formulare, Export oder Entwürfe.

## Umsetzung

- Erste Zeile: Dateiaktionen und Dokumentname, Seitenverwaltung/Suche/Zoom,
  Undo/Redo und Export. Der Editor nutzt maximal 1440 statt 1126 Pixel, damit
  die Werkzeuggruppen auf breiten Bildschirmen gemeinsam Platz finden.
- Zweite Zeile: Einfügen und Auswählen, Zeichnen, Formen, Vertraulich. Alle
  Werkzeuge bleiben direkt sichtbar; keine neuen Kategorien-Menüs/Tabs.
- Native Feldhervorhebung liegt bei vorhandenen Feldern am unteren Rand neben
  der vorhandenen Aktion „Zeichnung löschen“. Der Zustand und die Handler
  bleiben im App-Owner; nichts wird in lokalen Entwürfen neu gespeichert.
- Kleine Bildschirme: dieselben Gruppen umbrechen, Touch-Ziele bleiben
  mindestens 44 Pixel hoch. Formen und Schwärzen stehen mobil nebeneinander,
  damit Bildoptionen nicht den mittigen Touch-Treffpunkt verdecken. Entwürfe-Menü auf schmalen Bildschirmen innerhalb
  des Viewports; Symbol-Popover rechtsbündig. Keine horizontal scrollende
  Werkzeugleiste, die Menüs abschneiden würde.
- Dropdown-Markierungen sind CSS-Chevrons, Undo/Redo SVG statt plattformabhängiger
  Emoji-Darstellung. Accessible Names und bestehende Shortcuts bleiben erhalten.
- Dateiaktionen/Tools bleiben während Export/Öffnen/Schwärzung wie zuvor inert;
  die bisherigen Disabled-/Pressed-Bedingungen bleiben erhalten.
- README erklärt Bedienung, lokale Speicherung, Export-/Schwärzungsgrenzen,
  Passwortschutz/Komprimierung, Tastatur und optionale Echtdokument-QA.

## Codebase-Entscheidung und Aufräumprüfung

Die vorhandene Trennung bleibt: `App` besitzt Zustand/Handler; `tools.ts` die
Formwerkzeuge; `DraftsMenu`, `SymbolPicker`, `SearchWindow`, `DrawingToolbar`,
`ShapeToolbar`, `RedactionBar` und `ExportDialog` ihre bisherigen Funktionen.
Der neue Layout-Rahmen besteht nur aus JSX-Gruppen/CSS. Ein lokaler
`shapeToolButton`-Renderer verwendet denselben Handler für Textmarker und Formen
in getrennten visuellen Gruppen. Kein Command-Bus, neue Persistenz oder redundante
Toolbar-Zustände nötig. Die Alternative eines extrahierten Toolbar-Controllers
würde hier umfangreiche Props für bereits koordinierte App-Aktionen erzeugen,
ohne eine zweite Verwendung oder neue Verantwortlichkeit.

Entfernt nach Referenzsuche: `--social-bg` (hell/dunkel), `#social .button-icon`,
`.counter`-Demo-Selektor und `.separator`, dessen einzige Aufrufer durch die
Werkzeuggruppen ersetzt wurden. Kern-Code, öffentlich exportierte Hilfsfunktionen,
Tests, QA-Skripte und kompatibilitätsrelevante PDF-Pfade werden nicht allein wegen
fehlender unmittelbarer Nutzung gelöscht. Unreferenzierte Demo-Symbole in
`public/icons.svg` sind ein möglicher späterer Asset-Cleanup, kein Risiko für die
aktuelle Toolbar; die Datei bleibt in diesem begrenzten Refactor unverändert.

## Prüfgrenzen

`editor-layout-smoke` prüft die beobachtbare Gruppierung, eine gemeinsame
Desktop-Werkzeugzeile, 1440/1280/1024/768/390/320 Pixel Breite, sichtbare Controls,
44-Pixel-Ziele, Entwürfe/Symbole-Popover und vorhandene Einstiegspunkte für
Suche, Seitenverwaltung und Export mit unveränderten Standardoptionen.
Er läuft zusätzlich zu allen bisherigen synthetischen Smokes in `qa:ci`.

Echte PDFs bleiben entsprechend der Owner-Entscheidung optional/lokal.
Acrobat, macOS Vorschau und ein physisches Touch-Gerät werden hier nicht als
geprüft behauptet. Der neue GitHub-CI-Lauf ist unabhängig vom lokalen Resultat.

## Lokale Verifikation und abschließendes Review

Finaler stabiler Quellstand: **26/26 ausgeführte QA-Schritte bestanden**,
inklusive 31 Vitest-Suites / **238 Tests**, vier Runner-Regressionstests, Lint,
Build und **21 synthetischen Browser-Smokes**. Die drei Echtdokument-Schritte
bleiben ausdrücklich NOT_RUN. Browser: Playwright Chromium 156.0.8078.4;
zusätzlich DejaVu Sans als bestätigte system-ui-Schrift für Ubuntu-ähnliche
Schriftmetriken. Der unabhängige PyMuPDF-Prüfer bestätigte AES-256/R6,
editierbare Formularwerte sowie erhaltenen öffentlichen/Ersatztext und entfernte
Geheimtexte in den synthetischen Exporten.

Der neue Layout-Smoke prüft zusätzlich 390/320 × 844, den Footer-Schalter für
eine synthetische AcroForm und unveränderte Feldwerte nach Highlight-Toggle.
Die bestehende mobile Bildgeste ist unverändert; vor ihrem Touch-Start wird
zusätzlich geprüft, dass tatsächlich das Bild und kein Optionenfeld getroffen
wird. Diese Prüfung reproduzierte eine Überdeckung beim zunächst zu hohen
mobilen Toolbar-Layout. Die responsive Anordnung/Zeilenabstände wurden korrigiert,
ohne Touch-Ziele zu verkleinern oder Geste/Fixture/Erwartungswerte zu verschieben.

Zweitpass durch denselben Agenten (keine unabhängige Audit-Behauptung): alle
bisherigen Toolbar-Handler, Disabled-/Pressed-Bedingungen und Change-Handler
gegen die Basis verglichen; PDF-/Persistenz-/Schwärzungs-Kern unverändert.
Diff inklusive neuer Test-/Dokumentationsdateien gelesen, `git diff --check`
sauber. Im geprüften Scope keine verbleibenden blockierenden Findings.
Große Build-Chunks bleiben eine bereits bestehende Vite-Warnung; kein
Code-Splitting- oder Architektur-Umbau Teil dieses Tickets.

Zugehöriger Pull Request: [PR #14](https://github.com/Evolving-Thoughts/pdf-editor/pull/14).
Der Ticket-Abschluss erfolgt nicht automatisch.


## Ergänzung – kompakte Seitenverwaltung (Variante A)

Nach drei statischen Entwürfen hat der Owner auch für die Seitenverwaltung
Variante A gewählt. Die sechs Seitenaktionen stehen nun in einem
3-spaltigen Raster mit zwei Reihen. Auswahlaktionen bleiben darüber,
„Für alle Seiten“ und die A4-Aktion stehen kompakt nebeneinander.
Die Sidebar wird auf breiten Fenstern bis 432 Pixel breit; mobil bleibt sie
innerhalb des Viewports. Alle neun Aktionsbuttons bleiben vorhanden.

Mindestens die Hälfte der Panelhöhe bleibt für die separat scrollbare
Seitenliste reserviert. Bei kurzen Fenstern, langen Statusmeldungen oder
aufgeklappten Formularhinweisen kann der obere Kontrollbereich unabhängig
scrollen; Aktionen werden nicht entfernt. Die Aktionsbuttons bleiben mindestens
44 Pixel hoch. Checkboxen, Vorschau, Verschieben und ihre bisherigen Handler
bleiben unverändert; ebenso sämtliche Disabled-Bedingungen und Seitenoperationen.
Der vollständige Vergleich von `PagesManager.tsx` gegen den bisherigen PR-Stand
zeigt ausschließlich eine zusätzliche Grid-Klasse und das sichtbare Wort
„drehen“ an den beiden Rotationsbuttons.

`pages-selection-smoke` prüft zusätzlich 1440×960, 1280×944, 1024×768,
390×844 und 320×844: mindestens 50 % Listenhöhe, alle neun Aktionen erreichbar,
drei Spalten in zwei Aktionsreihen, 44-Pixel-Aktionsziele und unabhängiges
Listenscrolling. Die bestehenden funktionalen Prüfungen für Auswahl,
Drehung, Löschen, Extraktion, Undo/Redo und gespeicherte Entwürfe bleiben aktiv.
Dunkle Desktop- sowie helle Desktop-/Mobilansichten wurden visuell geprüft.

Erneute lokale Verifikation nach der Sidebar-Anpassung: `npm run qa:ci`
mit **26 PASS, 0 FAIL und 3 NOT_RUN**, darunter **238 Vitest-Tests**,
Lint, Build und alle **21 synthetischen Browser-Smokes**. Browser diesmal:
Chromium 153.0.8010.12 mit DejaVu-Sans-Fontkonfiguration. Der unabhängige
PyMuPDF-Exportcheck ist ebenfalls bestanden. Kein neuer GitHub-CI-Erfolg
oder Test auf physischen Mobilgeräten wird damit behauptet.

Der Review-Hinweis zur veralteten Lieferstatus-Notiz ist adressiert: Statt
„nicht gepusht / kein PR“ verweist die Dokumentation neutral auf PR #14.
