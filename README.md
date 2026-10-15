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
erhalten. Schriftwahl und Unicode sind durch die unterstützten Standardfonts
begrenzt; zusätzliche eingebettete Open-Source-Fonts sind noch offen.
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
