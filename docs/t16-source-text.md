# T16 — bounded original-text corrections (DE/EN)

Base: `origin/main` at `efccee4215164444de248e2d1a119b79484fb5e3`.
Branch: `feat/t16-source-text-corrections`.

## User workflow

Open **Textkorrektur** (accessible name: **Originaltext korrigieren**). The approved
layout A places the editor sidebar beside a large actual PDF preview. Select a
page, then highlight text directly on the original PDF or click/focus an outlined
run (Tab/Enter/Space). The selected substring is copied into the focused sidebar
textarea; unchanged text outside the selection is preserved. A full proved
paragraph can also be selected explicitly. The original font/size are retained; no font-menu
match or replacement font is needed. Enter corrected text, generate the candidate
PDF, inspect the paragraph and following content, and explicitly confirm review
before applying. Compare original/candidate without discarding the input; zoom
and scroll the actual rendered PDF on desktop/mobile.

Support is visible before selecting: solid outlines mean proved paragraphs,
dashed outlines mean fragment-only correction. Other extracted text is dimmed and
can be clicked for an explanation; while analysis runs its status is unknown.
PDF.js extraction never authorizes an edit: the invisible native-selection layer
uses original-font character advances from the trusted adapter, including TJ,
Tc/Tw and the native CropBox viewport transform. Nonmonotone/invalid geometry is
not selectable. The selection DOM is limited to 40,000 proved characters per page;
a paragraph is not partially offered when this budget would cut its group.
Independent fragments and unsupported ranges cannot be silently joined. Selection
within one proved paragraph maps to full-paragraph offsets, but still needs reflow
confirmation for a cross-line edit. Draft changes require explicit confirmation
before switching selection/page or using the sidebar close action. Candidate/review state is invalidated
on input or selection changes; candidate geometry is never used for a new edit.

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

The original uniform text-block adapter is retained for proved paragraph reflow.
A second, page-scoped adapter handles ordinary mixed-content PDFs without
requiring all pages/resources to use that same narrow grammar.

- The 12 standard Helvetica/Times/Courier Type1 WinAnsi variants, verified
  embedded TrueType/CIDFontType2 subsets (Type0 Identity-H) and embedded one-byte
  TrueType/WinAnsi subsets. Actual glyph programs, widths and code mappings are
  checked. No extracted font is installed, bundled or substituted.
- Bounded, fully consumed bfchar and bfrange ToUnicode mappings (sequential and
  array destinations). Ligature mappings may be decoded/preserved as obstacles,
  but are not reconstructed into editable glyph sequences.
- Horizontal source correction supports Tj/TJ, explicit/relative Tm/Td/TD/T*,
  existing character/word spacing and simple text state. Original kerning is
  retained for unchanged prefix/suffix pairs, never reassigned to new pairs or
  squeezed to fit. The original post-show text matrix is restored so a shorter
  or longer replacement does not unexpectedly move other positioned fragments.
- Unchanged marked-content tags/MCIDs and the existing structure tree are kept.
  ActualText/expansion caches are refused with an explicit reason because they
  would need a synchronized semantic update. This is not accessibility repair.
- Images, Form XObjects, vector paths and link rectangles are preserved and
  conservatively treated as protected obstacles. Form contents are not edited;
  their transformed BBox protects the complete form. Unknown painting, complex
  clipping/transparency, inline images, font/shaping states and unproved metrics
  fail closed **on the selected page**, with a concrete reason/operator/page.
- A blank unembedded WinAnsi space-only font may be preserved using its declared
  width; it is never offered as editable text. No other glyph is invented.
- Unshared content refs are replaced in place, not left as orphaned old text.
  Shared content uses copy-on-write so unrelated pages stay unchanged.
- ASCII, German umlauts/ß/ẞ and supported punctuation are editable only when the
  original encoding contains the required unambiguous glyph. No raw UTF-8 PDF
  strings, fallback font, shrinking, horizontal squeezing or font-menu dependency.
- Forms/signatures/encryption, CFF/Type3, unsupported CMaps, unproved transforms,
  scans/OCR and unknown selected-page operators remain explicit refusal cases.
- Editor pages with overlays, redactions, manual crop, rotation or non-unit
  UserUnit still require separate preservation support; ordinary editing remains
  available. Document-level signature/form/semantic safety checks still apply.

**Important distinction:** a Word-produced line may consist of many independent
positioned fragments, sometimes in different font subsets. Supported fragments
can be corrected without rejecting the PDF as a whole. They are not automatically
merged into a paragraph. The existing proved uniform paragraph model below is
still required for reflow; a user checkbox alone does not prove reconstruction.
New text must fit without reducing protected separation from other fragments.

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
- `mixedPdf.ts`: selected-page mixed-content interpreter, original TJ/font-state
  correction, protected graphics/link bounds, copy-on-write and candidate checks.
- `simplePdf.ts`: conservative operator analysis, paragraph validation, collision
  checks, replacement of the original stream object, candidate save/reopen check.
- `sourceText.worker.ts` / `client.ts`: one disposable dedicated worker per job,
  abort termination and a 30-second deadline, including parser/font work. Copy
  input before transfer, never detach the editor's original bytes.
- `revision.ts`: selected-page source replacement as one undo/redo command.
- `directSelection.ts`: pure source-run/paragraph range binding and partial replacement.
- `SourceTextSelection.tsx`: source-bound native text selection, persistent highlights,
  support outlines and a separate extraction-based dimming mask.
- `SourceTextPanel.tsx`: version/selection-bound async UI, actual PDF.js preview,
  explicit review, original/candidate comparison and atomic commit guards.

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

- 308 unit/integration tests, including real standard-font and embedded Noto Sans
  subset DE/EN correction, missing/ambiguous glyph refusals, actual paragraph
  growth/shrink/overflow, intentional breaks/hyphens, unchanged neighbour baseline,
  no retained old text stream, source copies, overlays, undo/redo, IndexedDB and
  exported PDFs; worker abort/deadline and stale/async-mutation guards.
- `scripts/source-text-smoke.mjs`: real worker/UI/candidate render/review,
  comparison, paragraph shrink, export, undo/redo, manual save/reopen, embedded
  subset, invalidated input, rejected overflow and document switch. Desktop and
  390px mobile screenshots, zoom and no horizontal document overflow.
- `scripts/source-text-mixed-smoke.mjs`: selected page, tagged/TJ source,
  worker/candidate/review/apply/export. Optional local-only `SOURCE_TEXT_PDF`,
  `SOURCE_TEXT_FIND`, `SOURCE_TEXT_REPLACE` exercise a supplied file without
  committing it, its text, or its embedded fonts. Additional unit regressions
  cover images/paths/links, another unsupported page, relative positioning,
  shared streams, no orphan old text, bfrange bounds and concrete refusals.
- Registered in `npm run qa:ci`; existing shape/crop tests are retained. The new
  header action is compact and omitted in page management, so crop confirmation
  still fits at 320px without scrolling its controls.
- Also test the STATIC Pages build under `/pdf-editor/`, including source-worker
  and fontkit assets, not merely the development module server.

An eight-page supplied Word-style PDF was tested locally: editable fragments
were found on all eight pages, and a real typo correction passed the browser,
actual preview and independently extracted export. Independent MuPDF rendering
of the source candidate left pages 1–7 pixel-identical and all image resources
unchanged. This is evidence for that fixture, not a claim of universal support.
The supplied document and extracted proprietary fonts are NOT in the repository.

`prototypes/t16-correction-review.html` retains the original three synthetic UI
variants as design history only. It is outside production entry points and is not
an alternative PDF engine. Actual test outcomes are recorded in the PR.

## Direct-selection regression coverage

`source-text-selection-smoke.mjs` exercises real mouse dragging (not an injected
DOM selection), substring-only DE/EN export independently read with PDF.js,
native CropBox offsets, zoom, focus, persistent highlighting, dirty-selection
confirmation, keyboard/mobile use, unproved text, page switches and stale preview
rejection. The existing T16 suite also drags across proved paragraph lines and
rejects cross-paragraph selections; reflow, undo/redo, save/drafts and embedded-font
export remain covered. All three T16 suites are part of `qa:ci`.
