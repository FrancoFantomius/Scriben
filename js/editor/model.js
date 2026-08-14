/**
 * model.js — Canonical block-based document model.
 *
 * The single source of truth for document content, decoupled from pagination.
 * Pure functions only: no DOM access, no side effects.
 *
 * Block node types:
 *   paragraph, heading, listItem, image, link, table, pageBreak,
 *   horizontalRule, section (and later footnote / comment / trackedChange).
 *
 *   - listItem: `{ listType: 'ordered'|'unordered', level, start? }`. Nested
 *     lists are flattened into consecutive listItem blocks; `level` is the
 *     nesting depth and `start` (ordered, level 0 only) the first number.
 *   - image: `{ src, alt?, width?, height? }` with `width`/`height` in CSS
 *     lengths matching the drawn size at save/import time.
 *
 * Inline model: text runs carrying formatting flags. Runs may additionally
 * carry `href` (inline link), `image` (inline image src) and `\n` text for
 * `<br>` hard breaks so that real editor DOM round-trips losslessly.
 *
 * Marker runs: `{ type: 'pageNumber' }` (inside a section's header/footer,
 * telling the export engine where to emit a PAGE field), `{ type: 'footnoteRef',
 * id, index }` (body footnote reference), `{ type: 'commentRangeStart'/'commentRangeEnd',
 * id }` (comment range delimiters). Markers carry no text and survive
 * normalization/merging. Tracked-change runs (`{ type: 'insRun' }` / `{ type:
 * 'delRun' }`) wrap text with `author`/`date`; `formatChange: { author, date }`
 * on a run records a prior-formatting revision.
 *
 * Annotation content lives in sibling arrays on the document:
 * `doc.footnotes` (`{ id, index, blocks[] }`), `doc.comments`
 * (`{ id, author, date, text }`) and `doc.revisions`
 * (`{ id, kind, author, date }`). They are preserved by the exporter and
 * re-attached to runs by the inline markers.
 *
 * Table cells: a plain string (HTML-authored tables) or an object
 * `{ text?, shading?, gridSpan?, vMerge?, width? }` for OOXML-imported
 * tables (merged cells, shading).
 *
 * Section blocks carry exact page setup plus the blocks of their header and
 * footer chrome. `pageFormat` may be `'custom'` here; the document-level
 * `pageFormat` (model.pageFormat) stays one of VALID_PAGE_FORMATS.
 */

export const VALID_PAGE_FORMATS = ['a4', 'a5', 'letter', 'legal'];

/**
 * Soft cap for a single embedded image's Base64 payload (characters).
 * Larger images bloat PouchDB documents; callers should warn, not fail.
 */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;

export const DEFAULT_FONT_FAMILY = "'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari', 'Noto Sans CJK TC', 'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', 'Noto Color Emoji', sans-serif";

export const BLOCK_TYPES = new Set([
    'paragraph',
    'heading',
    'listItem',
    'image',
    'link',
    'table',
    'pageBreak',
    'horizontalRule',
    'section'
]);

export const INLINE_FLAGS = [
    'bold',
    'italic',
    'underline',
    'strikethrough',
    'superscript',
    'subscript'
];

export const INLINE_KEYS = [
    ...INLINE_FLAGS,
    'color',
    'backgroundColor',
    'fontFamily',
    'fontSize',
    'href',
    'internal',
    'target',
    'image',
    'alt',
    'width',
    'height'
];

/**
 * Run types that are pure markers: they carry no text, are never merged with
 * neighbors and survive normalization verbatim.
 */
export const MARKER_TYPES = new Set(['pageNumber', 'footnoteRef', 'commentRangeStart', 'commentRangeEnd']);

/**
 * Run types that wrap text on behalf of a tracked change. They are preserved
 * verbatim (never merged) so each keeps its author/date metadata.
 */
export const TRACKED_RUN_TYPES = new Set(['insRun', 'delRun']);

export const REVISION_KINDS = ['insert', 'delete', 'format'];

const DEFAULT_TITLE = 'Untitled document';

/**
 * Returns an empty canonical model.
 * @param {string} [title]
 * @returns {object}
 */
export function emptyModel(title = '') {
    return {
        title: typeof title === 'string' ? title : '',
        blocks: [],
        pageFormat: 'a4',
        fontFamily: DEFAULT_FONT_FAMILY,
        footnotes: [],
        comments: [],
        revisions: [],
        updatedAt: Date.now()
    };
}

function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
    return fallback;
}

function copyIfPresent(target, source, keys) {
    for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null) target[key] = source[key];
    }
}

/**
 * Compares two runs by their formatting keys (ignores `text`).
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function runsEqual(a, b) {
    return INLINE_KEYS.every(k => a[k] === b[k]);
}

/**
 * Merges adjacent runs with identical formatting into single runs.
 * Drops empty text runs. Marker runs (pageNumber, footnoteRef,
 * commentRangeStart, commentRangeEnd) and tracked-change runs (insRun,
 * delRun) are preserved verbatim and never merged with neighbors. Returns a
 * new array (does not mutate input).
 * @param {object[]} runs
 * @returns {object[]}
 */
export function mergeRuns(runs) {
    const out = [];
    for (const run of runs) {
        if (!run || typeof run !== 'object') continue;
        if (MARKER_TYPES.has(run.type) || TRACKED_RUN_TYPES.has(run.type) || run.formatChange) {
            out.push({ ...run });
            continue;
        }
        if (run.image === undefined && run.text === undefined) continue;
        if (run.image === undefined && run.text === '') continue;

        const prev = out[out.length - 1];
        if (prev && !prev.type && !prev.formatChange && !prev.image && !run.image && runsEqual(prev, run)) {
            prev.text += run.text;
        } else {
            out.push({ ...run });
        }
    }
    return out;
}

function normalizeRuns(runs) {
    const normalized = [];
    for (const run of runs) {
        if (!run || typeof run !== 'object') continue;
        if (MARKER_TYPES.has(run.type)) {
            const marker = { type: run.type };
            if (run.id !== undefined && run.id !== null) marker.id = String(run.id);
            if (Number.isInteger(Number(run.index)) && Number(run.index) >= 1) marker.index = Number(run.index);
            normalized.push(marker);
            continue;
        }
        if (TRACKED_RUN_TYPES.has(run.type)) {
            const tracked = { type: run.type };
            if (run.author !== undefined && run.author !== null) tracked.author = String(run.author);
            if (run.date !== undefined && run.date !== null) tracked.date = String(run.date);
            for (const key of INLINE_KEYS) {
                if (run[key] !== undefined && run[key] !== null) tracked[key] = run[key];
            }
            if (run.text !== undefined) tracked.text = String(run.text);
            if (tracked.text === undefined) continue;
            normalized.push(tracked);
            continue;
        }
        const clean = {};
        for (const key of INLINE_KEYS) {
            if (run[key] !== undefined && run[key] !== null) clean[key] = run[key];
        }
        if (run.text !== undefined) clean.text = String(run.text);
        if (run.formatChange && typeof run.formatChange === 'object') {
            clean.formatChange = {};
            if (typeof run.formatChange.author === 'string') clean.formatChange.author = run.formatChange.author;
            if (typeof run.formatChange.date === 'string') clean.formatChange.date = run.formatChange.date;
        }
        if (clean.image === undefined && clean.text === undefined) continue;
        normalized.push(clean);
    }
    return mergeRuns(normalized);
}

function normalizeTableCell(cell) {
    if (typeof cell === 'string') return cell;
    if (cell && typeof cell === 'object') {
        const out = {};
        if (typeof cell.text === 'string') out.text = cell.text;
        if (typeof cell.shading === 'string' && cell.shading) out.shading = cell.shading;
        if (typeof cell.width === 'string' && cell.width) out.width = cell.width;
        if (Number.isInteger(Number(cell.gridSpan)) && Number(cell.gridSpan) >= 1) out.gridSpan = Number(cell.gridSpan);
        if (cell.vMerge === 'restart' || cell.vMerge === 'continue') out.vMerge = cell.vMerge;
        if (out.text === undefined && out.shading === undefined && out.width === undefined &&
            out.gridSpan === undefined && out.vMerge === undefined) return '';
        return out;
    }
    return '';
}

function tableLogicalCols(row) {
    let cols = 0;
    for (const cell of row) {
        cols += (cell && typeof cell === 'object' && Number.isInteger(cell.gridSpan)) ? cell.gridSpan : 1;
    }
    return cols;
}

function normalizeTableBlock(block) {
    const out = {};
    if (!Array.isArray(block.rows)) {
        out.cols = 0;
        out.rows = [];
        return out;
    }
    const rows = block.rows.map(row =>
        Array.isArray(row) ? row.map(normalizeTableCell) : []
    );
    let cols = 0;
    for (const row of rows) cols = Math.max(cols, tableLogicalCols(row));
    const declared = Number.isInteger(Number(block.cols)) && Number(block.cols) >= 0 ? Number(block.cols) : 0;
    if (declared > cols) cols = declared;

    // Rows that carry spans are kept as-authored (the spans occupy the grid);
    // plain rows are padded to `cols` for a stable HTML round-trip.
    out.cols = cols;
    out.rows = rows.map(row => {
        const hasSpan = row.some(c => typeof c === 'object' && (c.gridSpan || c.vMerge));
        if (hasSpan) return row;
        while (row.length < cols) row.push('');
        return row;
    });
    if (block.width !== undefined && block.width !== null) out.width = String(block.width);
    if (block.alignment) out.alignment = String(block.alignment);
    if (block.borders && typeof block.borders === 'object' && Object.keys(block.borders).length) {
        const borders = {};
        for (const key of Object.keys(block.borders)) {
            const b = block.borders[key];
            if (b && typeof b === 'object' && b.style) {
                borders[key] = {
                    style: String(b.style),
                    ...(b.size !== undefined && b.size !== null ? { size: Number(b.size) } : {}),
                    ...(b.color !== undefined && b.color !== null ? { color: String(b.color) } : {})
                };
            }
        }
        if (Object.keys(borders).length) out.borders = borders;
    }
    return out;
}

function normalizeBlock(block) {
    if (!block || typeof block !== 'object') return null;
    if (!BLOCK_TYPES.has(block.type)) return null;

    const out = { type: block.type };
    if (block.align) out.align = String(block.align);
    switch (block.type) {
        case 'paragraph':
            copyIfPresent(out, block, ['indentLeft', 'indentRight', 'firstLine', 'spaceBefore', 'spaceAfter', 'lineSpacing', 'lineRule', 'keepNext', 'keepLines']);
            break;
        case 'heading':
            out.level = Math.round(clamp(block.level, 1, 6, 1));
            copyIfPresent(out, block, ['indentLeft', 'indentRight', 'firstLine', 'spaceBefore', 'spaceAfter', 'lineSpacing', 'lineRule', 'keepNext', 'keepLines']);
            break;
        case 'listItem':
            out.listType = block.listType === 'ordered' ? 'ordered' : 'unordered';
            out.level = Math.round(clamp(block.level, 0, 20, 0));
            if (Number.isInteger(Number(block.start)) && Number(block.start) >= 1) out.start = Number(block.start);
            if (block.indentLeft !== undefined && block.indentLeft !== null) out.indentLeft = Number(block.indentLeft);
            if (block.hanging !== undefined && block.hanging !== null) out.hanging = Number(block.hanging);
            break;
        case 'link':
            out.href = typeof block.href === 'string' ? block.href : '';
            if (block.target) out.target = String(block.target);
            break;
        case 'image':
            out.src = typeof block.src === 'string' ? block.src : '';
            if (block.alt !== undefined && block.alt !== null) out.alt = String(block.alt);
            if (block.width !== undefined && block.width !== null) out.width = String(block.width);
            if (block.height !== undefined && block.height !== null) out.height = String(block.height);
            break;
        case 'table':
            Object.assign(out, normalizeTableBlock(block));
            break;
        case 'section':
            if (block.pageFormat) out.pageFormat = String(block.pageFormat);
            if (block.orientation) out.orientation = String(block.orientation);
            if (block.widthMM !== undefined && block.widthMM !== null) out.widthMM = Number(block.widthMM);
            if (block.heightMM !== undefined && block.heightMM !== null) out.heightMM = Number(block.heightMM);
            if (block.margins && typeof block.margins === 'object') {
                const margins = {};
                for (const key of ['top', 'bottom', 'left', 'right']) {
                    if (block.margins[key] !== undefined && block.margins[key] !== null) {
                        margins[key] = Number(block.margins[key]);
                    }
                }
                if (Object.keys(margins).length) out.margins = margins;
            }
            if (block.pageNumbering) out.pageNumbering = true;
            if (block.headerDistance !== undefined && block.headerDistance !== null) out.headerDistance = Number(block.headerDistance);
            if (block.footerDistance !== undefined && block.footerDistance !== null) out.footerDistance = Number(block.footerDistance);
            if (Array.isArray(block.header)) out.header = block.header.map(normalizeBlock).filter(Boolean);
            if (Array.isArray(block.footer)) out.footer = block.footer.map(normalizeBlock).filter(Boolean);
            break;
    }

    if (Array.isArray(block.runs)) out.runs = normalizeRuns(block.runs);
    return out;
}

/**
 * Finds embedded images whose Base64 payload exceeds `maxBytes`. Used to warn
 * on document bloat without re-encoding: images are never rasterized or
 * re-compressed anywhere in the pipeline (M4 guarantees byte fidelity).
 * @param {object} model
 * @param {number} [maxBytes]
 * @returns {Array<{blockIndex:number, kind:string, size:number}>}
 */
export function findOversizedImages(model, maxBytes = MAX_IMAGE_BASE64) {
    const out = [];
    (model.blocks || []).forEach((block, blockIndex) => {
        if (block && block.type === 'image' && typeof block.src === 'string' && block.src.length > maxBytes) {
            out.push({ blockIndex, kind: 'image', size: block.src.length });
        }
        for (const run of (block && block.runs) || []) {
            if (run && typeof run.image === 'string' && run.image.length > maxBytes) {
                out.push({ blockIndex, kind: 'inlineImage', size: run.image.length });
            }
        }
    });
    return out;
}

function normalizeFootnote(f) {
    if (!f || typeof f !== 'object') return null;
    const id = f.id !== undefined && f.id !== null ? String(f.id) : null;
    if (id === null) return null;
    const out = { id };
    if (Number.isInteger(Number(f.index)) && Number(f.index) >= 1) out.index = Number(f.index);
    if (Array.isArray(f.blocks)) out.blocks = f.blocks.map(normalizeBlock).filter(Boolean);
    return out;
}

function normalizeComment(c) {
    if (!c || typeof c !== 'object') return null;
    const id = c.id !== undefined && c.id !== null ? String(c.id) : null;
    if (id === null) return null;
    const out = { id };
    if (typeof c.author === 'string' && c.author) out.author = c.author;
    if (typeof c.date === 'string' && c.date) out.date = c.date;
    if (typeof c.text === 'string') out.text = c.text;
    return out;
}

function normalizeRevision(r) {
    if (!r || typeof r !== 'object') return null;
    const kind = REVISION_KINDS.includes(r.kind) ? r.kind : null;
    if (!kind) return null;
    const out = { kind };
    if (r.id !== undefined && r.id !== null) out.id = String(r.id);
    if (typeof r.author === 'string' && r.author) out.author = r.author;
    if (typeof r.date === 'string' && r.date) out.date = r.date;
    return out;
}

/**
 * Coerces a raw/legacy model object into the canonical shape, filling
 * defaults and dropping invalid blocks. Tolerant: never throws.
 * @param {object} model
 * @returns {object}
 */
export function normalizeModel(model) {
    const raw = model && typeof model === 'object' ? model : {};
    const pageFormat = VALID_PAGE_FORMATS.includes(raw.pageFormat) ? raw.pageFormat : 'a4';
    const fontFamily = typeof raw.fontFamily === 'string' && raw.fontFamily ? raw.fontFamily : DEFAULT_FONT_FAMILY;

    return {
        title: typeof raw.title === 'string' ? raw.title : DEFAULT_TITLE,
        blocks: Array.isArray(raw.blocks) ? raw.blocks.map(normalizeBlock).filter(Boolean) : [],
        pageFormat,
        fontFamily,
        footnotes: Array.isArray(raw.footnotes) ? raw.footnotes.map(normalizeFootnote).filter(Boolean) : [],
        comments: Array.isArray(raw.comments) ? raw.comments.map(normalizeComment).filter(Boolean) : [],
        revisions: Array.isArray(raw.revisions) ? raw.revisions.map(normalizeRevision).filter(Boolean) : [],
        updatedAt: typeof raw.updatedAt === 'number' && raw.updatedAt > 0 ? raw.updatedAt : Date.now()
    };
}

/**
 * Stable, order-independent canonical serialization of a model. Object key
 * order is normalized away by recursively sorting keys, and runs that merely
 * inherit the .docx document's default font are folded to "no explicit font"
 * so documents re-exported through Word's default styling compare cleanly.
 * Intended for round-trip fidelity assertions, not persisted anywhere.
 * @param {object} model
 * @param {string} [docDefaultFont] the .docx document's default run font
 * @returns {string}
 */
export function canonicalModel(model, docDefaultFont) {
    const copy = structuredClone(normalizeModel(model));
    if (docDefaultFont) {
        const strip = runs => (runs || []).forEach(r => {
            if (r && typeof r === 'object' && r.fontFamily === docDefaultFont) delete r.fontFamily;
        });
        for (const block of copy.blocks) {
            if (!block || typeof block !== 'object') continue;
            strip(block.runs);
            if (block.type === 'table') {
                (block.rows || []).forEach(row => (row || []).forEach(cell => {
                    if (cell && typeof cell === 'object') strip(cell.runs);
                }));
            }
            if (block.type === 'section') {
                for (const key of ['header', 'footer']) {
                    (block[key] || []).forEach(b => strip(b && b.runs));
                }
            }
        }
        (copy.footnotes || []).forEach(fn => (fn.blocks || []).forEach(b => strip(b && b.runs)));
    }
    return stableStringify(copy);
}

function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    let out = '{';
    for (let i = 0; i < keys.length; i++) {
        if (i) out += ',';
        out += JSON.stringify(keys[i]) + ':' + stableStringify(value[keys[i]]);
    }
    return out + '}';
}

function validateRun(run) {
    if (!run || typeof run !== 'object') throw new Error('Run must be an object');
    if (run.text !== undefined && typeof run.text !== 'string') throw new Error('Run text must be a string');
    if (run.image !== undefined && typeof run.image !== 'string') throw new Error('Run image src must be a string');
    if (MARKER_TYPES.has(run.type) && run.text !== undefined) {
        throw new Error(`Marker run ${run.type} must not carry text`);
    }
    if (run.type === 'footnoteRef' || run.type === 'commentRangeStart' || run.type === 'commentRangeEnd') {
        if (run.id === undefined || run.id === null) throw new Error(`Marker run ${run.type} requires an id`);
    }
    if (TRACKED_RUN_TYPES.has(run.type) && run.text === undefined) {
        throw new Error(`Tracked run ${run.type} requires text`);
    }
    if (run.formatChange !== undefined) {
        if (!run.formatChange || typeof run.formatChange !== 'object') {
            throw new Error('formatChange must be an object');
        }
        if (typeof run.formatChange.author !== 'string') throw new Error('formatChange.author must be a string');
        if (typeof run.formatChange.date !== 'string') throw new Error('formatChange.date must be a string');
    }
}

function validateAnnotations(model) {
    if (model.footnotes !== undefined && !Array.isArray(model.footnotes)) {
        throw new Error('Model.footnotes must be an array');
    }
    if (model.comments !== undefined && !Array.isArray(model.comments)) {
        throw new Error('Model.comments must be an array');
    }
    if (model.revisions !== undefined && !Array.isArray(model.revisions)) {
        throw new Error('Model.revisions must be an array');
    }
    (model.footnotes || []).forEach((f, i) => {
        if (!f || typeof f !== 'object' || typeof f.id !== 'string') {
            throw new Error(`Footnote ${i} requires a string id`);
        }
        if (f.blocks !== undefined && !Array.isArray(f.blocks)) throw new Error(`Footnote ${i} blocks must be an array`);
        (f.blocks || []).forEach(validateBlock);
    });
    (model.comments || []).forEach((c, i) => {
        if (!c || typeof c !== 'object' || typeof c.id !== 'string') {
            throw new Error(`Comment ${i} requires a string id`);
        }
        if (typeof c.text !== 'string') throw new Error(`Comment ${i} text must be a string`);
    });
    (model.revisions || []).forEach((r, i) => {
        if (!r || typeof r !== 'object' || !REVISION_KINDS.includes(r.kind)) {
            throw new Error(`Revision ${i} has an invalid kind`);
        }
    });
}

function validateBlock(block) {
    if (!block || typeof block !== 'object') throw new Error('Block must be an object');
    if (!BLOCK_TYPES.has(block.type)) {
        throw new Error(`Unknown block type: ${String(block.type)}`);
    }
    if (block.type === 'heading') {
        const level = Number(block.level);
        if (!Number.isInteger(level) || level < 1 || level > 6) {
            throw new Error(`Invalid heading level: ${String(block.level)}`);
        }
    }
    if (block.type === 'listItem') {
        if (!['ordered', 'unordered'].includes(block.listType)) {
            throw new Error(`Invalid listItem type: ${String(block.listType)}`);
        }
    }
    if (block.type === 'link' && typeof block.href !== 'string') {
        throw new Error('link block requires a string href');
    }
    if (block.type === 'image' && typeof block.src !== 'string') {
        throw new Error('image block requires a string src');
    }
    if (block.type === 'table') {
        if (!Array.isArray(block.rows)) throw new Error('table block requires rows array');
        block.rows.forEach((row, i) => {
            if (!Array.isArray(row)) throw new Error(`table row ${i} must be an array`);
            row.forEach(cell => {
                if (typeof cell === 'string') return;
                if (cell && typeof cell === 'object' && (cell.text === undefined || typeof cell.text === 'string')) return;
                throw new Error(`table cell ${i} must be a string or { text }`);
            });
        });
    }
    if (block.type === 'section') {
        if (block.header !== undefined && !Array.isArray(block.header)) {
            throw new Error('section header must be an array');
        }
        if (block.footer !== undefined && !Array.isArray(block.footer)) {
            throw new Error('section footer must be an array');
        }
        (block.header || []).forEach(validateBlock);
        (block.footer || []).forEach(validateBlock);
    }
    if (block.runs !== undefined && !Array.isArray(block.runs)) {
        throw new Error('Block runs must be an array');
    }
    (block.runs || []).forEach(validateRun);
}

/**
 * Validates a model document. Throws on unknown node types or malformed
 * blocks. Callers that need "degrade in prod" behavior should wrap this
 * in try/catch and fall back to legacy content.
 * @param {object} model
 * @returns {boolean} true when the model is valid
 */
export function validateModel(model) {
    if (!model || typeof model !== 'object') throw new Error('Model must be an object');
    if (!Array.isArray(model.blocks)) throw new Error('Model.blocks must be an array');
    if (model.title !== undefined && typeof model.title !== 'string') throw new Error('Model.title must be a string');
    if (model.pageFormat !== undefined && !VALID_PAGE_FORMATS.includes(model.pageFormat)) {
        throw new Error(`Unknown page format: ${String(model.pageFormat)}`);
    }
    validateAnnotations(model);
    model.blocks.forEach(validateBlock);
    return true;
}