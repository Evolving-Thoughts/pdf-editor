# T16 — bounded original-text corrections (DE/EN)

Base: `origin/main` at `efccee4215164444de248e2d1a119b79484fb5e3`.
Branch: `feat/t16-source-text-corrections`.

## User workflow

Open **Textkorrektur** (accessible name: **Originaltext korrigieren**). The approved
layout A places the editor sidebar beside a large actual PDF preview. Select a
page and an original text line. The original font/size are retained; no font-menu
match or replacement font is needed. Enter corrected text, generate the candidate
PDF, inspect the paragraph and following content, and explicitly confirm review
before applying. Compare original/candidate without discarding the input; zoom
and scroll the actual rendered PDF on desktop/mobile.

Supported multiline text blocks also offer paragraph reflow. This is OFF by
default: the user must confirm that the block is flowing prose, not intentionally
broken lines. PDF operators do not reliably encode semantic paragraph intent.
Reconstruction/word-wrap validation must also pass; confirmation alone cannot
turn an unsupported structure into an editable paragraph.

Apply is one undoable command. Only the selected page's source revision changes;
other copies of that source page, page geometry and unrelated state remain as
before. Revised source bytes are persisted through the existing IndexedDB source
store, and normal page composition/export uses the revision. Candidate generation,
comparison, cancellation and rejection do not modify the document or draft.

## Supported subset and explicit refusals

- Horizontal, unrotated, text-only PDFs with explicit font and identity text
  matrix, supported colour operations and balanced graphics/text states.
- The 12 standard Helvetica/Times/Courier Type1 WinAnsi variants.
- Verified embedded TrueType/CIDFontType2 subsets using Type0 Identity-H, a fully
  consumed supported bfchar ToUnicode CMap, explicit/Identity CIDToGID mapping and
  valid widths. Check the actual font program, referenced non-.notdef glyphs and
  outlines, not just a claimed Unicode map. Reuse ORIGINAL codes/resources.
- ASCII, German umlauts/ß/ẞ and supported punctuation, only when the original
  encoding contains the required unambiguous glyph. No raw UTF-8 PDF strings,
  substitute font, question-mark replacement, compression or shrinking.
- No shaping/ligature reconstruction, TJ positioning arrays, custom spacing,
  unsupported transformations, ambiguous maps, CFF/Type3/simple custom fonts,
  inherited CMaps/bfrange, scans/OCR, forms, tagged PDFs, active actions or shared
  content streams. These fail closed; this is not universal PDF text editing.
- Any unsupported graphics/image operation or unknown resource rejects analysis;
  the engine does not pretend text-only extraction proves surrounding space free.
- Editor pages with user overlays, pending/applied redactions, manual crop,
  rotation or non-unit UserUnit are refused. These are deliberate safety limits,
  not silently ignored objects. Existing ordinary editing remains available.

## Paragraph model and protected space

A reflow candidate is a single uniform BT/ET block in one content stream with
one explicit Tm and positive constant leading; following lines use T*. All lines
must share the same left edge and text state. Rewrapping the reconstructed text
at the maximum existing advance width must reproduce every original line and
baseline exactly. Lists, obvious sentence/hard-break boundaries, line-end
hyphenation and special spacing are not reconstructed automatically.

Reflow preserves first baseline, original left/right bounds, font size and
leading. Whole words move down/up naturally; no new hyphenation, stretched spaces
or horizontal squeezing. Shorter paragraphs stay top anchored and leave space
below; following content never moves. Line-only editing in a recognized paragraph
also cannot widen that paragraph.

Growth is allowed only downward inside BOTH MediaBox and CropBox and a supported
text-only collision model. Painted extents conservatively use full-font bounding
boxes and possible ink overhang, rather than equating advance width with ink.
This can reject tight layouts; it cannot authorize editing unknown graphics.

Minimum clearance is 3 physical source points (rotation/UserUnit restricted to
0/1). For paragraph growth toward following text, preserve a contextual gap of
`max(3, min(original gap, leading / 2))` points. Every candidate line is also
checked against every nonmember text block, including neighbouring columns.
A complete paragraph must fit; partial edits are never returned/applied.

## Architecture and safety boundaries

- `encoding.ts`: immutable validated one-/two-byte original-font codec.
- `layout.ts`: pure, bounded whole-word paragraph planner; no PDF/React mutation.
- `contentTokens.ts`: strict bounded content lexer with literal/octal/hex decoding.
- `streams.ts`: native streaming Flate decompression with output limits; no
  unbounded library inflate or stacked/unknown filters.
- `sourceFonts.ts`: standard-font metrics and actual embedded-font/CMap proofs.
- `simplePdf.ts`: conservative operator analysis, paragraph validation, collision
  checks, replacement of the original stream object, candidate save/reopen check.
- `sourceText.worker.ts` / `client.ts`: one disposable dedicated worker per job,
  abort termination and a 30-second deadline, including parser/font work. Copy
  input before transfer, never detach the editor's original bytes.
- `revision.ts`: selected-page source replacement as one undo/redo command.
- `SourceTextPanel.tsx`: version/selection-bound async UI, actual PDF.js preview,
  explicit review, original/candidate comparison and atomic commit guards.

Bounds: input 16 MiB/200 pages; content streams 512 KiB compressed/decoded and
2 MiB total decoded content; 4096 source runs; 50,000 lexer tokens per stream;
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

- 294 unit/integration tests, including real standard-font and embedded Noto Sans
  subset DE/EN correction, missing/ambiguous glyph refusals, actual paragraph
  growth/shrink/overflow, intentional breaks/hyphens, unchanged neighbour baseline,
  no retained old text stream, source copies, overlays, undo/redo, IndexedDB and
  exported PDFs; worker abort/deadline and stale/async-mutation guards.
- `scripts/source-text-smoke.mjs`: real worker/UI/candidate render/review,
  comparison, paragraph shrink, export, undo/redo, manual save/reopen, embedded
  subset, invalidated input, rejected overflow and document switch. Desktop and
  390px mobile screenshots, zoom and no horizontal document overflow.
- Registered in `npm run qa:ci`; existing shape/crop tests are retained. The new
  header action is compact and omitted in page management, so crop confirmation
  still fits at 320px without scrolling its controls.
- Also test the STATIC Pages build under `/pdf-editor/`, including source-worker
  and fontkit assets, not merely the development module server.

`prototypes/t16-correction-review.html` retains the original three synthetic UI
variants as design history only. It is outside production entry points and is not
an alternative PDF engine. Actual test outcomes are recorded in the PR.
