/**
 * docxImport.js — DOCX import orchestration + side effects.
 *
 * Lazy lib loading, file I/O, title extraction, calling `renderDocument`,
 * `saveContent` and toast plumbing. All parsing lives in `ooxml.js` (pure);
 * this module wires the pipeline to the running editor.
 */

import { state } from './state.js';
import { normalizeModel, DEFAULT_FONT_FAMILY } from './model.js';
import { renderDocument, saveContent } from './document.js';
import { paginate } from './pagination.js';
import { applyPageFormat } from './ui.js';
import {
    unzipParts,
    createReader,
    parseRels,
    getCoreTitle,
    walkBody,
    buildWarnings,
    warn,
    loadFflate,
    loadAnnotationParts,
    buildAnnotationSections,
    NS,
    WARNINGS
} from './ooxml.js';
import { showToast } from './toast.js';

/**
 * Soft cap on import size. Larger files are still imported (never blocked),
 * but the user is warned up front since unzipping + parsing large packages can
 * take a while. Intentionally below typical browser memory limits.
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/**
 * Loads the OOXML libraries on demand (fflate). First import only.
 * @returns {Promise<object>}
 */
export function ensureOoxmlLib() {
    return loadFflate();
}

/**
 * Full DOCX import pipeline.
 * @param {File} file
 * @returns {Promise<{blocks:object[], pageFormat:string|null, orientation:string|null, title:string|null, warnings:object[]}>}
 */
export async function importDocx(file) {
    const warnings = [];
    const buffer = await file.arrayBuffer();
    if (file.size > MAX_IMPORT_BYTES) {
        warnings.push({
            code: 'LARGE_FILE',
            message: `This file is large (${(file.size / 1048576).toFixed(1)} MB); import may take a moment.`
        });
    }
    const parts = await unzipParts(buffer);

    const reader = createReader(parts, warnings);

    const documentXml = reader.getPart('word/document.xml');
    if (!documentXml) {
        throw { code: 'XML_PARSE_ERROR', message: WARNINGS.XML_PARSE_ERROR.message };
    }

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
    if (relsDoc) {
        ctx.rels = parseRels(relsDoc);
    } else {
        warn(ctx, 'MISSING_RELS');
    }

    loadAnnotationParts(ctx);

    const bodyEl = documentXml.getElementsByTagNameNS(NS.w, 'body')[0];
    const blocks = bodyEl ? walkBody(bodyEl, ctx) : [];

    const title = getCoreTitle(reader);

    const annotations = buildAnnotationSections(ctx, blocks);

    const firstSection = blocks.find(b => b && b.type === 'section');
    const section = firstSection || (ctx.pageSetup ? {
        pageFormat: ctx.pageSetup.format,
        orientation: ctx.pageSetup.orientation
    } : null);

    return {
        blocks,
        footnotes: annotations.footnotes,
        comments: annotations.comments,
        revisions: annotations.revisions,
        pageFormat: section && section.pageFormat !== 'custom' ? section.pageFormat : null,
        orientation: section ? section.orientation : null,
        title,
        warnings: buildWarnings(warnings)
    };
}

/**
 * Applies a successful import to the running document: title, page format,
 * model stash, re-render, paginate, save, and a summary toast.
 * @param {object} result
 * @returns {string} the new document title
 */
export function applyImportResult(result) {
    const existingTitle = state.currentDoc.title || 'Untitled document';
    state.currentDoc.title = result.title || existingTitle;

    const titleInput = document.getElementById('document-title');
    if (titleInput) titleInput.value = state.currentDoc.title;

    if (result.pageFormat && result.pageFormat !== 'custom') {
        applyPageFormat(result.pageFormat);
    }

    const model = normalizeModel({
        title: state.currentDoc.title,
        blocks: result.blocks,
        footnotes: result.footnotes || [],
        comments: result.comments || [],
        revisions: result.revisions || [],
        pageFormat: state.currentDoc.pageFormat || 'a4',
        fontFamily: state.currentDoc.fontFamily || DEFAULT_FONT_FAMILY,
        updatedAt: Date.now()
    });

    state.currentDoc.model = model;
    state.currentDoc.content = [];

    renderDocument({ ...state.currentDoc, content: [] });
    paginate();
    saveContent();

    const summary = [];
    const tables = result.blocks.filter(b => b && b.type === 'table').length;
    if (tables > 0) summary.push(`${tables} table${tables === 1 ? '' : 's'} imported`);
    if ((result.footnotes || []).length > 0) summary.push(`${result.footnotes.length} footnote${result.footnotes.length === 1 ? '' : 's'} preserved`);
    if ((result.comments || []).length > 0) summary.push(`${result.comments.length} comment${result.comments.length === 1 ? '' : 's'} preserved`);
    if ((result.revisions || []).length > 0) summary.push(`${result.revisions.length} tracked change${result.revisions.length === 1 ? '' : 's'} preserved`);
    summary.push(...result.warnings.map(w => w.message));

    showToast(`Imported "${state.currentDoc.title}"`, summary);
    return state.currentDoc.title;
}

/**
 * Handles a dropped/selected `.docx` file: validates, imports, and applies.
 * Shows an error toast (without touching the active document) on failure.
 * @param {File} file
 */
export async function handleDocxFile(file) {
    if (!file || !/\.docx$/i.test(file.name)) {
        showToast('Not a .docx file');
        return;
    }
    try {
        await ensureOoxmlLib();
        const result = await importDocx(file);
        applyImportResult(result);
    } catch (err) {
        const message = (err && err.message) ? err.message : 'The file could not be opened.';
        showToast(`Could not open file: ${message}`);
    }
}

// ─── Toast plumbing ───────────────────────────────────────────────────────────
// `showToast` lives in toast.js (shared with docxExport) and is re-exported
// here for callers that already import it from docxImport.

export { showToast };