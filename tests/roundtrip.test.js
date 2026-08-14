/**
 * roundtrip.test.js — M7 fidelity harness.
 *
 * For every fixture in tests/fixtures/*.docx:
 *   1. import → export → import and assert the strict canonical models are
 *      identical (repair invariant: an unchanged document comes back unchanged);
 *   2. assert repeated exports of the same model are byte-identical (the
 *      deterministic-export invariant, including pinned core.xml timestamps);
 *   3. report a per-feature PASS/FAIL table driven by tests/matrix.json, the
 *      authoritative fidelity matrix.
 *
 * Also round-trips a synthetic 500-paragraph document as a memory/performance
 * guard and validates that every feature marked OK in the matrix is actually
 * covered by at least one fixture assertion.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
    NS,
    unzipParts,
    createReader,
    parseRels,
    getCoreTitle,
    walkBody,
    loadAnnotationParts,
    buildAnnotationSections,
    getDocDefaultFont
} from '../js/editor/ooxml.js';
import { modelToDocxBuffer } from '../js/editor/docxExport.js';
import { normalizeModel, canonicalModel, DEFAULT_FONT_FAMILY } from '../js/editor/model.js';

const dom = new JSDOM('<!DOCTYPE html>');
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.document = dom.window.document;

const FIXTURES_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const MATRIX_URL = new URL('./matrix.json', import.meta.url);
const FIXTURES = readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.docx')).sort();
const matrix = JSON.parse(readFileSync(MATRIX_URL, 'utf8'));
const features = matrix.features;

/**
 * Imports .docx bytes into a normalized canonical model, returning the model
 * and the document's declared default font (used to fold inherited fonts away).
 * @param {Uint8Array} bytes
 * @returns {Promise<{model:object, defaultFont:string|undefined}>}
 */
async function importDocxToModel(bytes) {
    const parts = await unzipParts(bytes);
    const warnings = [];
    const reader = createReader(parts, warnings);

    const documentXml = reader.getPart('word/document.xml');
    const ctx = {
        reader,
        rels: new Map(),
        warnings,
        bookmarks: new Map(),
        bookmarkIds: new Set(),
        pageSetup: null,
        numbering: null,
        change: null
    };
    const relsDoc = reader.getPart('word/_rels/document.xml.rels');
    if (relsDoc) ctx.rels = parseRels(relsDoc);
    loadAnnotationParts(ctx);

    const bodyEl = documentXml ? documentXml.getElementsByTagNameNS(NS.w, 'body')[0] : null;
    const blocks = bodyEl ? walkBody(bodyEl, ctx) : [];
    const annotations = buildAnnotationSections(ctx, blocks);
    const firstSection = blocks.find(b => b && b.type === 'section');

    return {
        model: normalizeModel({
            title: getCoreTitle(reader) || 'Fixture',
            blocks,
            footnotes: annotations.footnotes,
            comments: annotations.comments,
            revisions: annotations.revisions,
            pageFormat: firstSection && firstSection.pageFormat !== 'custom' ? firstSection.pageFormat : 'a4',
            fontFamily: DEFAULT_FONT_FAMILY,
            updatedAt: 1700000000000
        }),
        defaultFont: getDocDefaultFont(ctx)
    };
}

// ─── Per-feature signatures ───────────────────────────────────────────────────
// Each feature extracts a structural signature from a model; the round-trip
// assertion is deep-equality of model1's and model2's signatures. Runs inherit
// the document default font unless an explicit font is set, so `defaultFont`
// is folded away exactly as in canonicalModel.

function runSignature(run, defaultFont) {
    if (!run || typeof run !== 'object') return run;
    const out = {};
    for (const k of ['text', 'type', 'id', 'href', 'internal', 'image', 'alt', 'width', 'height', 'author', 'date']) {
        if (run[k] !== undefined) out[k] = run[k];
    }
    for (const flag of ['bold', 'italic', 'underline', 'strikethrough', 'superscript', 'subscript']) {
        if (run[flag]) out[flag] = true;
    }
    if (run.color) out.color = run.color;
    if (run.backgroundColor) out.backgroundColor = run.backgroundColor;
    if (run.fontSize) out.fontSize = run.fontSize;
    if (run.fontFamily && run.fontFamily !== defaultFont) out.fontFamily = run.fontFamily;
    if (run.formatChange) out.formatChange = run.formatChange;
    return out;
}

function blockRuns(block, defaultFont) {
    return (block.runs || []).map(r => runSignature(r, defaultFont));
}

const featureExtractors = {
    paragraphs(model, df) {
        return model.blocks
            .filter(b => b && (b.type === 'paragraph' || b.type === 'heading'))
            .map(b => ({ type: b.type, level: b.level, runs: blockRuns(b, df) }));
    },
    'inline-format'(model, df) {
        const out = [];
        const visit = runs => (runs || []).forEach(r => {
            const sig = runSignature(r, df);
            for (const flag of ['bold', 'italic', 'underline', 'strikethrough', 'superscript', 'subscript']) {
                if (sig[flag]) out.push(flag);
            }
        });
        model.blocks.forEach(b => visit(b && b.runs));
        (model.footnotes || []).forEach(fn => (fn.blocks || []).forEach(b => visit(b && b.runs)));
        return out.sort();
    },
    colors(model, df) {
        const out = [];
        const visit = runs => (runs || []).forEach(r => {
            if (r && r.color) out.push(`fg:${r.color}`);
            if (r && r.backgroundColor) out.push(`bg:${r.backgroundColor}`);
        });
        model.blocks.forEach(b => visit(b && b.runs));
        (model.footnotes || []).forEach(fn => (fn.blocks || []).forEach(b => visit(b && b.runs)));
        return out.sort();
    },
    fonts(model, df) {
        const out = [];
        const visit = runs => (runs || []).forEach(r => {
            if (r && r.fontFamily && r.fontFamily !== df) out.push(r.fontFamily);
            if (r && r.fontSize) out.push(r.fontSize);
        });
        model.blocks.forEach(b => visit(b && b.runs));
        (model.footnotes || []).forEach(fn => (fn.blocks || []).forEach(b => visit(b && b.runs)));
        return out.sort();
    },
    alignment(model) {
        return model.blocks
            .filter(b => b && b.align)
            .map(b => b.align)
            .sort();
    },
    lists(model) {
        return model.blocks
            .filter(b => b && b.type === 'listItem')
            .map(b => ({ listType: b.listType, level: b.level, start: b.start, text: (b.runs || []).map(r => r.text).join('') }));
    },
    links(model, df) {
        const out = [];
        model.blocks.forEach(b => {
            (b.runs || []).forEach(r => {
                if (r && r.href) out.push({ href: r.href, internal: !!r.internal, text: r.text });
            });
            if (b.type === 'link') out.push({ href: b.href, internal: !!b.internal });
        });
        return out;
    },
    images(model, df) {
        const out = [];
        const visit = runs => (runs || []).forEach(r => {
            if (r && r.image) out.push({ image: r.image, width: r.width, height: r.height, alt: r.alt });
        });
        model.blocks.forEach(b => {
            visit(b && b.runs);
            if (b && b.type === 'image') out.push({ image: b.src, width: b.width, height: b.height });
        });
        return out;
    },
    tables(model) {
        return model.blocks.filter(b => b && b.type === 'table').map(b => ({
            cols: b.cols,
            rows: (b.rows || []).map(row => row.map(cell => {
                if (cell && typeof cell === 'object') {
                    return { text: cell.text, gridSpan: cell.gridSpan, shading: cell.shading, vMerge: cell.vMerge };
                }
                return cell;
            }))
        }));
    },
    'page-setup'(model) {
        return model.blocks.filter(b => b && b.type === 'section').map(s => ({
            pageFormat: s.pageFormat,
            orientation: s.orientation,
            widthMM: s.widthMM,
            heightMM: s.heightMM,
            margins: s.margins,
            pageNumbering: s.pageNumbering
        }));
    },
    'headers-footers'(model, df) {
        const out = [];
        model.blocks.filter(b => b && b.type === 'section').forEach(s => {
            (s.header || []).forEach(h => out.push({ part: 'header', runs: blockRuns(h, df) }));
            (s.footer || []).forEach(f => out.push({ part: 'footer', runs: blockRuns(f, df) }));
        });
        return out;
    },
    'page-numbers'(model) {
        const out = [];
        const visit = runs => (runs || []).forEach(r => { if (r && r.type === 'pageNumber') out.push('page'); });
        model.blocks.forEach(b => {
            visit(b && b.runs);
            if (b && b.type === 'section') {
                (b.header || []).forEach(h => visit(h && h.runs));
                (b.footer || []).forEach(f => visit(f && f.runs));
            }
        });
        return out;
    },
    footnotes(model, df) {
        return (model.footnotes || []).map(fn => ({
            id: fn.id,
            blocks: (fn.blocks || []).map(b => ({ type: b.type, runs: blockRuns(b, df) }))
        }));
    },
    comments(model) {
        return (model.comments || []).map(c => ({ id: c.id, author: c.author, date: c.date, text: c.text }));
    },
    revisions(model) {
        return (model.revisions || []).map(r => ({ kind: r.kind, author: r.author, date: r.date }));
    },
    styles(model, df) {
        return model.blocks
            .filter(b => b && b.type === 'heading')
            .map(b => b.level)
            .sort();
    }
};

const FEATURE_ORDER = features.map(f => f.code);

function featureSignatures(model, defaultFont) {
    const out = {};
    for (const code of FEATURE_ORDER) {
        const fn = featureExtractors[code];
        out[code] = fn ? fn(model, defaultFont) : undefined;
    }
    return out;
}

// ─── Synthetic document (memory / performance guard) ─────────────────────────

function buildSyntheticModel() {
    const blocks = [];
    for (let i = 1; i <= 500; i++) {
        blocks.push({
            type: 'heading',
            level: 2,
            runs: [{
                text: `Section ${i}`,
                color: '#2E74B5',
                fontSize: '13pt'
            }]
        });
        const text = 'Paragraph ' + i + '. ' +
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
            'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ' +
            'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.';
        if (i === 1) {
            blocks.push({
                type: 'paragraph',
                runs: [
                    { type: 'commentRangeStart', id: '5' },
                    { type: 'insRun', text, author: 'QA', date: '2026-01-01T00:00:00Z' },
                    { type: 'commentRangeEnd', id: '5' },
                    { type: 'footnoteRef', id: '1' }
                ]
            });
        } else {
            blocks.push({ type: 'paragraph', runs: [{ text }] });
        }
    }
    blocks.push({
        type: 'section',
        pageFormat: 'a4',
        orientation: 'portrait',
        widthMM: 210,
        heightMM: 297,
        margins: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
        pageNumbering: true,
        headerDistance: 12.5,
        footerDistance: 12.5
    });
    return normalizeModel({
        title: 'Synthetic 500',
        blocks,
        footnotes: [{ id: '1', index: 1, blocks: [{ type: 'paragraph', runs: [{ text: 'synthetic note' }] }] }],
        comments: [{ id: '5', author: 'QA', date: '2026-01-01T00:00:00.000Z', text: 'synthetic comment' }],
        revisions: [{ kind: 'insert', author: 'QA', date: '2026-01-01T00:00:00Z' }],
        pageFormat: 'a4',
        fontFamily: DEFAULT_FONT_FAMILY,
        updatedAt: 1700000000000
    });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const results = {};

describe('M7 round-trip fidelity harness', () => {
    test('fixtures exist', () => {
        assert.ok(FIXTURES.includes('annotations.docx'), 'annotations.docx missing');
        assert.ok(FIXTURES.includes('formatting.docx'), 'formatting.docx missing');
        assert.ok(FIXTURES.includes('lists-start.docx'), 'lists-start.docx missing');
    });

    for (const name of FIXTURES) {
        test(`${name}: repair invariant (import∘export∘import ≡ import)`, async () => {
            const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, name)));
            const { model: model1, defaultFont: df1 } = await importDocxToModel(bytes);
            assert.ok(model1.blocks.length > 0, 'fixture imported no blocks');

            const exported = await modelToDocxBuffer(model1);
            assert.ok(exported instanceof Uint8Array && exported.length > 0, 'export produced no bytes');

            const { model: model2, defaultFont: df2 } = await importDocxToModel(exported);

            results[name] = {
                canonicalEqual: canonicalModel(model1, df1) === canonicalModel(model2, df2),
                sig1: featureSignatures(model1, df1),
                sig2: featureSignatures(model2, df2)
            };

            assert.equal(
                canonicalModel(model1, df1),
                canonicalModel(model2, df2),
                `repair invariant violated for ${name}: exported-then-reimported model differs`
            );
        });

        test(`${name}: deterministic export (repeated export is byte-identical)`, async () => {
            const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, name)));
            const { model } = await importDocxToModel(bytes);
            const a = await modelToDocxBuffer(model);
            const b = await modelToDocxBuffer(model);
            assert.ok(Buffer.from(a).equals(Buffer.from(b)), `export not byte-stable for ${name}`);
        });
    }

    test('synthetic 500-paragraph document round-trips', async () => {
        const model1 = buildSyntheticModel();
        const exported = await modelToDocxBuffer(model1);
        const { model: model2, defaultFont } = await importDocxToModel(exported);
        assert.equal(canonicalModel(model1), canonicalModel(model2, defaultFont), 'synthetic doc drifted');
        const again = await modelToDocxBuffer(model1);
        assert.ok(Buffer.from(exported).equals(Buffer.from(again)), 'synthetic export not byte-stable');
    });

    test('every OK feature is exercised and passes across the corpus', () => {
        const exercised = new Set();
        for (const r of Object.values(results)) {
            for (const code of FEATURE_ORDER) {
                const sig1 = r.sig1[code];
                const sig2 = r.sig2[code];
                if (sig1 === undefined) continue;
                assert.deepEqual(sig2, sig1, `feature ${code} round-trip drifted`);
                if (JSON.stringify(sig1) !== '[]' && JSON.stringify(sig1) !== '{}') exercised.add(code);
            }
        }
        const okFeatures = features.filter(f => f.roundtrip === 'OK' && f.roundtrip !== 'PARTIAL').map(f => f.code);
        const missing = okFeatures.filter(code => !exercised.has(code));
        assert.deepEqual(missing, [], `OK features never exercised by corpus: ${missing.join(', ')}`);
    });
});

after(() => {
    const width = code => Math.max(...FEATURE_ORDER.map(c => c.length)) + 2;
    const status = features.map(f => {
        const passed = Object.values(results).every(r => {
            const s1 = r.sig1[f.code];
            const s2 = r.sig2[f.code];
            return s1 === undefined || JSON.stringify(s1) === JSON.stringify(s2);
        });
        return { code: f.code, label: f.label, roundtrip: f.roundtrip, exercised: passed ? 'PASS' : 'FAIL' };
    });

    console.log('\nPer-feature fidelity report (matrix.json):');
    console.log(features.map(f => `  ${f.label.padEnd(38)} ${f.roundtrip.padEnd(8)} round-trip`).join('\n'));
    const failed = status.filter(s => s.exercised === 'FAIL');
    if (failed.length) {
        console.log('\nFAILED features: ' + failed.map(f => f.code).join(', '));
    } else {
        console.log('\nAll features round-trip cleanly across the corpus.');
    }
    for (const name of FIXTURES) {
        const r = results[name];
        console.log(`  ${name} ${r ? (r.canonicalEqual ? 'PASS' : 'FAIL') : '?'}`);
    }
});
