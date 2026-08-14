/**
 * golden.test.js — M4 round-trip corpus.
 *
 * For every fixture in tests/fixtures/*.docx: import → export → import and
 * assert the canonical models are structurally identical. This closes the
 * fidelity loop for the M4 content-critical features (nested lists with
 * `start`, external + anchor links, inline images at known sizes).
 *
 * Runs headless: jsdom provides DOMParser/Node, `docx` runs in node, and
 * `fflate` reads the packages. No browser required.
 */

import { test, describe } from 'node:test';
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
    buildWarnings,
    loadAnnotationParts,
    buildAnnotationSections
} from '../js/editor/ooxml.js';
import { modelToDocxBuffer } from '../js/editor/docxExport.js';
import { normalizeModel, DEFAULT_FONT_FAMILY } from '../js/editor/model.js';

const dom = new JSDOM('<!DOCTYPE html>');
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.document = dom.window.document;

const FIXTURES_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const FIXTURES = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.docx'))
    .sort();

function readFixture(name) {
    const buf = readFileSync(join(FIXTURES_DIR, name));
    return new Uint8Array(buf);
}

/**
 * Imports .docx bytes into a normalized canonical model (mirrors
 * docxImport.importDocx but headless and dependency-free).
 * @param {Uint8Array} bytes
 * @returns {Promise<object>} normalized model
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
    const title = getCoreTitle(reader);

    return normalizeModel({
        title: title || 'Fixture',
        blocks,
        footnotes: annotations.footnotes,
        comments: annotations.comments,
        revisions: annotations.revisions,
        pageFormat: ctx.pageSetup && ctx.pageSetup.format !== 'custom' ? ctx.pageSetup.format : 'a4',
        fontFamily: DEFAULT_FONT_FAMILY,
        updatedAt: 1700000000000
    });
}

/**
 * Structural signature covering the M4-fidelity keys (lists, links, images).
 * Image payloads are compared by bytes (data-URL round-trips byte-identically).
 * @param {object} model
 * @returns {object}
 */
function fidelitySignature(model) {
    const runSig = run => {
        const r = {};
        for (const k of ['text', 'image', 'alt', 'href', 'internal', 'width', 'height', 'type', 'id']) {
            if (run[k] !== undefined) r[k] = run[k];
        }
        return r;
    };
    const blockSig = block => {
        const out = { type: block.type };
        const listKeys = ['listType', 'level', 'start'];
        for (const k of listKeys) if (block[k] !== undefined) out[k] = block[k];
        if (block.href !== undefined) out.href = block.href;
        if (block.internal !== undefined) out.internal = block.internal;
        if (block.src !== undefined) out.src = block.src;
        if (block.width !== undefined) out.width = block.width;
        if (block.height !== undefined) out.height = block.height;
        if (Array.isArray(block.runs)) out.runs = block.runs.map(runSig);
        if (block.type === 'section') {
            for (const k of ['pageFormat', 'orientation', 'widthMM', 'heightMM', 'margins', 'pageNumbering']) {
                if (block[k] !== undefined) out[k] = block[k];
            }
            if (Array.isArray(block.header)) {
                out.header = block.header.map(hb => ({
                    type: hb.type,
                    runs: hb.runs ? hb.runs.map(runSig) : undefined
                }));
            }
            if (Array.isArray(block.footer)) {
                out.footer = block.footer.map(fb => ({
                    type: fb.type,
                    runs: fb.runs ? fb.runs.map(runSig) : undefined
                }));
            }
        }
        if (block.type === 'table') {
            out.cols = block.cols;
            out.rows = block.rows.map(row => row.map(cell => {
                if (cell && typeof cell === 'object') {
                    return {
                        text: cell.text,
                        gridSpan: cell.gridSpan,
                        shading: cell.shading,
                        vMerge: cell.vMerge
                    };
                }
                return cell;
            }));
        }
        return out;
    };
    return {
        pageFormat: model.pageFormat,
        blocks: model.blocks.map(blockSig)
    };
}

describe('M4 golden round-trip corpus', () => {
    test('fixtures exist and are non-empty', () => {
        assert.ok(FIXTURES.includes('lists-start.docx'), 'lists-start.docx missing');
        assert.ok(FIXTURES.includes('links.docx'), 'links.docx missing');
        assert.ok(FIXTURES.includes('images.docx'), 'images.docx missing');
        assert.ok(FIXTURES.includes('tables.docx'), 'tables.docx missing');
        assert.ok(FIXTURES.includes('header-footer.docx'), 'header-footer.docx missing');
        assert.ok(FIXTURES.includes('page-size.docx'), 'page-size.docx missing');
    });

    for (const name of FIXTURES) {
        test(`${name}: import → export → import is structurally identical`, async () => {
            const bytes = readFixture(name);

            const model1 = await importDocxToModel(bytes);
            assert.ok(model1.blocks.length > 0, 'fixture imported no blocks');

            const exported = await modelToDocxBuffer(model1);
            assert.ok(exported instanceof Uint8Array && exported.length > 0, 'export produced no bytes');

            const model2 = await importDocxToModel(exported);

            assert.deepStrictEqual(
                fidelitySignature(model2),
                fidelitySignature(model1),
                `round-trip changed the model for ${name}`
            );
        });
    }
});
