# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Privatleute**: füllen Formulare, Anträge und Verträge aus, unterschreiben und korrigieren sie, meist gelegentlich und ohne PDF-Fachwissen.
- **Büro und Selbstständige**: arbeiten regelmäßig mit Dokumenten. Sie kommentieren, schwärzen, korrigieren Text und exportieren Tabellen.

## Product Purpose

Ein PDF-Editor, der PDFs vollständig im Browser bearbeitet: Text, Formen, Bilder und Kommentare hinzufügen, Seiten organisieren, schwärzen, komprimieren, Tabellen extrahieren und vorhandenen Originaltext korrigieren. Er ist erfolgreich, wenn jemand ein Dokument fertig bearbeitet und exportiert, ohne es irgendwo hochzuladen.

## Positioning

- **Alles bleibt lokal**: kein Upload-Dienst, kein Konto. PDFs, Bearbeitungen und Entwürfe bleiben im Browser auf diesem Gerät.
- **Originaltext ändern**: Der vorhandene Text im PDF wird wirklich korrigiert, statt ihn nur mit einer neuen Textbox zu überdecken.

## Operating Context

- Statische Web-App, veröffentlicht auf GitHub Pages; kein Server.
- Echte, oft fremde PDFs: Formulare, gescannte Dokumente, große Dateien, verschlüsselte PDFs.
- Entwürfe werden lokal gespeichert. Sie sind **unverschlüsselt**, auch wenn das Original passwortgeschützt ist.

## Capabilities and Constraints

- Werkzeuge: Textboxen (verschieben, kopieren, drehen), Formen, Bilder, Kommentare, Schwärzen, Suche, Seitenverwaltung, Zuschnitt, Komprimierung, Tabellenexport, Originaltext-Korrektur, Passwortschutz.
- Die Originaltext-Korrektur lehnt Seiten ab, die sie nicht sicher ändern kann (z. B. Formular-PDFs, gedrehte oder zugeschnittene Seiten), und sagt warum.
- Technik: React, TypeScript, Vite, PDF.js, pdf-lib. Der Kern bleibt framework-frei (ADR-004), alle Änderungen laufen über den Befehlsstapel (ADR-002).
- **Offen:** Die Oberfläche ist derzeit nur deutsch. Englisch ist gefordert, eine Übersetzungsschicht gibt es noch nicht.

## Evidence on Hand

- QA- und Feature-Dokumentation in `docs/` (z. B. `T13-QA-RESULTS.md`, `t16-source-text.md`).
- Keine Testimonials, Nutzerzahlen oder Pressestimmen vorhanden; diese dürfen nicht erfunden werden.

## Product Principles

1. Daten verlassen nie das Gerät; jede Funktion muss ohne Server auskommen.
2. Ehrlich über Grenzen: lieber klar ablehnen und begründen als ein Dokument still verfälschen.
3. Gelegentliche Nutzer kommen ohne Einarbeitung zurecht, Vielnutzer werden nicht ausgebremst.
4. Jede Bearbeitung ist rückgängig zu machen.

## Accessibility & Inclusion

- Sprachen: Deutsch und Englisch.
- Muss auf dem Handy nutzbar sein (bis 390 px Breite).
- Tastaturbedienung und Screenreader-Unterstützung sind Pflicht.
