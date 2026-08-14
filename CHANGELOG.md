# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Word (.docx) round-trip fidelity for nested bullet/numbered lists (including `start`), external + internal anchor hyperlinks, and inline images (byte-identical, never re-encoded). Covers both export (`docxExport.js`: numbering, hyperlinks, bookmarks, `ImageRun`) and import (`ooxml.js`: per-level `w:numPr` resolution).
- Golden round-trip test corpus (`tests/fixtures/*.docx`, `tests/golden.test.js`): every fixture must survive import → export → import structurally unchanged.
- `<ol start>` is now captured in the model and re-emitted on export; image nodes record their drawn size.
- **Annotation export & import** – footnotes, endnotes, comments, and tracked changes (insertions, deletions, format changes) now round-trip through `.docx` (`docxExport.js` `buildNotes`/revision runs, `ooxml.js` annotation parts).
- **Deterministic export** – repeated exports of the same document are byte-identical: `docProps/core.xml` timestamps are pinned to a fixed value and relationship ids are remapped to a stable sequence.
- **Fidelity harness** (`tests/roundtrip.test.js`) – per-fixture repair-invariant and byte-stability checks, a 500-paragraph synthetic stress document, and a per-feature exercise check driven by `tests/matrix.json`.
- **Fidelity matrix** (`tests/matrix.json`) – authoritative per-feature import/export/round-trip status; the `plans/README.md` table now tracks it as the living contract.
- **Import UX** – drop overlay + progress bar for large files, and a result toast summarizing what was preserved (tables, footnotes, comments, tracked changes counts).
- **50 MB import guard** – oversized `.docx` files warn (never block) instead of stalling the editor.
- **Pagination split-collapse tests** – `data-split` clones (including an inline image at the page boundary) collapse cleanly through `pagesToModel`; footnote markers survive model normalization.
- **CI test job** – `.github/workflows/deploy.yml` now runs `npm test` on Node 24 before building.
- **Bundle report** – `build:report` prints gzipped sizes of the on-demand conversion chunks (`docx`, `fflate`).

### Changed
- File menu restructured: *Open Word document (.docx)* under Open, and *Download* → *Word document (.docx)* / *PDF (.pdf)* (ids unchanged).
- `docxImport` no longer falls back to mammoth; the hand-rolled OOXML reader (`ooxml.js`) is the only import engine.
- Soft cap on embedded image size: autosave warns (never blocks) when an image's Base64 payload exceeds 5 MB, since images are intentionally never re-compressed.
- Updated `@filen/sdk` to v0.4.x and `vite-plugin-node-polyfills` to v0.2.0.

## [1.0.0] - 2026-07-25

### Added
- Filen sync storage relocated to `/Apps/Scriben`, with an index file and per-document author tracking.
- New app icons (light and dark variants) and migration of Google Fonts to self-hosted `@fontsource` packages.

## [0.1.1] - 2026-06-03

### Added
- GitHub Pages deployment workflow (`.github/workflows/deploy.yml`).
- Custom domain `scriben.francofantomius.com` via `CNAME`.

### Changed
- Migrated hosting from Vercel/Cloudflare to GitHub Pages.
- Updated `@filen/sdk` dependency.

### Removed
- Wrangler (Cloudflare) dependencies and associated deployment scripts.
- Build artifacts (`dist/`) from version control.

## [0.1.0] - 2026-05-30

### Added
- Paginated editor with real-time page splitting, multi-format page setup (A4, Letter, Legal, A5), and keyboard page navigation.
- Rich text toolbar: bold, italic, underline, text/highlight colors, alignment, font and size selection, links, lists, and inline Base64 images.
- Multi-page selection with `Ctrl/Cmd + A`.
- Auto-save to a local PouchDB database with debounced writes.
- Secure cloud sync with Filen via `@filen/sdk` (zero-knowledge, end-to-end encrypted).
- Selective offline availability and bidirectional sync reconciliation.
- Dashboard with search, rename, and delete; document templates (Blank, Proposal, Meeting Notes, Resume, Cover Letter) with localized placeholders.
- High-resolution multi-page PDF export via `html2canvas` and `jspdf`.
- Dark mode and a user profile dropdown with avatars and sign-out.
- Landing page, privacy policy, and terms of service.