/**
 * generate-fixtures.mjs — (Re)builds the M4 golden-test .docx fixtures.
 *
 * Provenance: generated with the `docx` library (the same OOXML dialect Word
 * writes for numbering/hyperlinks/drawings) so the fixtures open cleanly in
 * Word and LibreOffice. Run `node tests/fixtures/generate-fixtures.mjs` from
 * the repo root; the produced `tests/fixtures/*.docx` files are committed.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    Document,
    Packer,
    Paragraph,
    TextRun,
    ExternalHyperlink,
    InternalHyperlink,
    ImageRun,
    BookmarkStart,
    BookmarkEnd,
    LevelFormat,
    HeadingLevel
} from 'docx';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)));

// Valid 1x1 PNG used as the inline image payload (byte-identical round-trip).
const PNG_BYTES = Uint8Array.from(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
);

async function build(name, children, numbering) {
    const doc = new Document({ numbering, sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    writeFileSync(join(OUT_DIR, name), buffer);
    console.log(`wrote ${name}`);
}

// Numbering definitions mirroring Scriben's own exporter (one reference per
// list type; ordered carries its `start` on level 0).
const NUMBERING = {
    config: [
        {
            reference: 'bullet',
            levels: [
                { level: 0, format: LevelFormat.BULLET, text: '\u2022' },
                { level: 1, format: LevelFormat.BULLET, text: '\u25E6' }
            ]
        },
        {
            reference: 'number-five',
            levels: [
                { level: 0, format: LevelFormat.DECIMAL, start: 5, text: '%1.' },
                { level: 1, format: LevelFormat.DECIMAL, start: 1, text: '%2.' }
            ]
        }
    ]
};

// ─── 1. lists-start.docx ─────────────────────────────────────────────────────
// Nested bullets + numbered list starting at 5, with a nested numbered level.
const lists = [
    new Paragraph({ numbering: { reference: 'bullet', level: 0 }, children: [new TextRun('alpha')] }),
    new Paragraph({ numbering: { reference: 'bullet', level: 0 }, children: [new TextRun('beta')] }),
    new Paragraph({ numbering: { reference: 'bullet', level: 1 }, children: [new TextRun('nested beta')] }),
    new Paragraph({ numbering: { reference: 'number-five', level: 0 }, children: [new TextRun('five')] }),
    new Paragraph({ numbering: { reference: 'number-five', level: 0 }, children: [new TextRun('six')] }),
    new Paragraph({ numbering: { reference: 'number-five', level: 1 }, children: [new TextRun('sub seven')] })
];

// ─── 2. links.docx ───────────────────────────────────────────────────────────
// External hyperlink + anchor link pointing at a heading bookmark.
const links = [
    new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new BookmarkStart('ReportAnchor', 1), new TextRun('Report'), new BookmarkEnd(1)]
    }),
    new Paragraph({
        children: [
            new TextRun('See '),
            new ExternalHyperlink({ link: 'https://example.com', children: [new TextRun('the example')] }),
            new TextRun(' online.')
        ]
    }),
    new Paragraph({
        children: [
            new InternalHyperlink({ anchor: 'ReportAnchor', children: [new TextRun('jump to report')] })
        ]
    })
];

// ─── 3. images.docx ──────────────────────────────────────────────────────────
// Inline image at a known drawn size (120x60 CSS px → 1143000×571500 EMU).
const images = [
    new Paragraph({ children: [new TextRun('Before image.')] }),
    new Paragraph({
        children: [
            new ImageRun({ type: 'png', data: PNG_BYTES, transformation: { width: 120, height: 60 } })
        ]
    }),
    new Paragraph({ children: [new TextRun('After image.')] })
];

mkdirSync(OUT_DIR, { recursive: true });
await build('lists-start.docx', lists, NUMBERING);
await build('links.docx', links);
await build('images.docx', images);

// Also emit a plain-text probe fixture used to sanity-check the round-trip
// harness preserves plain paragraphs around the special content.
await build('plain-probe.docx', [new Paragraph({ children: [new TextRun('plain')] })]);