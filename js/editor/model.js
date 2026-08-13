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
 * Drops empty text runs. Returns a new array (does not mutate input).
 * @param {object[]} runs
 * @returns {object[]}
 */
export function mergeRuns(runs) {
    const out = [];
    for (const run of runs) {
        if (!run || typeof run !== 'object') continue;
        if (run.image === undefined && run.text === undefined) continue;
        if (run.image === undefined && run.text === '') continue;

        const prev = out[out.length - 1];
        if (prev && !prev.image && !run.image && runsEqual(prev, run)) {
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
        const clean = {};
        for (const key of INLINE_KEYS) {
            if (run[key] !== undefined && run[key] !== null) clean[key] = run[key];
        }
        if (run.text !== undefined) clean.text = String(run.text);
        if (clean.image === undefined && clean.text === undefined) continue;
        normalized.push(clean);
    }
    return mergeRuns(normalized);
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
            out.cols = Number.isInteger(Number(block.cols)) && Number(block.cols) >= 0 ? Number(block.cols) : 0;
            out.rows = Array.isArray(block.rows)
                ? block.rows.map(row => (Array.isArray(row) ? row.map(cell => String(cell)) : []))
                : [];
            break;
        case 'section':
            if (block.orientation) out.orientation = String(block.orientation);
            if (block.pageFormat) out.pageFormat = String(block.pageFormat);
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
        updatedAt: typeof raw.updatedAt === 'number' && raw.updatedAt > 0 ? raw.updatedAt : Date.now()
    };
}

function validateRun(run) {
    if (!run || typeof run !== 'object') throw new Error('Run must be an object');
    if (run.text !== undefined && typeof run.text !== 'string') throw new Error('Run text must be a string');
    if (run.image !== undefined && typeof run.image !== 'string') throw new Error('Run image src must be a string');
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
        });
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
    model.blocks.forEach(validateBlock);
    return true;
}