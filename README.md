# PDF-Editor

Clientseitiger PDF-Editor mit React, TypeScript und Vite, PDF.js und pdf-lib.
PDF-Dateien, Bearbeitungen und Entwürfe bleiben im Browser auf diesem Gerät;
es gibt keinen Upload-Dienst. Lokale Arbeitskopien und Entwürfe sind
**unverschlüsselt**, auch wenn das Original oder der Export passwortgeschützt ist.

## Lokal starten

```sh
npm ci
npm run dev
```

Die von Vite unterstützte Node-Version verwenden (die CI verwendet Node 22).
Nach einem Git-Update mit geänderten Abhängigkeiten erneut `npm ci` ausführen.
Für einen lokalen Produktionsbuild:

```sh
npm run build
npm run preview
```

## Auf GitHub Pages veröffentlichen

Die App benötigt nur statisches Hosting. Für dieses Repository lautet die
Projektadresse: <https://evolving-thoughts.github.io/pdf-editor/>.

Einmalige Einrichtung durch einen Repository-Admin:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions** wählen.
2. Den Deployment-PR nach `main` mergen. Unter **Actions → Deploy GitHub Pages**
   den Build und anschließend das Deployment prüfen.
3. Falls Pages erst nach dem Merge aktiviert wurde: denselben Workflow über
   **Run workflow** auf `main` erneut starten. Unter **Settings → Pages** steht
   nach erfolgreicher Veröffentlichung die Website-Adresse.

Kein `gh-pages`-Branch, eigener Server oder persönlicher Token als Secret nötig.
Der Workflow nutzt den kurzlebigen `GITHUB_TOKEN` mit `pages: write` und
`id-token: write` ausschließlich im Deployment-Job. Falls die Organisation
Actions oder das Environment `github-pages` einschränkt, muss ein Admin die
entsprechenden Freigaben erteilen. Die Website wird nach der Veröffentlichung
öffentlich erreichbar; das öffentliche Repository allein aktiviert Pages nicht.

`npm run build:pages` baut mit Vites `--base=/pdf-editor/`. Der normale Build,
`npm run dev` und die bestehende QA behalten `/` als Basis. Vite schreibt damit
auch die Pfade für Favicon, Styles, PDF.js-Worker und nachgeladene Module passend
zum Projekt-Unterpfad um. Bei einem anderen Repository-Namen den Pages-Buildpfad
und den Unterpfad im Produktionstest anpassen; für eine eigene Domain direkt
unter `/` stattdessen den normalen Build verwenden.

Der Workflow prüft Pull Requests mit Lint, Unit-Tests, Pages-Build und einem
synthetischen Produktions-Smoke. **Nur `main` wird veröffentlicht**, nie ein PR.
Der Smoke serviert ausschließlich `dist` unter `/pdf-editor/`, ohne Vite-Devserver
oder Source-Modul-Fallback, und prüft unter anderem PDF-Worker, Text-Export und
Passwortfunktionen. Die bestehende MVP-QA bleibt separat unverändert; es werden
keine externen Echtdokumente für das Deployment geladen.

Lokal prüfen:

```sh
npm ci
npx playwright install chromium
npm run build:pages
npm run test:pages
```

Der Smoke startet seinen eigenen lokalen statischen Server und beendet ihn
anschließend. Zum manuellen Ausprobieren nach dem Pages-Build:

```sh
npm run preview -- --base=/pdf-editor/
```

Dann `/pdf-editor/` an der von Vite angezeigten Adresse öffnen. Die öffentliche
Seite nach dem ersten Deployment ebenfalls kurz prüfen; die lokale Simulation
ersetzt keinen Test der GitHub-Einstellungen oder der echten HTTPS-Adresse.

PDF-Verarbeitung bleibt clientseitig; das Hosting erhält keine PDF-Uploads von
der App. Normale Website-Zugriffe können beim Hosting protokolliert werden.
Entwürfe bleiben unverschlüsselt im Browserspeicher der jeweiligen Website und
werden nicht von `localhost` auf die öffentliche Adresse übertragen. Derselbe
Origin wird von mehreren GitHub-Projektseiten eines Owners geteilt; ein URL-Pfad
ist keine zusätzliche Sicherheitsgrenze für Browser-Speicher.

## Bedienung

Die Oberfläche trennt Dateiaktionen und Navigation von den Bearbeitungswerkzeugen:

- **Obere Leiste:** PDF öffnen, Entwürfe, Speichern, Seiten verwalten, Suchen,
  Zoom, Rückgängig/Wiederholen und Exportieren. „Speichern“ sichert den lokalen
  Entwurf; „Exportieren“ erstellt eine PDF-Datei.
- **Werkzeugleiste darunter:** Einfügen und Auswählen (Auswahl, Text, Bild,
  Symbole), Zeichnen (Stift, Radierer, Textmarker), Formen (Rechteck, Ellipse,
  Linie, Pfeil) und Vertraulich (Schwärzen).
- **Unterer Rand:** Formularfelder hervorheben, sofern vorhanden, und Zeichnung
  löschen. Letzteres entfernt Freihandstriche und Textmarker auf allen Seiten,
  nicht Texte, Bilder oder andere Formen; die Aktion ist rückgängig machbar.

Auf schmalen Bildschirmen umbrechen die Gruppen. Die Werkzeugoptionen erscheinen
weiterhin kontextbezogen in den vorhandenen verschiebbaren Paletten bzw. an der
Textbox. In der Seitenverwaltung sind die Bearbeitungswerkzeuge ausgeblendet.

### Vorhandene Funktionen

- PDF per Dateiauswahl oder Drag & Drop öffnen; passwortgeschützte PDFs
  entsperren. Bilder (PNG/JPG) auf eine Dokumentseite ziehen oder einfügen.
- Zusätzlichen Text, Symbole, Bilder, Zeichnungen und Formen platzieren.
  Bestehende PDF-Texte werden **nicht wie in Word direkt editiert**; Korrekturen
  sind zusätzliche Elemente über dem Original.
- Unterstützte AcroForm-Felder direkt im Dokument ausfüllen; zusätzliche
  Textboxen und native Felder gemeinsam verwenden. Native Felder bleiben im
  Export editierbar, soweit sie nicht durch Schwärzung gerastert wurden.
- Seiten einfügen, drehen, verschieben (auch per Drag & Drop), löschen,
  zuschneiden, extrahieren und optional auf A4 bringen. Checkboxen wählen
  mehrere Seiten; Shift+Klick wählt einen Bereich, Strg/⌘+Klick ergänzt oder
  entfernt einzelne Seiten. Einzelne Aktionen sind bewusst auf eine Seite
  begrenzt; „Alle Seiten auf A4“ gilt unabhängig von der Auswahl.
- Dokumentweit suchen, auch in eingefügten Textseiten und zusätzlichen
  Textboxen. Bild-/Scanseiten liefern ohne Textschicht keine Originaltext-Treffer;
  es gibt **keine OCR**.
- Änderungen rückgängig machen/wiederholen. Automatische Entwürfe liegen in
  IndexedDB; die Undo-Historie gilt für die aktuelle Sitzung.

### Echte Schwärzung und Export

Schwärzungsbereiche sind zunächst nur vorgemerkt. Vor dem Anwenden können sie
verschoben und an den vier Ecken skaliert werden. Erst das bestätigte Anwenden
baut die **betroffenen Seiten als Bilder** neu auf und entfernt deren
Originaltext/Formularobjekte. Diese Seiten sind danach nicht mehr durchsuchbar;
neuer Overlay-Text bleibt echter PDF-Text. Nicht betroffene Seiten bleiben
vektorbasiert. Originaldatei, lokale Entwürfe und Undo können weiterhin vertrauliche
Inhalte enthalten: **Nur die geprüfte exportierte Kopie weitergeben.**

„Exportieren“ öffnet einen gemeinsamen Dialog:

- Bilddaten komprimieren: optional, standardmäßig **aus**. Qualitätsstufen
  reduzieren geeignete Bilddaten; Text, Vektoren und Formularfelder werden nicht
  allein für die Komprimierung gerastert. Einsparung und Lesbarkeit hängen vom
  Dokument ab; transparente/nicht unterstützte Bilder bleiben unverändert.
- Mit Passwort schützen: optional, standardmäßig **aus**, AES-256. Das
  Export-Passwort wird nicht im Entwurf gespeichert. Passwortschutz verschlüsselt
  nur die exportierte Datei, nicht die lokale Arbeitskopie.

### Tastatur

- **Strg/⌘+F:** Dokument-Suchfenster öffnen.
- **Enter / Shift+Enter im Suchfeld:** nächster/vorheriger Treffer.
- **Escape:** Suche schließen bzw. aktive Bearbeitung/Auswahl beenden.
- **Strg/⌘+Z:** Rückgängig; **Strg/⌘+Y** bzw. **Strg/⌘+Shift+Z:** Wiederholen.
  Während der Texteingabe bleibt die native Textbearbeitung erhalten.

## Grenzen

XFA-Bearbeitung, PDF-JavaScript, Formularberechnungen, OCR und neue kryptografische
Signaturen gehören nicht zum MVP. Nicht unterstützte Formularbestandteile werden
nicht ausgeführt; vorhandene XFA-Daten werden, soweit vom Exportpfad unterstützt,
erhalten. Neben Helvetica, Times und Courier stehen **Noto Sans**, **Noto Serif**,
**Carlito**, **Lato**, **EB Garamond**, **Roboto Mono** und **Caveat** zur Verfügung.
Alle bieten Normal und Fett; bis auf Caveat auch Kursiv und Fett-Kursiv.
Caveat hat keinen nativen kursiven Schnitt: Beim Wechsel zu Caveat wird Kursiv
im selben Undo-Schritt ausgeschaltet, und die Kursiv-Schaltfläche ist deaktiviert.
Die Latin-Schriften (inklusive deutscher Umlaute und ß) werden über die
Fontsource-Pakete lokal gebündelt. Alle sieben Fontsource-Schriftfamilien stehen
unter der **SIL Open Font License 1.1**; die unveränderten Copyright- und
Lizenztexte liegen unter [public/licenses/fonts](public/licenses/fonts) und
werden im statischen Build unter `licenses/fonts/` mit ausgeliefert.
Die OFL erlaubt auch kommerzielle Nutzung, Software-Bündelung und
PDF-Einbettung unter Beachtung ihrer Bedingungen. Erstellte PDF-Dokumente
müssen dadurch nicht selbst unter die OFL gestellt werden.
Browser-Vorschau und PDF-Export verwenden dieselben WOFF-Dateien; im PDF werden
nur die benötigten Glyphen eingebettet. Es gibt keine Google-Fonts-Anfragen.
Andere Schriftsysteme sind damit nicht abgedeckt; die Standardfonts bleiben
auf ihre bisherige Zeichenauswahl beschränkt.
Kompatibilität mit Acrobat, macOS Vorschau und eigenen realen Dokumenten bitte
anhand der [manuellen Prüfliste](docs/T13-MVP-QA.md) prüfen.

## Tests und QA

```sh
npm test
npm run lint
npm run build
```

Für denselben synthetischen Browser-Testumfang wie in der CI:

```sh
npx playwright install chromium
npm run qa:ci
```

Zusätzlich benötigt `pages-edges-smoke` **Poppler (`pdftotext`) im PATH**.
`CHROMIUM_PATH` kann alternativ auf einen installierten Chromium zeigen.
Der Runner startet einen eigenen lokalen Dev-Server auf Port 5234, führt die
Smokes nacheinander aus und schreibt Logs, PDF-Ausgaben sowie `results.json` und
`results.md` nach `qa-artifacts/`. Ein Fehler ergibt einen Exit-Code ungleich null;
der Server wird anschließend beendet. Die CI prüft außerdem synthetische
passwortgeschützte/sicher geschwärzte Exporte unabhängig mit PyMuPDF.

**Echte PDFs werden nicht in der CI heruntergeladen oder geprüft.** Der optionale
vollständige lokale Lauf bleibt verfügbar:

```sh
npm run fixtures:real
npm run qa
```

`fixtures:real` lädt öffentliche leere Formulare herunter und prüft deren SHA-256.
`qa` verlangt gültige lokale Fixtures und prüft sie zusätzlich im Produktionsbundle
(Port 5235). Fixtures und QA-Artefakte sind nicht im Repository. Details,
unabhängige Prüfbefehle und offene manuelle Kriterien:
[docs/T13-MVP-QA.md](docs/T13-MVP-QA.md).

### Seitenwahl und Zuschnitt

Ein normaler Klick auf einen Seiteneintrag zeigt die Seite an und wählt sie
allein für Aktionen aus. Checkboxen und Strg/⌘+Klick ändern einzelne Einträge,
Shift+Klick wählt einen Bereich. Die Checkboxen bleiben sichtbar.
Beim Zuschneiden nutzt das Formular die Seitenleiste ohne die übliche
50%-Höhenbegrenzung; die Seitenliste wird dafür vorübergehend ausgeblendet.
Die Vorschau behält die Größe der unbeschnittenen Seite als Maßstabsreferenz
(auch bei weiterem Zuschnitt, Undo/Redo und gespeicherten Entwürfen).
Ein reiner Zuschnitt oben/unten verändert nicht die physische Breite im Export.
Das stärkste Bildkompressions-Preset heißt **Maximale Kompression**;
Qualität und Auflösungsgrenzen bleiben unverändert.
Die Eckgriffe beim Zuschneiden und Schwärzen zeigen wie beim Textmarker nur
8 × 8 px große Kästchen; die unsichtbare Trefferfläche bleibt 44 × 44 px groß.
