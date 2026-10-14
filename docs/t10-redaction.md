# T10 — page-raster redaction

The chosen UI is a redaction tool with a compact action bar. Areas are pending,
not secure, until the user confirms application. Move and four-corner resize are
undoable. White areas create empty **ordinary** textboxes using approximate
PDF.js font family, size, baseline and rotation; no original text is copied into
those boxes. Normal formatting, editing and later PDF text export still apply.

## Export boundary

- Render the current affected page, including native values and existing overlays,
  at 300 dpi. Apply outward-rounded opaque masks to the canvas, then encode PNG.
- Write those pixels into a fresh image-only PDF source. Do not copy the affected
  original page's content streams, annotations, widgets or metadata.
- Old additions and fields on an affected page become pixels. Other pages retain
  vector content and visible native fields; replacement text is still real text.
- Secure composition prunes unused resources, document/auxiliary metadata,
  navigation/actions and nonvisual form values. It rejects unresolved resources,
  unsupported content syntax (including inline-image parsing), omitted-page
  references and original image/form objects shared with retained pages.
- Preflight the full composition before publishing the atomic undoable change.
  A page above 32 million raster pixels fails rather than silently reducing DPI.
- Keep secure export enabled across extraction, deletion, A4 conversion, save and
  reload, including when the last rasterized page was deleted.

This is **page-scoped**, not an automatic search for every occurrence of private
information. Contents on unredacted pages remain, including other occurrences of
private data. The user must inspect the exported document. Original files,
IndexedDB drafts and local undo history remain confidential and may retain the
original data. Only the checked export should be shared. This implementation has
regression tests and a same-agent code review, not an independent security audit
or a guarantee for arbitrary malformed PDFs. Unsupported structures fail closed.

## Checks

```sh
npm test
npm run lint
npm run build
SMOKE_URL=http://localhost:5220 node scripts/redaction-smoke.mjs
SMOKE_URL=http://localhost:5220 node scripts/redaction-geometry-smoke.mjs
```

The real Chromium checks inspect exports independently with PDF.js and pdf-lib:
text extraction, opaque mask pixels, vector content and native fields on the
other page; normal replacement textbox, all corner grips, moving/cancel, grouped
undo, durable drafts, confirmation and mobile light/dark layout. Literal geometry
checks cover 0/90/180/270 rotation, nonzero crop origin and UserUnit 2, including
replacement text baseline/size/rotation. Core tests exercise unused nested
resources, omitted-page links, nonvisual fields, font metadata, shared images,
subset export and the persisted secure-mode flag.
