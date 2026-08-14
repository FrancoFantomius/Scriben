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
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    ShadingType,
    Header,
    Footer,
    PageNumber,
    AlignmentType,
    FootnoteReferenceRun,
    EndnoteReferenceRun,
    CommentRangeStart,
    CommentRangeEnd,
    InsertedTextRun,
    DeletedTextRun
} from 'docx';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)));

// Valid 1x1 PNG used as the inline image payload (byte-identical round-trip).
const PNG_BYTES = Uint8Array.from(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
);

async function build(name, children, numbering, sectionProps, docProps = {}, sectionExtra = {}) {
    const doc = new Document({
        numbering,
        ...docProps,
        sections: [{ properties: sectionProps, ...sectionExtra, children }]
    });
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

// ─── 4. tables.docx ──────────────────────────────────────────────────────────
// A 3-column table with a row-spanning cell (gridSpan) and a shaded cell.
const tables = [
    new Paragraph({ children: [new TextRun('Above table.')] }),
    new Table({
        rows: [
            new TableRow({
                children: [
                    new TableCell({
                        children: [new Paragraph({ children: [new TextRun('A')] })]
                    }),
                    new TableCell({
                        columnSpan: 2,
                        children: [new Paragraph({ children: [new TextRun('B spans')] })]
                    })
                ]
            }),
            new TableRow({
                children: [
                    new TableCell({
                        shading: { type: ShadingType.CLEAR, fill: 'D9E2F3' },
                        children: [new Paragraph({ children: [new TextRun('shaded')] })]
                    }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun('C')] })] }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun('D')] })] })
                ]
            })
        ]
    }),
    new Paragraph({ children: [new TextRun('Below table.')] })
];

// ─── 5. header-footer.docx ───────────────────────────────────────────────────
// Document with a header ("Scriben Report") and a footer containing a
// PAGE field (page number) — the M5 page-number round-trip probe.
const header = new Header({
    children: [new Paragraph({ children: [new TextRun('Scriben Report')] })]
});
const footer = new Footer({
    children: [new Paragraph({ children: [new TextRun('Page '), new TextRun({ children: [PageNumber.CURRENT] })] })]
});
const headerFooterBody = [
    new Paragraph({ children: [new TextRun('Body under header/footer.')] })
];

// ─── 6. page-size.docx ───────────────────────────────────────────────────────
// Explicit non-preset page size (120mm x 180mm) with asymmetric margins:
// forces the exact-size path (classifyFormat → 'custom') on both sides.
const pageSizeBody = [
    new Paragraph({ children: [new TextRun('Custom-sized page.')] })
];
const customSection = {
    page: {
        size: { width: 120, height: 180 },
        margin: { top: 1000, right: 1500, bottom: 1200, left: 800 }
    }
};

await build('tables.docx', tables);
await build('header-footer.docx', headerFooterBody, undefined, undefined, undefined, {
    headers: { default: header },
    footers: { default: footer }
});
await build('page-size.docx', pageSizeBody, undefined, customSection);

// ─── 7. formatting.docx ───────────────────────────────────────────────────────
// Inline formatting: bold, italic, underline, strikethrough, super/subscript,
// text + highlight colors, an explicit font+size, and all alignments.
const formatting = [
    new Paragraph({
        children: [
            new TextRun({ text: 'bold ', bold: true }),
            new TextRun({ text: 'italic ', italics: true }),
            new TextRun({ text: 'underline ', underline: {} }),
            new TextRun({ text: 'strike ', strike: true })
        ]
    }),
    new Paragraph({
        children: [
            new TextRun({ text: 'H', superScript: true }),
            new TextRun('2O and '),
            new TextRun({ text: 'X', subScript: true }),
            new TextRun(' subscripted')
        ]
    }),
    new Paragraph({
        children: [
            new TextRun({ text: 'colored', color: 'C00000' }),
            new TextRun({ text: ' highlighted', shading: { type: ShadingType.CLEAR, fill: 'FFE599' } })
        ]
    }),
    new Paragraph({
        children: [
            new TextRun({ text: 'Times 18pt', font: 'Times New Roman', size: 36 })
        ]
    }),
    new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun('centered')]
    }),
    new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun('right aligned')]
    }),
    new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        children: [new TextRun('justified text across a few words here.')]
    })
];

// ─── 8. annotations.docx ──────────────────────────────────────────────────────
// Footnotes, an endnote, two comments with ranges, tracked insert/delete and a
// tracked format change — the M7 annotation round-trip corpus.
const annotations = [
    new Paragraph({
        children: [
            new TextRun('Body with a'),
            new FootnoteReferenceRun(1),
            new TextRun(' footnote and an'),
            new EndnoteReferenceRun(1),
            new TextRun(' endnote.'),
            new CommentRangeStart(101),
            new TextRun(' commented'),
            new CommentRangeEnd(101),
            new TextRun('.')
        ]
    }),
    new Paragraph({
        children: [
            new TextRun('Tracked: '),
            new InsertedTextRun({ text: 'inserted', id: 1, author: 'Ada', date: '2026-01-02T09:30:00Z' }),
            new TextRun(' and '),
            new DeletedTextRun({ text: 'removed', id: 2, author: 'Alan', date: '2026-01-03T11:15:00Z' }),
            new TextRun({ text: ' (format changed)', revision: { id: 3, author: 'Grace', date: '2026-01-04T14:00:00Z' } })
        ]
    })
];

await build('formatting.docx', formatting);
await build('annotations.docx', annotations, undefined, undefined, {
    footnotes: {
        1: { children: [new Paragraph({ children: [new TextRun('The footnote text.')] })] }
    },
    endnotes: {
        1: { children: [new Paragraph({ children: [new TextRun('The endnote text.')] })] }
    },
    comments: {
        children: [
            {
                id: 101,
                author: 'Ada',
                date: new Date('2026-01-02T09:30:00Z'),
                children: [new Paragraph({ children: [new TextRun('Review this wording.')] })]
            },
            {
                id: 102,
                author: 'Alan',
                date: new Date('2026-01-03T10:00:00Z'),
                children: [new Paragraph({ children: [new TextRun('Second review note.')] })]
            }
        ]
    }
});