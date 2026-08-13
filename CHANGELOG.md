# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
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