# T12 — Optional PDF export compression

## Approved UI

Variant A: one **Exportieren** button opens a shared export dialog. Both **Bilddaten komprimieren** and **Mit Passwort schützen** start unchecked on every opening. The previous standalone protected-export button/component is removed. Presets and passwords are dialog-local, never editor state, drafts or localStorage.

With compression off the ordinary T11 export pipeline is used without image changes. With compression on the dialog prepares a frozen export and displays measured file sizes (before optional encryption), changed/unchanged/failed image counts and a no-saving message when appropriate. Users can save the smaller output, explicitly choose the prepared original-size output, return to settings or cancel. Password confirmation is required before preparation. Encryption happens after the output is selected; an encryption error never causes an unprotected download.

## Implementation and boundaries

- Client-side only; no new package, server or upload.
- `compressPdf` optimizes opaque, ordinary 8-bit DeviceRGB/DeviceGray image XObjects. Flate pixel data and ordinary DCT JPEGs are supported. Image encoding is injected; the browser adapter downsamples with Canvas and offers JPEG plus raw RGB pixels.
- Longest image edge is capped at 2400 / 1800 / 1200 pixels for high / balanced / small. JPEG quality is 0.90 / 0.80 / 0.65. Smaller images are never upscaled. These are image dimensions, not fixed document DPI or guaranteed file-size targets.
- For each image, choose the smaller of JPEG and deflated RGB pixels; only replace it if its encoded stream is smaller. If the entire saved PDF is not smaller, return the exact original prepared bytes. Simple text scans can already be efficiently compressed and may provide little or no saving.
- Do **not** rasterize text, vectors, native form widgets or whole PDF pages for compression. Retain image resource references, page transforms, metadata and form appearances. Replacement overlays remain true searchable PDF text.
- Transparent/masked images, ICC/CMYK/indexed color, Decode mappings/predictors, inline images, JPEG EXIF/ICC metadata and images above 16 megapixels are left untouched rather than guessed. Tiny image objects are also skipped. The UI discloses unsupported types and unchanged images; individual failures are reported.
- Redaction sanitization runs first in the existing export pipeline. Compression only receives the sanitized export, not original draft sources. It cannot reintroduce omitted source streams. Applied redaction's source/history remains local and confidential as before.
- Operations are sequential. Cancellation is checked around loading, encoding, saving and encryption. Cancelling cannot download a late result. Original sources, Undo/Redo and persisted drafts are unchanged.

## Checks

```sh
npm ci
npm test
npm run lint
npm run build
npm run dev -- --host 127.0.0.1 --port 5221
# In another terminal, with Chromium available:
SMOKE_URL=http://localhost:5221 node scripts/compression-smoke.mjs
SMOKE_URL=http://localhost:5221 node scripts/acroform-smoke.mjs
SMOKE_URL=http://localhost:5221 node scripts/redaction-smoke.mjs
SMOKE_URL=http://localhost:5221 node scripts/search-import-smoke.mjs
```

The regression smoke scripts now explicitly confirm default export in the shared dialog. Unit tests cover sizing, exact no-saving fallback, supported/unsupported streams, JPEG vs lossless selection, source immutability, text/form preservation and cancellation. The browser smoke uses synthetic image-heavy PDFs, actual Canvas encoding, PDF.js readback, AES-256 roundtrip, real redaction and post-redaction replacement text. It also checks unchanged IndexedDB records, default resets and mobile light/dark layout.

## Manual quality review

Use a representative real PDF with fine print, signatures and scanned photos. Compare all three presets with the uncompressed export at normal size and high zoom. Check text search and native field editability in another viewer. Inspect applied black/white redactions and ensure only the checked export is shared. No automated size or pixel test can establish that every document remains acceptably legible; users must review lossy outputs.

## Known unrelated regression observed during validation

`shapes-smoke.mjs` completes its desktop creation/edit/export/render checks, then fails its mobile rotation-grip visibility precondition. The movable shape palette covers that grip in the small workspace. The **same** assertion failure was reproduced on the unchanged merged T11 `main` baseline (`6e85b805`), using its unmodified script and app. This is not fixed by T12; the shared export confirmation changes do not cause it. T8 thumbnails, T9 forms, T10 redaction, T11 search/import/protected export and image-export regression suites passed.
