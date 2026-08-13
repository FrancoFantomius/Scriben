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
    NS,
    WARNINGS
} from './ooxml.js';

/**
 * Opt-in fallback to mammoth behind a flag. Disabled by default; the mammoth
 * code path is a candidate for removal in M7 if it never earns a keep.
 */
export const FALLBACK_TO_MAMMOTH = false;

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
    const buffer = await file.arrayBuffer();
    const parts = await unzipParts(buffer);

    const warnings = [];
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
        numbering: null
    };

    const relsDoc = reader.getPart('word/_rels/document.xml.rels');
    if (relsDoc) {
        ctx.rels = parseRels(relsDoc);
    } else {
        warn(ctx, 'MISSING_RELS');
    }

    const bodyEl = documentXml.getElementsByTagNameNS(NS.w, 'body')[0];
    const blocks = bodyEl ? walkBody(bodyEl, ctx) : [];

    const title = getCoreTitle(reader);

    return {
        blocks,
        pageFormat: ctx.pageSetup ? ctx.pageSetup.format : null,
        orientation: ctx.pageSetup ? ctx.pageSetup.orientation : null,
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
        pageFormat: state.currentDoc.pageFormat || 'a4',
        fontFamily: state.currentDoc.fontFamily || DEFAULT_FONT_FAMILY,
        updatedAt: Date.now()
    });

    state.currentDoc.model = model;
    state.currentDoc.content = [];

    renderDocument({ ...state.currentDoc, content: [] });
    paginate();
    saveContent();

    showToast(`Imported "${state.currentDoc.title}"`, result.warnings.map(w => w.message));
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

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Shows a small stacked toast with an optional list of warning lines
 * (max 5 shown, then "and N more").
 * @param {string} title
 * @param {string[]} [lines]
 */
export function showToast(title, lines = []) {
    let container = document.getElementById('scriben-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'scriben-toast-container';
        container.style.cssText = [
            'position: fixed',
            'bottom: 24px',
            'left: 50%',
            'transform: translateX(-50%)',
            'z-index: 20000',
            'display: flex',
            'flex-direction: column',
            'gap: 8px',
            'align-items: center',
            'font-family: var(--font-ui, "Google Sans", sans-serif)',
            'pointer-events: none'
        ].join('; ');
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.style.cssText = [
        'background: var(--color-dropdown-bg, #ffffff)',
        'color: var(--color-text, #202124)',
        'border: 1px solid var(--color-toolbar-border, #dadce0)',
        'border-radius: 8px',
        'box-shadow: 0 4px 12px rgba(0,0,0,0.18)',
        'padding: 12px 16px',
        'max-width: 440px',
        'font-size: 13px',
        'line-height: 1.45',
        'box-sizing: border-box',
        'pointer-events: auto'
    ].join('; ');

    let html = `<div style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(title)}</div>`;
    const shown = lines.slice(0, 5);
    if (shown.length > 0) {
        html += '<div style="color: var(--color-text-secondary, #5f6368);">';
        html += shown.map(l => `• ${escapeHtml(l)}`).join('<br>');
        if (lines.length > shown.length) {
            html += `<br>and ${lines.length - shown.length} more`;
        }
        html += '</div>';
    }
    toast.innerHTML = html;

    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 6000);
}