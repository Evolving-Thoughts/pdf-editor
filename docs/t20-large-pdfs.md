# T20: Große PDFs

## Anzeige

- `VirtualPage` hält für jede Seite ihren Platz im Scrollbereich. Eine Leinwand gibt es nur für Seiten, die höchstens eine Fensterhöhe vom sichtbaren Bereich entfernt sind.
- Die Größe des Platzhalters kommt aus dem Seitenmodell, nicht aus PDF.js. Die Scrollhöhe hängt deshalb nicht davon ab, welche Seiten gerade geladen sind.
- Platzhalter tragen ebenfalls `.page[data-page-index]`, damit Suchsprünge, Seitenerkennung und Rücksprünge sie finden.
- Eine Seite bleibt geladen, solange ein Overlay darauf ausgewählt ist oder der Fokus darin liegt. Overlays und Formularwerte liegen im Store und gehen beim Entladen nicht verloren.
- `RenderQueue` begrenzt pro Dokument die parallelen Renders auf 3. Abgebrochene Arbeit verlässt die Warteschlange, laufende Arbeit wird in PDF.js abgebrochen, und `destroy()` leert die Warteschlange.
- `renderStats()` macht die Last messbar. Die Canvas-Grenzen aus `renderBudget.ts` und das Lazy-Rendering der Miniaturen bleiben unverändert.

## Grenzwerte

| Grenze | Wert | Geprüft in |
| --- | --- | --- |
| Datei | 512 MiB | `assertFileBudget`, vor dem Einlesen |
| Seiten im Dokument | 5.000 | `assertPageBudget`, in `inspectPages` und `insertPages` |
| Summe aller angehängten Quellen | 1.024 MiB | `assertSourceBudget`, in `insertPages` |

Überschreitungen werden mit den konkreten Zahlen abgelehnt. Der bisherige Stand bleibt offen.

Die Werte sind vorsichtige Betriebsgrenzen und kein Leistungsversprechen: Bilder, Schriften und Transparenzen kosten je nach PDF deutlich mehr als die Seitenzahl.

## Messungen

Synthetische PDFs mit einer Textzeile pro Seite, Chromium 153, 1280 × 900, Dev-Server, Windows 11.

| PDF | Größe | Öffnen bis erste Seite sichtbar | Leinwände gleichzeitig | Sprung um die halbe Dokumentlänge |
| --- | --- | --- | --- | --- |
| 400 Seiten | klein | 1,4 s | höchstens 4, auch bei schnellem Scrollen | nicht gemessen |
| 5.000 Seiten | 0,97 MiB | 2,7 s | 2 bis 3 | 15 ms |

`scripts/large-document-smoke.mjs` prüft das regelmäßig: Leinwände beim schnellen Scrollen, stabile Scrollhöhe, Suchsprung auf einen Platzhalter, erhaltene Textbox, Dokumentwechsel und Ablehnung von 5.001 Seiten. Die Grenzen für Dateigröße und Quellensumme sind aus den Kopien im Arbeitsspeicher abgeleitet (PDF.js, Entwurf, Export), nicht mit Dateien dieser Größe gemessen.
