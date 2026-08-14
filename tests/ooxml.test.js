import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';

import {
    NS,
    WARNINGS,
    unzipParts,
    normalizePartName,
    createReader,
    parseRels,
    getCoreTitle,
    walkBody,
    parseSectPr,
    buildWarnings,
    loadAnnotationParts,
    buildAnnotationSections
} from '../js/editor/ooxml.js';

const dom = new JSDOM('<!DOCTYPE html>');
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const DOC_HEADER =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
    'xmlns:v="urn:schemas-microsoft-com:vml">' +
    '<w:body>';

const DOC_FOOTER =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    '</w:body></w:document>';

function makeDocx(entries) {
    const data = {};
    for (const [name, content] of Object.entries(entries)) {
        data[name] = typeof content === 'string' ? strToU8(content) : content;
    }
    return zipSync(data);
}

const RELS_XML =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
    '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="word/../outside.txt"/>' +
    '</Relationships>';

const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x06, 0x00, 0x00, 0x00
]);

function ctxFor(reader) {
    return {
        reader,
        rels: new Map(),
        warnings: [],
        bookmarks: new Map(),
        bookmarkIds: new Set(),
        pageSetup: null,
        numbering: null
    };
}

// DOC_FOOTER carries a body-level w:sectPr (A4, 1in margins), so every
// walkBody call now ends with a trailing `section` block.
const TRAILING_SECTION = {
    type: 'section',
    pageFormat: 'a4',
    orientation: 'portrait',
    widthMM: 210,
    heightMM: 297,
    margins: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 }
};

function parseDoc(reader) {
    return reader.getPart('word/document.xml');
}

function bodyOf(reader) {
    const doc = parseDoc(reader);
    return doc ? doc.getElementsByTagNameNS(NS.w, 'body')[0] : null;
}

// ─── T1: ZIP + XML plumbing ───────────────────────────────────────────────────

describe('unzipParts', () => {
    test('decodes entries into a parts map', async () => {
        const parts = await unzipParts(makeDocx({ 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>' }));
        assert.ok(parts.has('word/document.xml'));
    });

    test('strips leading slashes from entry names', async () => {
        const parts = await unzipParts(makeDocx({ '/word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>' }));
        assert.ok(parts.has('word/document.xml'));
    });

    test('rejects path traversal entry names', async () => {
        const parts = await unzipParts(makeDocx({ 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>', '../evil.txt': 'x' }));
        assert.ok(!parts.has('evil.txt'));
    });

    test('throws INVALID_ZIP on garbage bytes', async () => {
        await assert.rejects(
            () => unzipParts(new Uint8Array([1, 2, 3, 4, 5])),
            err => err && err.code === 'INVALID_ZIP'
        );
    });

    test('throws MISSING_DOCUMENT when word/document.xml is absent', async () => {
        await assert.rejects(
            () => unzipParts(makeDocx({ 'word/foo.xml': '<x/>' })),
            err => err && err.code === 'MISSING_DOCUMENT'
        );
    });
});

describe('normalizePartName', () => {
    test('normalizes backslashes and dot segments', () => {
        assert.equal(normalizePartName('word\\media\\image1.png'), 'word/media/image1.png');
        assert.equal(normalizePartName('./word/document.xml'), 'word/document.xml');
        assert.equal(normalizePartName('/word/document.xml'), 'word/document.xml');
    });

    test('rejects .. traversal', () => {
        assert.equal(normalizePartName('word/../../etc/passwd'), null);
    });
});

describe('createReader', () => {
    test('getPart parses XML and warns on malformed XML', async () => {
        const parts = await unzipParts(makeDocx({ 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:broken' }));
        const warnings = [];
        const reader = createReader(parts, warnings);
        assert.equal(reader.getPart('word/document.xml'), null);
        assert.ok(warnings.some(w => w.code === 'XML_PARSE_ERROR'));
    });

    test('listParts matches a regex against part names', async () => {
        const parts = await unzipParts(makeDocx({
            'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
            'word/media/image1.png': PNG_BYTES
        }));
        const reader = createReader(parts);
        assert.deepStrictEqual(reader.listParts(/^word\/(media|embeddings|charts)\//), ['word/media/image1.png']);
    });
});

describe('parseRels', () => {
    test('keys relationships by Id and captures TargetMode', () => {
        const doc = new DOMParser().parseFromString(RELS_XML, 'application/xml');
        const rels = parseRels(doc);
        assert.equal(rels.get('rId5').target, 'https://example.com');
        assert.equal(rels.get('rId5').mode, 'External');
        assert.equal(rels.get('rId1').mode, undefined);
    });
});

describe('getCoreTitle', () => {
    test('reads dc:title from docProps/core.xml', async () => {
        const parts = await unzipParts(makeDocx({
            'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
            'docProps/core.xml':
                '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>My Document</dc:title></cp:coreProperties>'
        }));
        const reader = createReader(parts);
        assert.equal(getCoreTitle(reader), 'My Document');
    });

    test('returns null when no title exists', async () => {
        const parts = await unzipParts(makeDocx({ 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>' }));
        const reader = createReader(parts);
        assert.equal(getCoreTitle(reader), null);
    });
});

// ─── T2/T3: body walker, paragraphs, runs ─────────────────────────────────────

describe('walkBody', () => {
    test('extracts text, formatting, alignment and empty paragraphs', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
            '<w:r><w:t>Hello </w:t></w:r>' +
            '<w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>' +
            '<w:r><w:rPr><w:b w:val="false"/></w:rPr><w:t>not bold</w:t></w:r>' +
            '</w:p>' +
            '<w:p/>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));

        assert.equal(blocks.length, 3);
        assert.equal(blocks[0].type, 'paragraph');
        assert.equal(blocks[0].align, 'center');
        assert.deepStrictEqual(blocks[0].runs, [
            { text: 'Hello ' },
            { text: 'bold', bold: true },
            { text: 'not bold', bold: false }
        ]);
        assert.deepStrictEqual(blocks[1], { type: 'paragraph', runs: [] });
        assert.deepStrictEqual(blocks[2], TRAILING_SECTION);
    });

    test('maps justify/distribute alignment and unknown alignment warns', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:t>a</w:t></w:r></w:p>' +
            '<w:p><w:pPr><w:jc w:val="bogus"/></w:pPr><w:r><w:t>b</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.equal(blocks[0].align, 'justify');
        assert.equal(blocks[1].align, undefined);
        assert.ok(ctx.warnings.some(w => w.code === 'UNKNOWN_ALIGNMENT'));
    });

    test('w:val="false" disables bold/italic explicitly', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:rPr><w:i w:val="0"/></w:rPr><w:t>x</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        assert.deepStrictEqual(blocks[0].runs, [{ text: 'x', italic: false }]);
    });

    test('color, size, font, underline, strike, superscript parse', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:rPr><w:color w:val="FF0000"/><w:sz w:val="24"/><w:rFonts w:ascii="Arial"/><w:u w:val="single"/><w:strike/><w:vertAlign w:val="superscript"/></w:rPr><w:t>fmt</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        assert.deepStrictEqual(blocks[0].runs, [{
            text: 'fmt',
            color: '#FF0000',
            fontSize: '12pt',
            fontFamily: 'Arial',
            underline: true,
            strikethrough: true,
            superscript: true
        }]);
    });

    test('soft breaks and tabs become run text', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:t>a</w:t><w:br/><w:t>b</w:t><w:tab/><w:t>c</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        assert.deepStrictEqual(blocks[0].runs, [{ text: 'a\nb\tc' }]);
    });

    test('w:br type=page emits a pageBreak block', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:t>before</w:t><w:br w:type="page"/><w:t>after</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        assert.deepStrictEqual(blocks.map(b => b.type), ['paragraph', 'pageBreak', 'paragraph', 'section']);
        assert.deepStrictEqual(blocks[0].runs, [{ text: 'before' }]);
        assert.deepStrictEqual(blocks[2].runs, [{ text: 'after' }]);
    });

    test('preserves whitespace when xml:space="preserve" is set', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:t xml:space="preserve">  keep  </w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        assert.deepStrictEqual(blocks[0].runs, [{ text: '  keep  ' }]);
    });

    test('merges adjacent runs with identical formatting', async () => {
        const xml = DOC_HEADER +
            '<w:p>' +
            '<w:r><w:rPr><w:b/></w:rPr><w:t>a</w:t></w:r>' +
            '<w:r><w:rPr><w:b/></w:rPr><w:t>b</w:t></w:r>' +
            '<w:r><w:t>c</w:t></w:r>' +
            '</w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        assert.deepStrictEqual(blocks[0].runs, [{ text: 'ab', bold: true }, { text: 'c' }]);
    });

    test('w:pageBreakBefore emits a pageBreak before the paragraph', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>pb</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        assert.deepStrictEqual(blocks.map(b => b.type), ['pageBreak', 'paragraph', 'section']);
    });

    test('heading styles and outlineLvl map to heading blocks', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>H1</w:t></w:r></w:p>' +
            '<w:p><w:pPr><w:pStyle w:val="heading 2"/></w:pPr><w:r><w:t>H2</w:t></w:r></w:p>' +
            '<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>Lvl3</w:t></w:r></w:p>' +
            '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>P</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        assert.deepStrictEqual(blocks.map(b => [b.type, b.level]), [
            ['heading', 1], ['heading', 2], ['heading', 3], ['paragraph', undefined], ['section', undefined]
        ]);
    });

    test('bookmarks register for internal links', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>a</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        walkBody(bodyOf(reader), ctx);
        assert.equal(ctx.bookmarks.get('_Toc1'), '0');
    });
});

// ─── T5: links ────────────────────────────────────────────────────────────────

describe('links', () => {
    test('external hyperlink resolves via rels', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:hyperlink r:id="rId5"><w:r><w:t>example</w:t></w:r></w:hyperlink></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml, 'word/_rels/document.xml.rels': RELS_XML }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const relsDoc = reader.getPart('word/_rels/document.xml.rels');
        ctx.rels = parseRels(relsDoc);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.deepStrictEqual(blocks[0].runs, [{ text: 'example', href: 'https://example.com' }]);
    });

    test('internal anchor link maps to #bookmark', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:bookmarkStart w:id="1" w:name="_Toc1"/><w:r><w:t>target</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>' +
            '<w:p><w:hyperlink w:anchor="_Toc1"><w:r><w:t>jump</w:t></w:r></w:hyperlink></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.deepStrictEqual(blocks[1].runs, [{ text: 'jump', href: '#_Toc1', internal: true }]);
    });

    test('missing link target degrades to plain text with a warning', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:hyperlink r:id="rId404"><w:r><w:t>dead</w:t></w:r></w:hyperlink></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml, 'word/_rels/document.xml.rels': RELS_XML }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        ctx.rels = parseRels(reader.getPart('word/_rels/document.xml.rels'));
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.deepStrictEqual(blocks[0].runs, [{ text: 'dead' }]);
        assert.ok(ctx.warnings.some(w => w.code === 'LINK_TARGET_MISSING'));
    });

    test('missing anchor warns LINK_ANCHOR_MISSING', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:hyperlink w:anchor="nope"><w:r><w:t>x</w:t></w:r></w:hyperlink></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.deepStrictEqual(blocks[0].runs, [{ text: 'x' }]);
        assert.ok(ctx.warnings.some(w => w.code === 'LINK_ANCHOR_MISSING'));
    });
});

// ─── T4: images ───────────────────────────────────────────────────────────────

describe('images', () => {
    test('modern w:drawing image becomes a data-URL run', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/>' +
            '<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId1"/>' +
            '</pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({
            'word/document.xml': xml,
            'word/_rels/document.xml.rels': RELS_XML,
            'word/media/image1.png': PNG_BYTES
        }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        ctx.rels = parseRels(reader.getPart('word/_rels/document.xml.rels'));
        const blocks = walkBody(bodyOf(reader), ctx);

        assert.equal(blocks[0].runs.length, 1);
        const img = blocks[0].runs[0];
        assert.ok(img.image.startsWith('data:image/png;base64,'));
        assert.equal(img.width, '96');
        assert.equal(img.height, '48');
        assert.equal(ctx.warnings.length, 0);
    });

    test('byte-identical image payload after import', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/>' +
            '<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId1"/>' +
            '</pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({
            'word/document.xml': xml,
            'word/_rels/document.xml.rels': RELS_XML,
            'word/media/image1.png': PNG_BYTES
        }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        ctx.rels = parseRels(reader.getPart('word/_rels/document.xml.rels'));
        const blocks = walkBody(bodyOf(reader), ctx);
        const b64 = blocks[0].runs[0].image.split(',')[1];
        const decoded = new Uint8Array(Buffer.from(b64, 'base64'));
        assert.deepStrictEqual(Array.from(decoded), Array.from(PNG_BYTES));
    });

    test('external linked image is skipped with a warning', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill>' +
            '<a:blip r:link="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline>' +
            '</w:drawing></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({
            'word/document.xml': xml,
            'word/_rels/document.xml.rels': RELS_XML
        }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        ctx.rels = parseRels(reader.getPart('word/_rels/document.xml.rels'));
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.equal(blocks[0].runs.length, 0);
        assert.ok(ctx.warnings.some(w => w.code === 'EXTERNAL_IMAGE'));
    });
});

// ─── T6: page setup ───────────────────────────────────────────────────────────

describe('parseSectPr', () => {
    test('classifies A4 and orientation', async () => {
        const xml = DOC_HEADER + DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        walkBody(bodyOf(reader), ctx);
        assert.equal(ctx.pageSetup.format, 'a4');
        assert.equal(ctx.pageSetup.orientation, 'portrait');
        assert.equal(ctx.pageSetup.widthMM, 210);
        assert.equal(ctx.pageSetup.heightMM, 297);
        assert.equal(ctx.pageSetup.margins.top, 25.4);
    });

    test('landscape swaps width/height', async () => {
        const xml = DOC_HEADER +
            '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>' +
            '</w:body></w:document>';
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        walkBody(bodyOf(reader), ctx);
        assert.equal(ctx.pageSetup.format, 'a4');
        assert.equal(ctx.pageSetup.orientation, 'landscape');
        assert.equal(ctx.pageSetup.widthMM, 297);
        assert.equal(ctx.pageSetup.heightMM, 210);
    });

    test('unknown sizes classify as custom', () => {
        const sectPr = new DOMParser().parseFromString(
            '<w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:pgSz w:w="9000" w:h="9000"/></w:sectPr>',
            'application/xml'
        ).documentElement;
        const ctx = ctxFor({});
        parseSectPr(sectPr, ctx);
        assert.equal(ctx.pageSetup.format, 'custom');
    });
});

// ─── T8: basic lists ──────────────────────────────────────────────────────────

describe('lists', () => {
    const NUMBERING_XML =
        '<?xml version="1.0"?>' +
        '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>' +
        '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:start w:val="5"/></w:lvl></w:abstractNum>' +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
        '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
        '</w:numbering>';

    test('bullet and numbered (start=5) paragraphs become listItems', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>bullet</w:t></w:r></w:p>' +
            '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>five</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({
            'word/document.xml': xml,
            'word/numbering.xml': NUMBERING_XML
        }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.deepStrictEqual(blocks[0], {
            type: 'listItem', listType: 'unordered', level: 0, runs: [{ text: 'bullet' }]
        });
        assert.deepStrictEqual(blocks[1], {
            type: 'listItem', listType: 'ordered', level: 0, start: 5, runs: [{ text: 'five' }]
        });
    });

    test('missing numbering.xml warns NUMBERING_DEFERRED', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>flat</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.equal(blocks[0].type, 'paragraph');
        assert.ok(ctx.warnings.some(w => w.code === 'NUMBERING_DEFERRED'));
    });

    test('per-level numFmt resolves nested levels of one numId', async () => {
        const NUMBERING =
            '<?xml version="1.0"?>' +
            '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
            '<w:abstractNum w:abstractNumId="0">' +
            '<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>' +
            '<w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl>' +
            '</w:abstractNum>' +
            '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
            '</w:numbering>';
        const xml = DOC_HEADER +
            '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>b0</w:t></w:r></w:p>' +
            '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>n1</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml, 'word/numbering.xml': NUMBERING }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.deepStrictEqual(blocks[0], {
            type: 'listItem', listType: 'unordered', level: 0, runs: [{ text: 'b0' }]
        });
        assert.deepStrictEqual(blocks[1], {
            type: 'listItem', listType: 'ordered', level: 1, runs: [{ text: 'n1' }]
        });
    });

    test('concrete num lvlOverride startOverride is honored at level 0', async () => {
        const NUMBERING =
            '<?xml version="1.0"?>' +
            '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
            '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:start w:val="1"/></w:lvl></w:abstractNum>' +
            '<w:num w:numId="1"><w:abstractNumId w:val="0"/>' +
            '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>' +
            '</w:numbering>';
        const xml = DOC_HEADER +
            '<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>five</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml, 'word/numbering.xml': NUMBERING }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.deepStrictEqual(blocks[0], {
            type: 'listItem', listType: 'ordered', level: 0, start: 5, runs: [{ text: 'five' }]
        });
    });
});

// ─── T9: warnings taxonomy ────────────────────────────────────────────────────

describe('warning taxonomy', () => {
    test('tables parse into table blocks (no TABLE_DEFERRED)', async () => {
        const xml = DOC_HEADER + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' + DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.equal(blocks[0].type, 'table');
        assert.deepStrictEqual(blocks[0].rows, [[{ text: 'x' }]]);
        assert.ok(!ctx.warnings.some(w => w.code === 'TABLE_DEFERRED'));
    });

    test('tracked changes are preserved; footnotes defer without content', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:ins><w:r><w:t>added</w:t></w:r></w:ins></w:p>' +
            '<w:p><w:r><w:t>ref</w:t><w:footnoteReference w:id="1"/></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.deepStrictEqual(blocks[0].runs, [{ type: 'insRun', text: 'added' }]);
        assert.deepStrictEqual(blocks[1].runs, [{ text: 'ref' }, { type: 'footnoteRef', id: '1' }]);
        assert.ok(!ctx.warnings.some(w => w.code === 'TRACKED_CHANGE_DEFERRED'));
        assert.ok(ctx.warnings.some(w => w.code === 'FOOTNOTE_DEFERRED'));
    });

    test('customXml produces a warning', async () => {
        const xml = DOC_HEADER + '<w:customXml><w:r><w:t>x</w:t></w:r></w:customXml>' + DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        walkBody(bodyOf(reader), ctx);
        assert.ok(ctx.warnings.some(w => w.code === 'CUSTOM_XML_SKIPPED'));
    });

    test('buildWarnings normalizes the public shape', () => {
        const out = buildWarnings([{ code: 'TABLE_DEFERRED', message: WARNINGS.TABLE_DEFERRED.message }]);
        assert.deepStrictEqual(out, [{ code: 'TABLE_DEFERRED', message: WARNINGS.TABLE_DEFERRED.message }]);
    });
});

// ─── M5: tables, sections, headers/footers, styles/themes ─────────────────────

const HEADER_RELS_XML =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
    '<Relationship Id="rIdF1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
    '</Relationships>';

describe('M5 tables', () => {
    test('gridSpan, vMerge, shading, borders, width and alignment parse', async () => {
        const xml = DOC_HEADER +
            '<w:tbl><w:tblPr>' +
            '<w:tblW w:w="2500" w:type="pct"/>' +
            '<w:jc w:val="center"/>' +
            '<w:tblBorders><w:top w:val="single" w:sz="6"/><w:insideH w:val="dashed" w:sz="4"/></w:tblBorders>' +
            '</w:tblPr>' +
            '<w:tr>' +
            '<w:tc><w:tcPr><w:gridSpan w:val="2"/><w:shd w:fill="D9E2F3"/></w:tcPr><w:p><w:r><w:t>span</w:t></w:r></w:p></w:tc>' +
            '<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>v</w:t></w:r></w:p></w:tc>' +
            '</w:tr>' +
            '<w:tr>' +
            '<w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc>' +
            '<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc>' +
            '<w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc>' +
            '</w:tr>' +
            '</w:tbl>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        const t = blocks[0];
        assert.equal(t.type, 'table');
        assert.equal(t.cols, 3);
        assert.equal(t.width, '50%');
        assert.equal(t.alignment, 'center');
        assert.deepStrictEqual(t.borders, {
            top: { style: 'single', size: 6 },
            insideH: { style: 'dashed', size: 4 }
        });
        assert.deepStrictEqual(t.rows[0], [
            { text: 'span', gridSpan: 2, shading: '#D9E2F3' },
            { text: 'v', vMerge: 'restart' }
        ]);
        assert.deepStrictEqual(t.rows[1], [
            { text: 'a' },
            { text: 'b', vMerge: 'continue' },
            { text: 'c' }
        ]);
    });

    test('nested tables are skipped with a warning', async () => {
        const xml = DOC_HEADER +
            '<w:tbl><w:tr><w:tc>' +
            '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
            '<w:p><w:r><w:t>outer</w:t></w:r></w:p>' +
            '</w:tc></w:tr></w:tbl>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.deepStrictEqual(blocks[0].rows[0][0], { text: 'outer' });
        assert.ok(ctx.warnings.some(w => w.code === 'NESTED_TABLE_SKIPPED'));
    });
});

describe('M5 sections and header/footer', () => {
    test('a pPr-level sectPr emits a section block mid-body', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:t>first section</w:t></w:r></w:p>' +
            '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>new section</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        const types = blocks.map(b => b.type);
        assert.deepStrictEqual(types, ['paragraph', 'paragraph', 'section', 'section']);
    });

    test('header/footer references resolve into section blocks', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:t>body</w:t></w:r></w:p>' +
            '<w:sectPr>' +
            '<w:headerReference w:type="default" r:id="rIdH1"/>' +
            '<w:footerReference w:type="default" r:id="rIdF1"/>' +
            '<w:pgSz w:w="11906" w:h="16838"/>' +
            '</w:sectPr>' +
            '</w:body></w:document>';
        const HEADER_XML =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
            '<w:p><w:r><w:t>Doc Header</w:t></w:r></w:p>' +
            '</w:hdr>';
        const FOOTER_XML =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
            '<w:p><w:r><w:t>Page </w:t></w:r>' +
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
            '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
            '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
            '</w:p>' +
            '</w:ftr>';
        const parts = await unzipParts(makeDocx({
            'word/document.xml': xml,
            'word/_rels/document.xml.rels': HEADER_RELS_XML,
            'word/header1.xml': HEADER_XML,
            'word/footer1.xml': FOOTER_XML
        }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        ctx.rels = parseRels(reader.getPart('word/_rels/document.xml.rels'));
        const blocks = walkBody(bodyOf(reader), ctx);
        const section = blocks[blocks.length - 1];
        assert.equal(section.type, 'section');
        assert.deepStrictEqual(section.header, [{ type: 'paragraph', runs: [{ text: 'Doc Header' }] }]);
        assert.deepStrictEqual(section.footer, [{ type: 'paragraph', runs: [{ text: 'Page ' }, { type: 'pageNumber' }] }]);
        assert.equal(section.pageNumbering, true);
    });

    test('page numbers appear only when the page-number condition is met', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:t>body</w:t></w:r></w:p>' +
            '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgNumType w:start="1"/></w:sectPr>' +
            '</w:body></w:document>';
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        const section = blocks[blocks.length - 1];
        assert.equal(section.pageNumbering, true);
    });
});

describe('M5 styles and themes', () => {
    test('docDefaults formatting flows into plain runs', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:t>styled</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const STYLES =
            '<?xml version="1.0"?>' +
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
            '<w:docDefaults>' +
            '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="24"/><w:color w:val="333333"/></w:rPr></w:rPrDefault>' +
            '</w:docDefaults>' +
            '</w:styles>';
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml, 'word/styles.xml': STYLES }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        assert.deepStrictEqual(blocks[0].runs, [{ text: 'styled', fontFamily: 'Calibri', fontSize: '12pt', color: '#333333' }]);
    });

    test('paragraph styles resolve through the basedOn chain', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:pPr><w:pStyle w:val="SubT"/></w:pPr><w:r><w:t>sub</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const STYLES =
            '<?xml version="1.0"?>' +
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
            '<w:style w:type="paragraph" w:styleId="BaseP"><w:rPr><w:b/></w:rPr><w:pPr><w:jc w:val="center"/></w:pPr></w:style>' +
            '<w:style w:type="paragraph" w:styleId="SubT"><w:basedOn w:val="BaseP"/><w:rPr><w:color w:val="FF0000"/></w:rPr></w:style>' +
            '</w:styles>';
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml, 'word/styles.xml': STYLES }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        assert.equal(blocks[0].align, 'center');
        assert.deepStrictEqual(blocks[0].runs, [{ text: 'sub', bold: true, color: '#FF0000' }]);
    });

    test('theme colors resolve to hex with shade/tint', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:rPr><w:color w:themeColor="accent1" w:themeShade="80"/></w:rPr><w:t>accent</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const THEME =
            '<?xml version="1.0"?>' +
            '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
            '<a:themeElements><a:clrScheme name="X">' +
            '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
            '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
            '<a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
            '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
            '<a:accent1><a:srgbClr val="2F5496"/></a:accent1>' +
            '</a:clrScheme></a:themeElements>' +
            '</a:theme>';
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml, 'word/theme/theme1.xml': THEME }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        const run = blocks[0].runs[0];
        assert.equal(run.color, '#264378'); // #2F5496 shaded 80%
        assert.equal(run.text, 'accent');
    });

    test('universal measure page sizes (mm/cm) parse to exact millimeters', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:t>x</w:t></w:r></w:p>' +
            '<w:sectPr><w:pgSz w:w="210mm" w:h="297mm"/><w:pgMar w:top="2.54cm" w:left="1in"/></w:sectPr>' +
            '</w:body></w:document>';
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        const section = blocks[blocks.length - 1];
        assert.equal(section.pageFormat, 'a4');
        assert.equal(section.widthMM, 210);
        assert.equal(section.heightMM, 297);
        assert.equal(section.margins.top, 25.4);
        assert.equal(section.margins.left, 25.4);
    });
});

// ─── M6: annotations (footnotes, comments, tracked changes) ───────────────────

const FOOTNOTES_XML =
    '<?xml version="1.0"?>' +
    '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:footnote w:id="0"><w:type w:val="separator"/><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
    '<w:footnote w:id="1"><w:p><w:r><w:t>First note</w:t></w:r></w:p></w:footnote>' +
    '<w:footnote w:id="2"><w:p><w:r><w:t>Second note</w:t></w:r></w:p></w:footnote>' +
    '</w:footnotes>';

const ENDNOTES_XML =
    '<?xml version="1.0"?>' +
    '<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:endnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>' +
    '<w:endnote w:id="1"><w:p><w:r><w:t>An endnote</w:t></w:r></w:p></w:endnote>' +
    '</w:endnotes>';

const COMMENTS_XML =
    '<?xml version="1.0"?>' +
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:comment w:id="7" w:author="Ada" w:date="2026-01-01T10:00:00Z">' +
    '<w:p><w:r><w:t>Please reword this</w:t></w:r></w:p>' +
    '</w:comment>' +
    '</w:comments>';

describe('M6 annotations', () => {
    test('footnotes and comments load into annotation maps', async () => {
        const xml = DOC_HEADER + '<w:p><w:r><w:t>x</w:t></w:r></w:p>' + DOC_FOOTER;
        const parts = await unzipParts(makeDocx({
            'word/document.xml': xml,
            'word/footnotes.xml': FOOTNOTES_XML,
            'word/endnotes.xml': ENDNOTES_XML,
            'word/comments.xml': COMMENTS_XML
        }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        loadAnnotationParts(ctx);
        assert.ok(ctx.footnoteMap.has('1'));
        assert.deepStrictEqual(ctx.footnoteMap.get('2'), [{ type: 'paragraph', runs: [{ text: 'Second note' }] }]);
        assert.ok(!ctx.footnoteMap.has('0')); // separator skipped
        assert.ok(ctx.endnoteMap.has('1'));
        assert.deepStrictEqual(ctx.commentMap.get('7'), {
            author: 'Ada',
            date: '2026-01-01T10:00:00Z',
            text: 'Please reword this'
        });
    });

    test('footnote refs resolve when content is present and defer otherwise', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:t>a</w:t><w:footnoteReference w:id="1"/></w:r></w:p>' +
            '<w:p><w:r><w:t>b</w:t><w:footnoteReference w:id="99"/></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml, 'word/footnotes.xml': FOOTNOTES_XML }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        loadAnnotationParts(ctx);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.equal(blocks[0].runs[1].id, '1');
        assert.equal(blocks[1].runs[1].id, '99');
        assert.equal(ctx.warnings.filter(w => w.code === 'FOOTNOTE_DEFERRED').length, 1);
    });

    test('buildAnnotationSections merges footnotes and endnotes with distinct ids', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:t>a</w:t><w:footnoteReference w:id="1"/><w:endnoteReference w:id="1"/></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({
            'word/document.xml': xml,
            'word/footnotes.xml': FOOTNOTES_XML,
            'word/endnotes.xml': ENDNOTES_XML
        }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        loadAnnotationParts(ctx);
        const blocks = walkBody(bodyOf(reader), ctx);
        const annotations = buildAnnotationSections(ctx, blocks);
        assert.equal(annotations.footnotes.length, 3);
        assert.deepStrictEqual(annotations.footnotes.map(f => f.id), ['1', '2', 'e1']);
        assert.deepStrictEqual(annotations.footnotes.map(f => f.index), [1, 2, 3]);
        assert.equal(blocks[0].runs[1].id, '1');
        assert.equal(blocks[0].runs[2].id, 'e1');
    });

    test('comment ranges become paired markers', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>commented</w:t></w:r><w:commentRangeEnd w:id="7"/></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const blocks = walkBody(bodyOf(reader), ctxFor(reader));
        assert.deepStrictEqual(blocks[0].runs, [
            { type: 'commentRangeStart', id: '7' },
            { text: 'commented' },
            { type: 'commentRangeEnd', id: '7' }
        ]);
    });

    test('tracked insertions/deletions keep author/date and register revisions', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:t>before </w:t></w:r><w:ins w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:t>new </w:t></w:r></w:ins>' +
            '<w:del w:author="Bob" w:date="2026-01-02T00:00:00Z"><w:r><w:t>old </w:t></w:r></w:del><w:r><w:t>after</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.deepStrictEqual(blocks[0].runs, [
            { text: 'before ' },
            { type: 'insRun', text: 'new ', author: 'Ada', date: '2026-01-01T00:00:00Z' },
            { type: 'delRun', text: 'old ', author: 'Bob', date: '2026-01-02T00:00:00Z' },
            { text: 'after' }
        ]);
        const annotations = buildAnnotationSections(ctx, blocks);
        assert.deepStrictEqual(annotations.revisions, [
            { kind: 'insert', author: 'Ada', date: '2026-01-01T00:00:00Z' },
            { kind: 'delete', author: 'Bob', date: '2026-01-02T00:00:00Z' }
        ]);
    });

    test('rPrChange surfaces as a format change revision', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:r><w:rPr><w:b/><w:rPrChange w:author="Ada" w:date="2026-01-01T00:00:00Z"/></w:rPr><w:t>bold now</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        assert.deepStrictEqual(blocks[0].runs, [{
            text: 'bold now',
            bold: true,
            formatChange: { author: 'Ada', date: '2026-01-01T00:00:00Z' }
        }]);
        const annotations = buildAnnotationSections(ctx, blocks);
        assert.deepStrictEqual(annotations.revisions, [
            { kind: 'format', author: 'Ada', date: '2026-01-01T00:00:00Z' }
        ]);
    });
});

// ─── Determinism (acceptance) ─────────────────────────────────────────────────

describe('determinism', () => {
    test('same bytes produce an identical model', async () => {
        const xml = DOC_HEADER +
            '<w:p><w:pPr><w:jc w:val="both"/><w:pStyle w:val="Heading2"/></w:pPr>' +
            '<w:r><w:rPr><w:b/><w:color w:val="00FF00"/></w:rPr><w:t>green bold</w:t></w:r>' +
            '<w:hyperlink r:id="rId5"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>' +
            '<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>li</w:t></w:r></w:p>' +
            DOC_FOOTER;
        const NUMBERING =
            '<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
            '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>' +
            '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

        const zipBytes = makeDocx({
            'word/document.xml': xml,
            'word/_rels/document.xml.rels': RELS_XML,
            'word/numbering.xml': NUMBERING
        });

        async function run() {
            const parts = await unzipParts(zipBytes);
            const reader = createReader(parts);
            const ctx = ctxFor(reader);
            ctx.rels = parseRels(reader.getPart('word/_rels/document.xml.rels'));
            const blocks = walkBody(bodyOf(reader), ctx);
            return JSON.stringify({ blocks, warnings: buildWarnings(ctx.warnings), pageSetup: ctx.pageSetup });
        }

        const first = await run();
        const second = await run();
        assert.equal(first, second);
        assert.ok(first.includes('"green bold"'));
    });
});

describe('bug fix regressions', () => {
    test('parses body-level and run-level mc:AlternateContent', async () => {
        const xml = DOC_HEADER +
            '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
            '<mc:Choice Requires="w14">' +
            '<w:p><w:r><w:t>Modern AlternateContent Text</w:t></w:r></w:p>' +
            '</mc:Choice>' +
            '</mc:AlternateContent>' +
            DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'word/document.xml': xml }));
        const reader = createReader(parts);
        const ctx = ctxFor(reader);
        const blocks = walkBody(bodyOf(reader), ctx);
        const pBlock = blocks.find(b => b.type === 'paragraph');
        assert.ok(pBlock);
        assert.equal(pBlock.runs[0].text, 'Modern AlternateContent Text');
    });

    test('case-insensitive part lookup and BOM stripping', async () => {
        const xmlWithBOM = '\uFEFF' + DOC_HEADER + '<w:p><w:r><w:t>BOM text</w:t></w:r></w:p>' + DOC_FOOTER;
        const parts = await unzipParts(makeDocx({ 'Word/Document.xml': xmlWithBOM }));
        const reader = createReader(parts);
        const doc = reader.getPart('word/document.xml');
        assert.ok(doc);
        const ctx = ctxFor(reader);
        const blocks = walkBody(doc.getElementsByTagNameNS(NS.w, 'body')[0], ctx);
        assert.equal(blocks[0].runs[0].text, 'BOM text');
    });
});