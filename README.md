# Scriben

Scriben is a fast, privacy-first document editor that runs entirely in the browser. It feels like a desktop word processor — paginated pages, rich formatting, and a distraction-free workspace — while keeping every keystroke on your machine.

## Highlights

- **Paginated layout** – content reflows to perfect pages as you type
- **Offline-first** – documents auto-save locally to a built-in database; nothing is uploaded unless you opt in
- **End-to-end encrypted sync** – optionally sync with your own Filen account; passwords and plaintext never leave your browser
- **PDF export** – one click to a pixel-perfect, high-resolution PDF
- **Rich formatting** – bold, italic, underline, colors, alignment, fonts, links, lists, images, and more
- **Templates** – start from Blank, Proposal, Meeting Notes, Resume, or Cover Letter templates
- **Web app manifest** – themed (light / dark / auto) with app icons for a native-feeling install via the manifest

## Features

### Pagination & Document Setup
- **Dynamic page-splitting** – content is automatically reflowed across pages in real time using binary-search overflow detection
- **Multi-format page setup** – toggle between A4, Letter, Legal, and A5
- **Intelligent page management** – arrow-key navigation between pages, backspace page merging, and automatic cleanup of trailing empty pages

### Rich Text Editor (WYSIWYG)
- **Formatting toolbar** – bold, italic, underline, custom text and highlight colors, and left/center/right alignment
- **Structure & typography** – 14 self-hosted fonts (Inter, Google Sans, Montserrat, Playfair Display, Nunito, Oswald, and more) plus system fonts like Arial, Georgia, Times New Roman, and Calibri, and standard font-size levels
- **Insert elements** – hyperlinks, unordered/ordered lists, and local images (embedded inline as Base64)
- **Advanced selection** – `Ctrl/Cmd + A` selects text across multiple pages seamlessly

### Storage & Sync
- **Auto-save engine** – document state is saved to a local database (PouchDB) with a 1-second debounced delay
- **Cache purging** – clear all local data and settings from the user profile dropdown
- **Secure cloud sync (Filen)** – zero-knowledge, end-to-end client-side encryption via `@filen/sdk`
- **Selective offline availability** – non-active cloud-only files are pruned locally and fetched lazily on demand
- **Reconciliation engine** – automatic bidirectional sync loop with local deletion queues and background change sync

### Templates & Dashboard
- **Dashboard hub** – document manager with instant search, renaming, and permanent deletion
- **Document templates** – Blank Document, Project Proposal, Meeting Notes, Resume / CV, and Cover Letter, preloaded with placeholder content
- **Responsive design** – gracefully restricts access on devices too small to render paginated documents properly

### PDF Export
- **High-resolution rendering** – exports page-by-page at 2x resolution to multi-page PDFs via `html2canvas` and `jspdf` (loaded on demand)
- **Descriptive filenames** – files are named automatically from the sanitized document title

### Word (.docx) Compatibility
- **Native import & export** – open `.docx` files from the File menu or drag-and-drop, and download Word documents that reopen with high fidelity
- **Annotation preservation** – footnotes and endnotes, comments, and tracked changes (insertions, deletions, format changes) survive the round trip
- **Deterministic export** – exporting the same document twice yields byte-identical files (pinned timestamps and relationship ids), so version-control diffs stay clean
- **Privacy-preserving** – all conversion runs in the browser (`docx` and `fflate` load on first use); nothing is uploaded
- **Large-file guard** – oversized files import with a warning instead of stalling, and a progress overlay + summary toast keeps the flow transparent
- **Fidelity contract** – an automated corpus of 9 `.docx` fixtures enforces import → export → import structural equality; the per-feature matrix in [`tests/matrix.json`](tests/matrix.json) is the source of truth (see [`plans/README.md`](plans/README.md))

## Getting started

```bash
# Install dependencies
npm install

# Start the dev server (http://localhost:5173)
npm run dev
```

## Build & deploy

```bash
npm run build      # production build to dist/
npm run preview    # preview the production build locally
```

Scriben deploys automatically to GitHub Pages from the `main` branch via the workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The site's custom domain (`scriben.francofantomius.com`) is configured through the `CNAME` file.

## Project structure

```
├── index.html            # Landing page
├── editor.html           # The document editor
├── templates.html        # Document dashboard / template picker
├── privacy.html          # Privacy policy
├── terms.html            # Terms of service
├── css/                  # Stylesheets (index, editor, templates, fonts)
├── js/
│   ├── editor/           # Editor modules (pagination, selection, commands, pdf, ui, ...)
│   ├── options.js        # Fonts & options
│   ├── sync.js           # PouchDB + Filen sync engine
│   └── templates.js      # Template management
├── templates/            # HTML template documents
├── img/                  # App icons and assets
├── manifest.json         # PWA manifest
├── tests/                # Round-trip corpus & harness (tests/fixtures/*.docx, matrix.json)
└── vite.config.js        # Build configuration
```

## Tech stack

- **Pure HTML5, CSS3, vanilla JS** – no UI framework
- **Vite** – build tooling with node polyfills
- **PouchDB** – local-first document storage
- **@filen/sdk** – end-to-end encrypted cloud sync
- **jsPDF & html2canvas** – PDF export (loaded on demand)
- **@fontsource** – self-hosted web fonts (no external requests)
- **docx & fflate** – Word (.docx) import/export conversion (loaded on demand)

## License

AGPL-3.0 – see [LICENSE](LICENSE). See [CHANGELOG.md](CHANGELOG.md) for version history.