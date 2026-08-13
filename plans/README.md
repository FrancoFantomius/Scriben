# Scriben ↔ MS Word Compatibility Program

Goal: **bidirectional round-trip compatibility** between Scriben and Microsoft Word —
import `.docx` files into Scriben for editing, and export Scriben documents to `.docx`
that Word reopens with high fidelity. Scope covers the "everything" tier: text,
formatting, fonts, alignment, lists, links, images, tables, headers/footers, page
numbers, styles/themes, footnotes, comments, and tracked-change preservation.

## Non-negotiable constraints

- **Client-side only.** All conversion runs in the browser; nothing is uploaded.
  Keeps Scriben's privacy-first, offline-first promise.
- **On-demand libraries.** New deps load lazily, following the existing pattern in
  `js/editor/pdf.js` (`ensurePdfLibs()`). Never block app startup.
- **Backward-compatible storage.** Existing PouchDB documents (per-page HTML arrays)
  must keep working; migration is additive.
- **Pagination stays a render layer.** The page-splitting machinery in
  `js/editor/pagination.js` is not the source of truth for document content.

## Architecture overview

Today Scriben's source of truth is an array of per-page `innerHTML` strings
(`state.currentDoc.content`, see `js/editor/document.js:50`), edited via
`document.execCommand`, paginated at render time. Word's source of truth is OOXML.
There is no shared representation, so the program introduces a **canonical JSON
document model** as the pivot between the editor DOM and `.docx`.

```
┌──────────────┐   pagesHTML→model   ┌──────────────────┐   model→OOXML   ┌──────────┐
│  Editor DOM  │ ──────────────────▶ │ canonical model  │ ──────────────▶ │   .docx  │
│ (pagination) │ ◀────────────────── │ (js/editor/model)│ ◀────────────── │ (Word)   │
└──────────────┘   model→pagesHTML   └──────────────────┘   OOXML→model   └──────────┘
```

## Repository layout (planned)

```
plans/
├── README.md                     # this file
├── M1-canonical-model.md
├── M2-docx-export.md
├── M3-docx-import.md
├── M4-roundtrip-lists-links-images.md
├── M5-advanced-structure.md
├── M6-annotations.md
└── M7-fidelity-ux.md

js/editor/
├── model.js       # canonical model: schema, normalize, serialize
├── html.js        # pagesHTML ↔ model serializers
├── docxExport.js  # model → OOXML (uses on-demand `docx`)
├── docxImport.js  # import entry: loads OOXML reader (+ optional mammoth fallback)
├── ooxml.js       # authoritative OOXML reader (hand-rolled, fflate + DOMParser)
└── compat.js      # UI wiring: file input, drag-drop, menu items
```

## Fidelity matrix (tracking target)

| Feature              | Import | Export | Round-trip |
| -------------------- | ------ | ------ | ---------- |
| Paragraphs / text    | ✅     | ✅     | ✅         |
| Bold/italic/underline| ✅     | ✅     | ✅         |
| Colors (fg/bg)       | ✅     | ✅     | ✅         |
| Fonts + sizes        | ✅     | ✅     | ✅ (mapped)|
| Alignment            | ✅     | ✅     | ✅         |
| Bullet/numbered lists| ✅     | ✅     | ✅         |
| Links                | ✅     | ✅     | ✅         |
| Images               | ✅     | ✅     | ✅         |
| Tables               | ✅     | ✅     | ✅         |
| Page setup/sections  | ✅     | ✅     | ✅         |
| Headers/footers      | ✅     | ✅     | ✅         |
| Page numbers         | ✅     | ✅     | ✅         |
| Paragraph styles     | ▶ inline | ✅     | partial    |
| Themes / character styles | ▶ inline | ✅ | partial |
| Footnotes            | ✅     | ✅     | ✅         |
| Comments             | ✅ (view) | ✅ (preserve) | ✅ (preserve) |
| Tracked changes      | ▶ preserved | ▶ preserved | ▶ preserved |

Legend: ✅ expected, ▶ degraded-but-preserved, partial = best effort.

## Milestones

1. **M1** — Canonical document model + storage migration (no visible change)
2. **M2** — DOCX export: text, formatting, page setup
3. **M3** — DOCX import: hand-rolled OOXML reader (core body walker) + UI wiring
4. **M4** — Round-trip: lists, links, images
5. **M5** — OOXML reader extensions: tables, headers/footers, sections, styles/themes
6. **M6** — Footnotes, comments (view/preserve), tracked-change preservation
7. **M7** — Fidelity hardening, test corpus, UX polish

## Why not mammoth

`mammoth` (the common browser DOCX→HTML converter) is deliberately excluded as the
import engine. Its own documentation states it is **not designed for complex
documents** — it targets files that use Word's default styles consistently and drops
comments, tracked changes, most styles, themes, section breaks, headers/footers, and
precise numbering. That is the exact "everything" scope of this program. Import is
therefore built on a hand-rolled OOXML reader (`js/editor/ooxml.js`); mammoth is at
most an optional last-resort fallback behind a flag and can be dropped entirely.

Each milestone ships independently and keeps the app working. See the individual
plan files for task-level breakdowns, file references, and acceptance criteria.