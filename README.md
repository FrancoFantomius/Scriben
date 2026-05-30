# Scriben

Scriben is a lightweight, browser-based editor that feels like the desktop word processors you already know.

## Highlights
- **Paginated layout** – content reflows to perfect pages as you type  
- **Zero-setup** – open the HTML file and start writing  
- **Private** – everything stays in local storage; nothing leaves your machine  
- **PDF-ready** – one click to pixel-perfect PDF  
- **Rich formatting** – bold, italic, links, lists, colors, images, and more  

## Features
- **Paginated Layout & Document Setup**:
  - **Dynamic Page-Splitting Mechanic**: Automatically reflows content across pages in real-time using binary-search-driven overflow detection.
  - **Multi-Format Page Setup**: Toggle between A4, Letter, Legal, and A5 layouts.
  - **Intelligent Page Management**: Keyboard-driven arrow navigation between pages, backspace merging, and automatic cleanup of trailing empty pages.
- **Rich Text Editor (WYSIWYG)**:
  - **Formatting Toolbar**: Bold, italic, underline, custom text (foreground) and highlight (background) colors, and text alignment (left, center, right).
  - **Structure & Typography**: Font switching (Inter, Arial, Georgia, Times New Roman, Roboto, Calibri) and standard font sizing levels.
  - **Insert Elements**: Hyperlink integration, unordered/ordered lists, and local image insertion (encoded as inline Base64 data).
  - **Advanced Selection**: Keyboard-shortcut-driven `Ctrl/Cmd + A` selecting text across multiple pages seamlessly.
- **Offline-First & Local Cache**:
  - **Auto-Save Engine**: Saves document states automatically to a local PouchDB database with a 1-second debounced delay.
  - **Cache Purging**: Clear all local database cache and settings directly from the user profile dropdown.
- **Secure Cloud Sync (Filen Integration)**:
  - **Zero-Knowledge Privacy**: Secure end-to-end client-side encryption powered by `@filen/sdk` (passwords and plaintext data never leave your browser).
  - **Selective Offline Availability**: Prunes the local cache of non-active files flagged for cloud-only storage, fetching content lazily on demand.
  - **Reconciliation Engine**: Automatic bidirectional sync loop, handling local deletion queues and background change synchronization.
  - **Google-Style Account Dropdown**: Features Google-style avatars, fallback initials with custom colors, and remote sign-out functions.
- **Templates & Dashboard**:
  - **Dashboard Hub**: Document manager featuring instant search filtering, renaming, and permanent deletion options.
  - **Document Templates**: Preloaded templates (Blank Document, Project Proposal, Meeting Notes, Resume / CV, Cover Letter) localized with Italian placeholder content.
  - **Responsive Design**: Restricts access on devices that are too small to render paginated word processor documents properly.
- **PDF Export**:
  - **High-Res Rendering**: Export page-by-page documents at 2x resolution to multi-page PDFs using `html2canvas` and `jspdf` loaded dynamically on demand.
  - **Descriptive Filenames**: Saves files using sanitized document titles automatically.

## Quick start
```bash
npm install
npm run dev
```

## Tech snapshot
- Pure HTML5, CSS3, vanilla JS  
- PDF export via jsPDF & html2canvas  
- Filen sync via @filen/sdk  

## License
AGPL-3.0 – see [LICENSE](LICENSE)