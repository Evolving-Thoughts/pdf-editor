# T16 — bounded original-text corrections (DE/EN)

Base: `origin/main` at `efccee4215164444de248e2d1a119b79484fb5e3`.
Branch: `feat/t16-source-text-corrections`.

## User workflow (inline editor)

Open **Textkorrektur** (accessible name: **Originaltext korrigieren**). The page
is rendered with PDF.js; every proved paragraph has a solid outline, text that
can only be corrected as a single fragment a dashed one, and unproved text is
dimmed (click for the reason).

- **Click into a paragraph** and the caret lands at the click point; a mouse
  drag inside one paragraph opens it with that range selected; Tab + Enter opens
  it with the caret at the end. The original lines are masked with the page
  background sampled from the canvas, and the live layout is drawn **in place**
  with the font's own glyph outlines (SVG paths from the embedded program; a
  CSS family with the exact PDF advances for unembedded standard fonts).
- A hidden textarea carries typing, IME, clipboard and undo of the browser;
  caret and selection are drawn on the page. Arrow keys, Shift selection,
  Home/End and Up/Down follow the visual lines. Enter inserts no hard break,
  Ctrl/Cmd+Enter checks, Esc leaves the paragraph.
- The **fit display** updates on every keystroke: `Passt · 3 → 4 Zeilen`, or a
  concrete reason (no free space below, page/clip edge, neighbour content, text
  under a link/highlight would move, a character missing from the original font —
  drawn as a red placeholder — or an unsupported character). Lines that do not
  fit are drawn in red.
- **Several paragraphs at once:** clicking another paragraph keeps the current
  change as an unchecked draft (still drawn in place with a green outline, click
  to continue editing it). The panel lists all changed paragraphs with their
  fit status and a × to discard one; **Alle Änderungen verwerfen** drops all.
  Esc leaves a paragraph and keeps its draft. The live fit of each paragraph
  takes the new line boxes of the other drafts into account. No discard prompt appears
  when switching paragraphs.
- **Undo before checking:** typing is grouped per word (new step at a space, a
  pause > 1 s or a paragraph switch; `draftHistory.ts`). The toolbar
  **Rückgängig/Wiederholen** and Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z step through the
  unchecked drafts first (including discarding); the document history is used
  again once nothing is pending.
- **In PDF prüfen** checks all drafts together in one candidate: the worker
  (`previewPageSources`) applies them top to bottom, re-analyzes the page after
  each paragraph and finds the next block again by text and first-line
  position; errors name the paragraph. It writes the change into a copy of the real PDF in the worker,
  re-analyzes and renders it. **Übernehmen** applies it (one undoable command),
  **Weiter bearbeiten** returns to the editor with the same text, **Original
  anzeigen** compares. There is no review checkbox or reflow confirmation for
  proved blocks; the real-PDF check is the gate.

The live layout runs the same code as the worker (`layoutEdit` in
`mixedBlocks.ts`, free-space rules in `space.ts`) on a serialized block model
(`editModel.ts`), so the display and the check agree: on 284 edits across the
local corpus (Chrome, Ghostscript, LibreOffice, ReportLab, a Spring/HTML-renderer
book PDF, a Thymeleaf course PDF) the fit display and the worker decided
identically in every case. Only the worker's verified candidate can be applied.

Fragments without a proved paragraph (and PDFs handled only by the older
single-stream adapter) keep the side-panel textarea; a multi-line paragraph of
that older adapter still needs its explicit reflow confirmation.

**Pages and speed:** the left panel shows page thumbnails (as in the page
manager, lazily rendered; a horizontal strip on narrow screens) below the
controls instead of a page dropdown. Pages render offscreen and the canvas is
swapped in; rendered pages (LRU 5), PDF.js document handles per buffer (LRU 6)
and successful analyses per buffer/page are cached, neighbour pages are
pre-rendered and pre-analyzed, and up to two idle workers are kept warm. On the
supplied Thymeleaf course PDF a page switch dropped from ~1–1.25 s to 5–50 ms
(dev server; ~10 ms in the production build); the analysis no longer clones the
paragraph model once per run (~2 MB less per page of the Spring book).

Apply changes only the selected page's source revision; copies of that page,
page geometry and unrelated state stay as before. Revisions persist through the
IndexedDB source store and normal export. Checking, comparing, cancelling and
rejections never modify the document or draft.

## Supported producers and content

- **Word** (fragment per word group, clipped BT/ET, absolute Tm), **LibreOffice**
  (tagged, one MCID per line; the structure element joins the lines), **Chrome /
  Skia**, **Ghostscript** (CFF), **ReportLab** (Type1, TrueType, justified text),
  **HTML renderers** such as the Spring book PDF (scaled page matrix, one Tj per
  character, pixel line grid, ActualText for ligatures and no-break spaces).
- Fonts: standard 14 WinAnsi, embedded TrueType/CIDFontType2 (Identity-H),
  one-byte TrueType, Type1 (PFB/PFA programs) and CFF/CIDFontType0C. Glyph
  widths, codes and Unicode mappings are proved from the program and ToUnicode;
  new characters are only taken from codes the subset actually contains.
- Layout: uniform scaling via CTM/Tm, justified text (natural spacing, then
  re-justified), soft hyphens and line-end word hyphens, first-line indent,
  contour wrap beside images (per-line left edges), TJ kerning of unchanged
  pairs, Tc/Tw, colour, ExtGState transparency, shadings, inline images,
  annotations and unsigned forms on the page.
- Deliberately locked (kept as obstacles, not editable): optional content
  (layers), soft masks, non-rectangular clips, text render modes other than
  fill, patterns, multi-code ActualText spans.
- Out of scope: scans/OCR, Type3, rotated/vertical text, complex scripts, text
  inside Form XObjects, signed or XFA PDFs, symbolic TrueType without Unicode
  meaning, characters outside the embedded subset.

## Guarantees

- Following paragraphs, images, graphics and annotations never move or change:
  after emission the page is re-analyzed and every non-member show (text, font,
  fill, position, advance) and every obstacle must be identical.
- Extra lines are only added into proved free space below the block with the
  contextual gap `max(3, min(original gap, leading / 2))` pt, inside MediaBox,
  CropBox, the original clip and any background box (with its margin).
- Existing lines keep origin and baseline; text under a link, highlight or
  underline keeps its exact position (otherwise the edit is refused).
- No shrinking, squeezing or substitute fonts; edits are atomic.

## Reconstructed source blocks

`mixedBlocks.ts` rebuilds a paragraph from its glyphs in page space. Fragments
join when they share font size, structure element / marked content, paint,
clip, CTM, text-matrix linear part and graphics state, with no painted content
or annotation between their lines; same-baseline fragments must be contiguous
within 0.12 × size (the residual becomes that pair's kern). Lines join with the
block leading (tolerance `max(0.05, 0.06 × size)`); a line end without a space
becomes a virtual space, a hyphen between lowercase letters a soft hyphen.
Greedy rewrapping must reproduce every original break, otherwise the block
splits (a two-line block whose first line stands alone becomes a heading).

On edit, glyphs are diffed; new characters take the style of the text they
replace. Wrapping restarts one line above the first change; unchanged following
lines keep their original glyphs. The block is emitted at its first member
(`Tm` per line, style runs, TJ kerning, ActualText spans re-emitted); every other
member show is replaced by an invisible show of the same advance and the text
state is restored, so operators between members keep their effect.

## Architecture and safety boundaries

- `encoding.ts`: immutable validated one-/two-byte original-font codec.
- `contentTokens.ts`, `streams.ts`: bounded lexer (literal/hex/inline images)
  and bounded Flate/LZW/ASCII filters.
- `fontReader.ts`, `fontTables.ts`, `type1.ts`, `sourceFonts.ts`: font program
  parsing (TrueType/CFF/Type1), widths, glyph boxes, outlines and CMap proofs.
- `mixedPdf.ts`: page interpreter, block offer, `previewBlock` emission and
  post-verification; `mixedBatch.ts`: several paragraphs of one page in one
  candidate (`previewPageSources`); `space.ts`: shared free-space rules.
- `mixedBlocks.ts`: block building, `layoutEdit`, `emitBlock`.
- `editModel.ts`: serializable block/font model for the UI (`liveFont`,
  `liveBlock`, `modelSpace`); `inlineLayout.ts`: caret stops, hit tests,
  selection rectangles, placeholders and the fit status.
- `InlineSourceEditor.tsx`: in-page editor (mask, SVG glyphs, caret, hidden
  textarea); `SourceTextSelection.tsx`: outlines and native selection;
  `SourceTextPanel.tsx`: analysis/check/apply flow and the fit display.
- `simplePdf.ts`, `layout.ts`, `directSelection.ts`: older single-stream adapter
  and fragment selection.
- `sourceText.worker.ts` / `client.ts`: one worker per job (up to two warm idle
  workers are reused; abort/timeout terminates), a 30-second deadline and a
  per-buffer analysis cache. `draftHistory.ts`: unchecked draft history;
  `sourcePdfCache.ts`: PDF.js handle cache. `revision.ts`: page source replacement as one command.

Bounds: input 16 MiB/200 pages; content streams 512 KiB compressed/decoded and
2 MiB decoded content per selected mixed page (legacy: total); 4096 legacy /
10,000 mixed source runs; 32 mixed fonts / 131,072 total mapped glyphs; 50,000 lexer tokens per stream;
4096 input characters/256 planned lines; font program 4 MiB; CMap 256 KiB;
CID/GID/width tables limited to 65,536 entries. Parser/font errors, stale revision
(SHA-256 + run ID + expected text), document/page/input changes, worker failure,
preview render failure and overflow prevent apply. Reopen and verify recognized
text/geometry before returning a candidate. Independent PDF.js extraction and
actual exported PDF roundtrips are covered by tests, not merely internal plans.

This is NOT secure redaction: originals remain in local undo/draft history and
this feature does not promise to purge matching words from metadata or archives.
It never just covers the old text with an overlay. No PDF/user text is sent to a
server; workers process local copied buffers.

## Validation

- 338 unit/integration tests, among them `tests/core/sourceReflow.test.ts`
  (model ↔ PDF layout agreement, HTML-renderer pages, ActualText NBSP, soft
  hyphens, links, obstacles, caret geometry, fit status) and
  `tests/core/mixedBlocks.test.ts` (Word-like fragments, batched multi-paragraph checks), `tests/core/draftHistory.test.ts`
  (draft undo/redo grouping) and a regression test for zero-width
  space-only font subsets (Word): characters whose glyph slots all have width 0
  are no longer insertable, so the same family's fallback subset is used
  (previously appending after a space drew overlapping glyphs).
- Browser smokes (all in `npm run qa:ci`): `source-text-smoke.mjs` (click/drag
  into the inline editor, caret keys, fit display, check, compare, apply, export,
  undo/redo, save/reopen, rejection, document switch, desktop/mobile, embedded
  subset outlines), `source-text-mixed-smoke.mjs` (tagged TJ source; optional
  local `SOURCE_TEXT_PDF`/`SOURCE_TEXT_FIND`/`SOURCE_TEXT_REPLACE`),
  `source-text-selection-smoke.mjs` (native drag, CropBox origin, zoom,
  two paragraphs checked together, toolbar/keyboard undo/redo of drafts, page
  thumbnails, keyboard/mobile, unproved text, stale candidate) and
  `source-text-blocks-smoke.mjs` (Word-like block, click-to-caret, gapless
  shortening).
- Supplied documents and their fonts are tested locally only and are NOT in the
  repository.

This is NOT secure redaction: originals remain in local undo/draft history. No
PDF or user text leaves the device; workers process local copies.
