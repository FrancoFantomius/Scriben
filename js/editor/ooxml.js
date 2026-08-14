/**
 * ooxml.js — Hand-rolled OOXML (.docx) reader.
 *
 * Pure parsing only: no DOM, no `state` imports, no side effects. Reads the
 * DOCX zip directly (fflate) and walks `word/document.xml` into canonical
 * model blocks plus a structured warning list. Unit-testable in isolation.
 *
 * Invariants:
 *  - Lengths are converted once, early (twips → pt/mm, half-points → pt,
 *    EMUs → px). Raw values never leave the parsing layer.
 *  - The walker never throws for unexpected XML; unknown nodes are skipped
 *    with a structured warning. Only a structurally unreadable package
 *    (bad zip / missing word/document.xml) raises a user-facing error.
 *  - Output is deterministic and in document order.
 */

import { runsEqual } from './model.js';

// ─── Namespaces (single source) ───────────────────────────────────────────────

export const NS = {
    w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    pkgrel: 'http://schemas.openxmlformats.org/package/2006/relationships',
    a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
    wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
    mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
    cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
    dc: 'http://purl.org/dc/elements/1.1/',
    v: 'urn:schemas-microsoft-com:vml'
};

const PREFIX_NS = {
    w: NS.w,
    r: NS.r,
    a: NS.a,
    wp: NS.wp,
    pic: NS.pic,
    mc: NS.mc,
    w14: NS.w14,
    v: NS.v,
    xml: 'http://www.w3.org/XML/1998/namespace'
};

// ─── Warning taxonomy (T9) ────────────────────────────────────────────────────

export const WARNINGS = {
    INVALID_ZIP: { code: 'INVALID_ZIP', message: 'This file is not a valid .docx archive.' },
    MISSING_DOCUMENT: { code: 'MISSING_DOCUMENT', message: 'The .docx file is missing its document body.' },
    XML_PARSE_ERROR: { code: 'XML_PARSE_ERROR', message: 'A part of the document could not be read.' },
    MISSING_RELS: { code: 'MISSING_RELS', message: 'The document has no relationship map.' },
    TABLE_DEFERRED: { code: 'TABLE_DEFERRED', message: 'A table could not be fully parsed.' },
    NESTED_TABLE_SKIPPED: { code: 'NESTED_TABLE_SKIPPED', message: 'Nested tables were skipped.' },
    TRACKED_CHANGE_DEFERRED: { code: 'TRACKED_CHANGE_DEFERRED', message: 'Tracked changes were flattened to plain text.' },
    FOOTNOTE_DEFERRED: { code: 'FOOTNOTE_DEFERRED', message: 'Footnotes and endnotes were skipped.' },
    CUSTOM_XML_SKIPPED: { code: 'CUSTOM_XML_SKIPPED', message: 'Custom XML content was skipped.' },
    NUMBERING_DEFERRED: { code: 'NUMBERING_DEFERRED', message: 'List numbering could not be fully resolved.' },
    UNPAIRED_BOOKMARK: { code: 'UNPAIRED_BOOKMARK', message: 'A bookmark was missing its start marker.' },
    LINK_TARGET_MISSING: { code: 'LINK_TARGET_MISSING', message: 'A link target could not be resolved.' },
    LINK_ANCHOR_MISSING: { code: 'LINK_ANCHOR_MISSING', message: 'An internal link points to a missing anchor.' },
    EXTERNAL_IMAGE: { code: 'EXTERNAL_IMAGE', message: 'An image was linked externally and skipped.' },
    LEGACY_IMAGE: { code: 'LEGACY_IMAGE', message: 'A legacy image was imported.' },
    IMAGE_SIZE_UNUSUAL: { code: 'IMAGE_SIZE_UNUSUAL', message: 'An image has an unusual size.' },
    UNKNOWN_ALIGNMENT: { code: 'UNKNOWN_ALIGNMENT', message: 'An unsupported alignment was used.' },
    UNKNOWN_STYLE: { code: 'UNKNOWN_STYLE', message: 'A paragraph style was not recognized.' }
};

export function warn(ctx, code) {
    const def = WARNINGS[code];
    if (!def) return;
    ctx.warnings.push({ code: def.code, message: def.message });
}

/**
 * Normalizes import warnings into the public `{ code, message, at? }` shape.
 * @param {Array<{code:string,message:string,at?:object}>} list
 * @returns {Array<{code:string,message:string,at?:object}>}
 */
export function buildWarnings(list) {
    return (list || []).map(w => {
        const out = { code: w.code, message: w.message };
        if (w.at) out.at = w.at;
        return out;
    });
}

// ─── T1.1 ZIP + part plumbing ─────────────────────────────────────────────────

let fflatePromise = null;

/**
 * Lazily loads `fflate` on first use and caches the module promise so the
 * app start bundle never pulls it in.
 * @returns {Promise<object>}
 */
export function loadFflate() {
    if (!fflatePromise) {
        fflatePromise = import('fflate').catch(err => {
            fflatePromise = null;
            throw { code: 'INVALID_ZIP', message: WARNINGS.INVALID_ZIP.message };
        });
    }
    return fflatePromise;
}

/**
 * Strips leading slashes, resolves `.` segments and rejects `..` traversal so
 * a hostile zip cannot escape the parts map. Returns null for unsafe names.
 * @param {string} name
 * @returns {string|null}
 */
export function normalizePartName(name) {
    let n = String(name).replace(/\\/g, '/');
    while (n.startsWith('/')) n = n.slice(1);
    const clean = [];
    for (const seg of n.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') return null;
        clean.push(seg);
    }
    return clean.join('/');
}

/**
 * Decodes all entries of a DOCX zip into a parts map keyed by normalized
 * part names (e.g. `word/document.xml`). Rejects with `{ code }` on a bad
 * zip or when `word/document.xml` is absent.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function unzipParts(buffer) {
    const fflate = await loadFflate();
    let files;
    try {
        files = fflate.unzipSync(new Uint8Array(buffer), {
            filter: f => !f.name.endsWith('/')
        });
    } catch (err) {
        throw { code: 'INVALID_ZIP', message: WARNINGS.INVALID_ZIP.message };
    }
    const parts = new Map();
    for (const key of Object.keys(files)) {
        const norm = normalizePartName(key);
        if (norm) parts.set(norm, files[key]);
    }
    let hasDoc = false;
    for (const key of parts.keys()) {
        if (key.toLowerCase() === 'word/document.xml') {
            hasDoc = true;
            break;
        }
    }
    if (!hasDoc) {
        throw { code: 'MISSING_DOCUMENT', message: WARNINGS.MISSING_DOCUMENT.message };
    }
    return parts;
}

/**
 * Wraps the parts map with read helpers. Warnings from part parsing (e.g.
 * XML_PARSE_ERROR) are pushed into the shared `warnings` array.
 * @param {Map<string, Uint8Array>} parts
 * @param {Array} [warnings]
 * @returns {object} reader
 */
export function createReader(parts, warnings = []) {
    return {
        parts,
        warnings,
        /**
         * Decodes a part as XML. Returns null on parse error or missing part.
         * @param {string} path
         * @returns {Document|null}
         */
        getPart(path) {
            const bytes = this.getBytes(path);
            if (!bytes) return null;
            let xml;
            try {
                xml = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
            } catch (err) {
                warn({ warnings }, 'XML_PARSE_ERROR');
                return null;
            }
            try {
                const doc = new DOMParser().parseFromString(xml, 'application/xml');
                if (doc.getElementsByTagName('parsererror').length > 0) {
                    warn({ warnings }, 'XML_PARSE_ERROR');
                    return null;
                }
                return doc;
            } catch (err) {
                warn({ warnings }, 'XML_PARSE_ERROR');
                return null;
            }
        },
        /**
         * Returns raw part bytes or null.
         * @param {string} path
         * @returns {Uint8Array|null}
         */
        getBytes(path) {
            const norm = normalizePartName(path);
            if (!norm) return null;
            if (this.parts.has(norm)) return this.parts.get(norm);
            const lower = norm.toLowerCase();
            for (const [k, v] of this.parts.entries()) {
                if (k.toLowerCase() === lower) return v;
            }
            return null;
        },
        /**
         * Lists part names matching a regex.
         * @param {RegExp} regex
         * @returns {string[]}
         */
        listParts(regex) {
            return Array.from(this.parts.keys()).filter(p => regex.test(p));
        }
    };
}

// ─── T1.2 Namespace-aware XML helpers ─────────────────────────────────────────

function localNameOf(el) {
    return el.localName || '';
}

/**
 * First descendant element in the `w` namespace with the given local name.
 * @param {Element|null} el
 * @param {string} localName
 * @returns {Element|null}
 */
export function child(el, localName) {
    if (!el || typeof el.getElementsByTagNameNS !== 'function') return null;
    return el.getElementsByTagNameNS(NS.w, localName)[0] || null;
}

/**
 * All descendant elements in the `w` namespace with the given local name.
 * @param {Element|null} el
 * @param {string} localName
 * @returns {Element[]}
 */
export function children(el, localName) {
    if (!el || typeof el.getElementsByTagNameNS !== 'function') return [];
    return Array.from(el.getElementsByTagNameNS(NS.w, localName));
}

/**
 * First descendant element in a specific namespace.
 * @param {Element|null} el
 * @param {string} ns
 * @param {string} localName
 * @returns {Element|null}
 */
export function childNS(el, ns, localName) {
    if (!el || typeof el.getElementsByTagNameNS !== 'function') return null;
    return el.getElementsByTagNameNS(ns, localName)[0] || null;
}

/**
 * Reads an attribute by its qualified name exactly as stored (e.g. `w:val`),
 * falling back to namespace-based lookup for writers that use odd prefixes.
 * @param {Element|null} el
 * @param {string} qName
 * @returns {string|null}
 */
export function attr(el, qName) {
    if (!el || typeof el.getAttribute !== 'function') return null;
    const direct = el.getAttribute(qName);
    if (direct !== null && direct !== undefined) return direct;
    const idx = qName.indexOf(':');
    if (idx > 0) {
        const ns = PREFIX_NS[qName.slice(0, idx)];
        if (ns) {
            const viaNS = el.getAttributeNS(ns, qName.slice(idx + 1));
            if (viaNS !== null && viaNS !== undefined) return viaNS;
        }
    }
    return null;
}

/**
 * Reads an attribute in a specific namespace.
 * @param {Element|null} el
 * @param {string} ns
 * @param {string} localName
 * @returns {string|null}
 */
export function attrNS(el, ns, localName) {
    if (!el || typeof el.getAttributeNS !== 'function') return null;
    const v = el.getAttributeNS(ns, localName);
    return v === null || v === undefined ? null : v;
}

/**
 * Returns element text; whitespace-only content is treated as empty.
 * @param {Element|null} el
 * @returns {string}
 */
export function text(el) {
    if (!el || !el.textContent) return '';
    const t = el.textContent;
    return t.trim() === '' ? '' : t;
}

// ─── T1.3 Relationship map ────────────────────────────────────────────────────

/**
 * Parses a `word/_rels/document.xml.rels` document into a Map keyed by
 * relationship Id: `{ target, mode? }`.
 * @param {Document} relsDoc
 * @returns {Map<string, {target:string, mode?:string}>}
 */
export function parseRels(relsDoc) {
    const map = new Map();
    if (!relsDoc) return map;
    for (const rel of relsDoc.getElementsByTagNameNS(NS.pkgrel, 'Relationship')) {
        const id = rel.getAttribute('Id');
        const target = rel.getAttribute('Target');
        if (!id || !target) continue;
        const mode = rel.getAttribute('TargetMode');
        map.set(id, { target, ...(mode ? { mode } : {}) });
    }
    return map;
}

// ─── T1.4 Title metadata ──────────────────────────────────────────────────────

/**
 * Reads the document title from `docProps/core.xml` (dc:title) falling back
 * to `docProps/app.xml` (w:title). Returns null when absent.
 * @param {object} reader
 * @returns {string|null}
 */
export function getCoreTitle(reader) {
    const core = reader.getPart('docProps/core.xml');
    if (core) {
        const titleEl = core.getElementsByTagNameNS(NS.dc, 'title')[0];
        const val = titleEl ? text(titleEl) : '';
        if (val) return val;
    }
    const app = reader.getPart('docProps/app.xml');
    if (app) {
        const titleEl = app.getElementsByTagNameNS(NS.w, 'title')[0];
        const val = titleEl ? text(titleEl) : '';
        if (val) return val;
    }
    return null;
}

// ─── Unit conversions ─────────────────────────────────────────────────────────

/**
 * Converts a universal measure (plain twips number, or a number with a
 * mm/cm/pt/in suffix — docx writes the latter verbatim for page geometry)
 * into twips.
 * @param {string|number} v
 * @returns {number|null}
 */
function measureToTwips(v) {
    if (v == null) return null;
    const m = String(v).match(/^([\d.]+)\s*(mm|cm|pt|in)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    const unit = (m[2] || '').toLowerCase();
    switch (unit) {
        case 'mm': return Math.round(n * 72 * 20 / 25.4);
        case 'cm': return Math.round(n * 72 * 20 / 2.54);
        case 'in': return Math.round(n * 1440);
        case 'pt': return Math.round(n * 20);
        default: return n; // already twips
    }
}

function twipsToPt(v) {
    const tw = measureToTwips(v);
    return tw == null ? null : Math.round((tw / 20) * 100) / 100;
}

function twipsToMm(v) {
    const tw = measureToTwips(v);
    return tw == null ? null : Math.round((tw * 25.4 / 1440) * 10) / 10;
}

function emuToPx(emu) {
    return Math.round((emu / 914400 * 96) * 10) / 10;
}

function lengthToPx(value, unit) {
    switch (unit) {
        case 'pt': return Math.round((value * 96 / 72) * 10) / 10;
        case 'em': return Math.round((value * 16) * 10) / 10;
        case 'mm': return Math.round((value * 96 / 25.4) * 10) / 10;
        case 'cm': return Math.round((value * 96 / 2.54) * 10) / 10;
        case 'in': return Math.round((value * 96) * 10) / 10;
        default: return Math.round(value * 10) / 10;
    }
}

// ─── T2. Core body walker ─────────────────────────────────────────────────────

/**
 * Walks `w:body` children in document order producing model blocks.
 * @param {Element} bodyEl
 * @param {object} ctx
 * @returns {object[]}
 */
export function walkBody(bodyEl, ctx) {
    const blocks = [];
    for (const node of Array.from(bodyEl.childNodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const name = localNameOf(node);
        switch (name) {
            case 'p':
                blocks.push(...parseParagraph(node, ctx));
                break;
            case 'tbl':
                blocks.push(parseTable(node, ctx));
                break;
            case 'sectPr':
                blocks.push(parseSectPr(node, ctx));
                break;
            case 'bookmarkStart': {
                const id = attr(node, 'w:id');
                const bmName = attr(node, 'w:name');
                if (id) ctx.bookmarkIds.add(id);
                if (bmName && id) ctx.bookmarks.set(bmName, id);
                break;
            }
            case 'bookmarkEnd': {
                const id = attr(node, 'w:id');
                if (id && !ctx.bookmarkIds.has(id)) warn(ctx, 'UNPAIRED_BOOKMARK');
                break;
            }
            case 'ins':
            case 'del': {
                // Body-level tracked change: thread the change into ctx so
                // paragraphs rendered beneath it wrap their text runs as
                // insRun/delRun. Restored afterwards for sibling content.
                const prevChange = ctx.change;
                ctx.change = {
                    kind: name === 'del' ? 'delete' : 'insert',
                    author: attr(node, 'w:author') || '',
                    date: attr(node, 'w:date') || ''
                };
                blocks.push(...walkBody(node, ctx));
                ctx.change = prevChange;
                break;
            }
            case 'sdt': {
                const content = child(node, 'sdtContent');
                if (content) blocks.push(...walkBody(content, ctx));
                break;
            }
            case 'customXml':
                warn(ctx, 'CUSTOM_XML_SKIPPED');
                break;
            case 'AlternateContent':
            case 'alternateContent': {
                const choice = childNS(node, NS.mc, 'Choice') || child(node, 'Choice');
                const fallback = childNS(node, NS.mc, 'Fallback') || child(node, 'Fallback');
                const target = choice || fallback;
                if (target) blocks.push(...walkBody(target, ctx));
                break;
            }
            default:
                break;
        }
    }
    return blocks;
}

// ─── T2.2 Run containers ──────────────────────────────────────────────────────

/**
 * Collects run containers (w:r / w:hyperlink / w:ins / w:del) from a
 * paragraph in document order, descending through w:sdt/w:sdtContent.
 * Paragraph-level bookmarks are registered here (Word writes them inside
 * w:p, outside the body walker's reach).
 * @param {Element} paragraphEl
 * @param {object} ctx
 * @returns {Array<{el:Element, type:string}>}
 */
function collectRuns(paragraphEl, ctx) {
    const out = [];
    const walk = container => {
        for (const node of Array.from(container.childNodes)) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const name = localNameOf(node);
            if (name === 'r') out.push({ el: node, type: 'run' });
            else if (name === 'hyperlink') out.push({ el: node, type: 'hyperlink' });
            else if (name === 'ins' || name === 'del') out.push({ el: node, type: name });
            else if (name === 'commentRangeStart') out.push({ el: node, type: 'commentRangeStart' });
            else if (name === 'commentRangeEnd') out.push({ el: node, type: 'commentRangeEnd' });
            else if (name === 'sdt') {
                const content = child(node, 'sdtContent');
                if (content) walk(content);
            } else if (name === 'AlternateContent' || name === 'alternateContent') {
                const choice = childNS(node, NS.mc, 'Choice') || child(node, 'Choice');
                const fallback = childNS(node, NS.mc, 'Fallback') || child(node, 'Fallback');
                const target = choice || fallback;
                if (target) walk(target);
            } else if (name === 'bookmarkStart') {
                const id = attr(node, 'w:id');
                const bmName = attr(node, 'w:name');
                if (id) ctx.bookmarkIds.add(id);
                if (bmName && id) ctx.bookmarks.set(bmName, id);
            } else if (name === 'bookmarkEnd') {
                const id = attr(node, 'w:id');
                if (id && !ctx.bookmarkIds.has(id)) warn(ctx, 'UNPAIRED_BOOKMARK');
            }
            // proofErr, commentRangeStart, etc. are not runs.
        }
    };
    walk(paragraphEl);
    return out;
}

// ─── T3. Paragraphs, runs, text, formatting ───────────────────────────────────

const PAGE_PRESETS = [
    { format: 'a4', w: 210, h: 297 },
    { format: 'a5', w: 148, h: 210 },
    { format: 'letter', w: 215.9, h: 279.4 },
    { format: 'legal', w: 215.9, h: 355.6 }
];

const HIGHLIGHT_COLORS = {
    black: '#000000',
    blue: '#0070C0',
    cyan: '#00FFFF',
    green: '#00B050',
    magenta: '#FF00FF',
    red: '#FF0000',
    yellow: '#FFFF00',
    white: '#FFFFFF',
    darkBlue: '#000080',
    darkCyan: '#008080',
    darkGreen: '#008000',
    darkMagenta: '#800080',
    darkRed: '#800000',
    darkYellow: '#808000',
    darkGray: '#808080',
    lightGray: '#C0C0C0'
};

/**
 * Merges adjacent runs with identical formatting. Preserves marker runs
 * (pageNumber, footnoteRef, commentRangeStart, commentRangeEnd) and
 * tracked-change runs (insRun, delRun) verbatim. Drops empty runs.
 * @param {object[]} runs
 * @returns {object[]}
 */
function mergeRunsLocal(runs) {
    const out = [];
    for (const run of runs) {
        if (!run || typeof run !== 'object') continue;
        if (run.type === 'pageNumber' || run.type === 'footnoteRef' ||
            run.type === 'commentRangeStart' || run.type === 'commentRangeEnd' ||
            run.type === 'insRun' || run.type === 'delRun' || run.formatChange) {
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

function valOn(el, qName) {
    const v = attr(el, qName);
    return !(v === 'false' || v === '0' || v === 'off');
}

function mapAlignment(val) {
    switch (String(val).toLowerCase()) {
        case 'left': return 'left';
        case 'center': return 'center';
        case 'right': return 'right';
        case 'both':
        case 'distribute':
        case 'justify':
        case 'mediumkashida':
        case 'highkashida':
        case 'lowkashida':
        case 'thaidistribute':
            return 'justify';
        default:
            return null;
    }
}

/**
 * Parses `w:pPr` into a plain paragraph-props object.
 * @param {Element|null} pPr
 * @param {object} ctx
 * @returns {object}
 */
function parsePPr(pPr, ctx) {
    const out = {};
    if (!pPr) return out;

    const jc = child(pPr, 'jc');
    if (jc) {
        const val = attr(jc, 'w:val');
        const align = mapAlignment(val);
        if (align) out.align = align;
        else warn(ctx, 'UNKNOWN_ALIGNMENT');
    }

    const ind = child(pPr, 'ind');
    if (ind) {
        const left = twipsToPt(attr(ind, 'w:left'));
        const right = twipsToPt(attr(ind, 'w:right'));
        const firstLine = twipsToPt(attr(ind, 'w:firstLine'));
        if (left != null) out.indentLeft = left;
        if (right != null) out.indentRight = right;
        if (firstLine != null) out.firstLine = firstLine;
    }

    const spacing = child(pPr, 'spacing');
    if (spacing) {
        const before = twipsToPt(attr(spacing, 'w:before'));
        const after = twipsToPt(attr(spacing, 'w:after'));
        const line = twipsToPt(attr(spacing, 'w:line'));
        if (before != null) out.spaceBefore = before;
        if (after != null) out.spaceAfter = after;
        if (line != null) out.lineSpacing = line;
        const lineRule = attr(spacing, 'w:lineRule');
        if (lineRule === 'exact' || lineRule === 'atLeast') out.lineRule = lineRule;
    }

    const pStyle = child(pPr, 'pStyle');
    if (pStyle) {
        const val = attr(pStyle, 'w:val');
        if (val) out.styleId = val;
    }

    const numPr = child(pPr, 'numPr');
    if (numPr) {
        const numIdEl = child(numPr, 'numId');
        const ilvlEl = child(numPr, 'ilvl');
        const numId = numIdEl ? attr(numIdEl, 'w:val') : null;
        const ilvl = ilvlEl ? parseInt(attr(ilvlEl, 'w:val'), 10) : 0;
        if (numId) out.list = { numId, level: isFinite(ilvl) ? ilvl : 0 };
    }

    if (child(pPr, 'keepNext')) out.keepNext = true;
    if (child(pPr, 'keepLines')) out.keepLines = true;
    if (child(pPr, 'pageBreakBefore')) out.pageBreakBefore = true;

    const outlineLvl = child(pPr, 'outlineLvl');
    if (outlineLvl) {
        const val = parseInt(attr(outlineLvl, 'w:val'), 10);
        if (isFinite(val) && val >= 0 && val <= 8) out.outlineLvl = val;
    }

    return out;
}

/**
 * Parses `w:rPr` into a run-props object.
 * @param {Element|null} rPr
 * @param {object} ctx
 * @returns {object}
 */
function parseRPr(rPr, ctx) {
    const out = {};
    if (!rPr) return out;

    const b = child(rPr, 'b') || child(rPr, 'bCs');
    if (b) out.bold = valOn(b, 'w:val');

    const i = child(rPr, 'i') || child(rPr, 'iCs');
    if (i) out.italic = valOn(i, 'w:val');

    const u = child(rPr, 'u');
    if (u) {
        const val = attr(u, 'w:val') || 'single';
        if (val === 'none') out.underline = false;
        else if (val === 'single' || val === 'words') out.underline = true;
        else {
            out.underline = true;
            out.underlineStyle = val;
        }
    }

    const strike = child(rPr, 'strike') || child(rPr, 'dstrike');
    if (strike) out.strikethrough = valOn(strike, 'w:val');

    const color = child(rPr, 'color');
    if (color) {
        const val = attr(color, 'w:val');
        const themeColor = attr(color, 'w:themeColor');
        if (themeColor) {
            const resolved = resolveThemeColor(themeColor, attr(color, 'w:themeShade'), attr(color, 'w:themeTint'), ctx);
            if (resolved) out.color = resolved;
        }
        if (!out.color && val && val !== 'auto') out.color = '#' + val;
    }

    const shd = child(rPr, 'shd');
    if (shd) {
        let fill = attr(shd, 'w:fill');
        if (fill && fill !== 'auto') out.backgroundColor = '#' + fill;
        else {
            const themeFill = attr(shd, 'w:themeFill');
            if (themeFill) {
                const resolved = resolveThemeColor(themeFill, attr(shd, 'w:themeShade'), attr(shd, 'w:themeTint'), ctx);
                if (resolved) out.backgroundColor = resolved;
            }
        }
    }

    const sz = child(rPr, 'sz');
    const szCs = child(rPr, 'szCs');
    if (sz) {
        const val = parseInt(attr(sz, 'w:val'), 10);
        if (isFinite(val)) {
            let size = Math.min(1638, Math.max(1, val));
            const csVal = szCs ? parseInt(attr(szCs, 'w:val'), 10) : NaN;
            if (isFinite(csVal) && csVal > val) size = Math.min(1638, Math.max(1, csVal));
            out.fontSize = `${size / 2}pt`;
        }
    }

    const rFonts = child(rPr, 'rFonts');
    if (rFonts) {
        const ascii = attr(rFonts, 'w:ascii');
        const hAnsi = attr(rFonts, 'w:hAnsi');
        const cs = attr(rFonts, 'w:cs');
        const eastAsia = attr(rFonts, 'w:eastAsia');
        const family = ascii || hAnsi || cs;
        if (family) out.fontFamily = family;
        if (eastAsia) out.eastAsiaFont = eastAsia;
    }

    const vertAlign = child(rPr, 'vertAlign');
    if (vertAlign) {
        const val = attr(vertAlign, 'w:val');
        if (val === 'superscript') out.superscript = true;
        else if (val === 'subscript') out.subscript = true;
    }

    const highlight = child(rPr, 'highlight');
    if (highlight) {
        const val = attr(highlight, 'w:val');
        const mapped = HIGHLIGHT_COLORS[String(val).toLowerCase()];
        if (mapped) out.backgroundColor = mapped;
        else warn(ctx, 'UNKNOWN_STYLE');
    }

    const rStyle = child(rPr, 'rStyle');
    if (rStyle) {
        const val = attr(rStyle, 'w:val');
        if (val) out.styleId = val;
    }

    // w:rPrChange records the prior formatting for a tracked format change.
    // The revision's author/date are preserved on the run so the exporter can
    // re-emit a w:rPrChange; the exact prior props are intentionally not
    // mirrored (format changes are preserved, not fully round-tripped).
    const rPrChange = child(rPr, 'rPrChange');
    if (rPrChange) {
        out.formatChange = {
            author: attr(rPrChange, 'w:author') || '',
            date: attr(rPrChange, 'w:date') || ''
        };
    }

    return out;
}

/**
 * Extracts verbatim text from a `w:t`, preserving whitespace when the run's
 * `w:t` or the paragraph carries `xml:space="preserve"`.
 * @param {Element} tEl
 * @param {Element} paragraphEl
 * @returns {string}
 */
function extractText(tEl, paragraphEl) {
    const raw = tEl.textContent || '';
    const preserve = tEl.getAttribute('xml:space') === 'preserve' ||
        (paragraphEl && paragraphEl.getAttribute('xml:space') === 'preserve');
    if (preserve) return raw;
    return raw.trim() === '' ? '' : raw;
}

/**
 * Parses a single `w:r` into model runs (text, breaks, images, markers).
 * @param {Element} rEl
 * @param {object} ctx
 * @param {Element} paragraphEl
 * @param {object} [inherit] paragraph-level default run props (styles)
 * @returns {object[]}
 */
function parseRun(rEl, ctx, paragraphEl, inherit) {
    const rPr = child(rEl, 'rPr');
    const props = resolveRunProps(parseRPr(rPr, ctx), inherit, ctx);
    const out = [];
    for (const node of Array.from(rEl.childNodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const name = localNameOf(node);
        switch (name) {
            case 't':
            case 'delText': {
                // `w:delText` carries deleted text inside a tracked-delete run;
                // the surrounding w:del container wraps the result in a delRun.
                const t = extractText(node, paragraphEl);
                if (t !== '') out.push({ text: t, ...props });
                break;
            }
            case 'tab':
                out.push({ text: '\t', ...props });
                break;
            case 'br': {
                const type = attr(node, 'w:type');
                if (type === 'page') out.push({ __pageBreak: true });
                else out.push({ text: '\n', ...props });
                break;
            }
            case 'cr':
                out.push({ text: '\n', ...props });
                break;
            case 'noBreakHyphen':
                out.push({ text: '\u2011', ...props });
                break;
            case 'softHyphen':
                out.push({ text: '\u00AD', ...props });
                break;
            case 'lastRenderedPageBreak':
                break;
            case 'fldChar': {
                const type = attr(node, 'w:fldCharType');
                if (type) out.push({ __fldChar: type });
                break;
            }
            case 'instrText': {
                const txt = node.textContent || '';
                if (txt.trim() !== '') out.push({ __fldText: txt });
                break;
            }
            case 'footnoteReference':
            case 'endnoteReference': {
                const id = attr(node, 'w:id') || '';
                const isEndnote = name === 'endnoteReference';
                const key = isEndnote ? 'e' + id : id;
                const available = isEndnote
                    ? !!(ctx.endnoteMap && ctx.endnoteMap.has(id))
                    : !!(ctx.footnoteMap && ctx.footnoteMap.has(id));
                if (!available) warn(ctx, 'FOOTNOTE_DEFERRED');
                out.push({ type: 'footnoteRef', id: key });
                break;
            }
            case 'drawing': {
                const img = parseDrawing(node, ctx);
                if (img) out.push(img);
                break;
            }
            case 'pict':
            case 'object': {
                const img = parseLegacyImage(node, ctx);
                if (img) out.push(img);
                break;
            }
            case 'AlternateContent':
            case 'alternateContent': {
                const choice = childNS(node, NS.mc, 'Choice') || child(node, 'Choice');
                const fallback = childNS(node, NS.mc, 'Fallback') || child(node, 'Fallback');
                const target = choice || fallback;
                if (target) {
                    const drawing = child(target, 'drawing') || childNS(target, NS.w, 'drawing');
                    if (drawing) {
                        const img = parseDrawing(drawing, ctx);
                        if (img) out.push(img);
                    } else {
                        const pict = child(target, 'pict') || child(target, 'object');
                        if (pict) {
                            const img = parseLegacyImage(pict, ctx);
                            if (img) out.push(img);
                        }
                    }
                }
                break;
            }
            default:
                break;
        }
    }
    return out;
}

/**
 * Resolves PAGE (and other) fields from a flattened run stream into a single
 * `{ type: 'pageNumber' }` marker run. Non-page fields are dropped.
 * @param {object[]} runs
 * @returns {object[]}
 */
function resolveFields(runs) {
    const hasField = (runs || []).some(r => r && (r.__fldChar || r.__fldText));
    if (!hasField) return runs;
    const out = [];
    let i = 0;
    while (i < runs.length) {
        const r = runs[i];
        if (r && r.__fldChar === 'begin') {
            let j = i + 1;
            let instr = null;
            while (j < runs.length && runs[j].__fldChar !== 'end') {
                if (runs[j] && runs[j].__fldText) instr = runs[j].__fldText;
                j++;
            }
            if (/PAGE/i.test(String(instr || ''))) out.push({ type: 'pageNumber' });
            i = j + 1;
            continue;
        }
        if (r && (r.__fldChar || r.__fldText)) { i++; continue; }
        out.push(r);
        i++;
    }
    return out;
}

/**
 * Parses a `w:hyperlink` into inline text runs carrying `href`.
 * Unresolvable links degrade to plain text with a warning.
 * @param {Element} hlEl
 * @param {object} ctx
 * @param {Element} paragraphEl
 * @param {object} [inherit] paragraph-level default run props
 * @returns {object[]}
 */
function parseLink(hlEl, ctx, paragraphEl, inherit) {
    const rId = attr(hlEl, 'r:id');
    const anchor = attr(hlEl, 'w:anchor');

    const childRuns = [];
    for (const node of Array.from(hlEl.childNodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const name = localNameOf(node);
        if (name === 'r') childRuns.push(...parseRun(node, ctx, paragraphEl, inherit));
        else if (name === 'ins' || name === 'del') {
            warn(ctx, 'TRACKED_CHANGE_DEFERRED');
            for (const sub of Array.from(node.childNodes)) {
                if (sub.nodeType === Node.ELEMENT_NODE && localNameOf(sub) === 'r') {
                    childRuns.push(...parseRun(sub, ctx, paragraphEl, inherit));
                }
            }
        } else if (name === 'sdt') {
            const content = child(node, 'sdtContent');
            if (content) {
                for (const sub of Array.from(content.childNodes)) {
                    if (sub.nodeType === Node.ELEMENT_NODE && localNameOf(sub) === 'r') {
                        childRuns.push(...parseRun(sub, ctx, paragraphEl, inherit));
                    }
                }
            }
        }
    }

    const textRuns = childRuns.filter(r => !r.__pageBreak);

    let href = null;
    let internal = false;
    if (rId) {
        const rel = ctx.rels.get(rId);
        if (rel && rel.target) {
            href = rel.mode === 'External' ? rel.target : resolveRelTarget(rel);
        } else {
            warn(ctx, 'LINK_TARGET_MISSING');
            return textRuns;
        }
    } else if (anchor) {
        if (ctx.bookmarks.has(anchor)) {
            href = '#' + anchor;
            internal = true;
        } else {
            warn(ctx, 'LINK_ANCHOR_MISSING');
            return textRuns;
        }
    }

    if (href === null) return textRuns;
    return textRuns.map(r => ({ ...r, href, ...(internal ? { internal: true } : {}) }));
}

// ─── T4. Images ───────────────────────────────────────────────────────────────

const EXT_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    webp: 'image/webp',
    ico: 'image/x-icon'
};

function mimeFor(path, bytes) {
    const ext = (String(path).split('.').pop() || '').toLowerCase();
    if (EXT_MIME[ext]) return EXT_MIME[ext];
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
    if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
    return 'application/octet-stream';
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function resolveRelTarget(rel) {
    if (!rel || !rel.target) return null;
    let t = String(rel.target).replace(/\\/g, '/');
    if (t.startsWith('/')) t = t.slice(1);
    else t = 'word/' + t;
    return normalizePartName(t);
}

/**
 * Builds a data-URL image run from a media part. No decoding ever happens.
 * @param {string} mediaPath
 * @param {object} ctx
 * @param {number|null} width
 * @param {number|null} height
 * @returns {object|null}
 */
function buildImageRun(mediaPath, ctx, width, height) {
    const bytes = ctx.reader.getBytes(mediaPath);
    if (!bytes) return null;
    if ((width != null && width > 40000) || (height != null && height > 40000)) {
        warn(ctx, 'IMAGE_SIZE_UNUSUAL');
    }
    const mime = mimeFor(mediaPath, bytes);
    const b64 = bytesToBase64(bytes);
    const run = { image: `data:${mime};base64,${b64}` };
    if (width != null) run.width = String(width);
    if (height != null) run.height = String(height);
    return run;
}

/**
 * Modern image path: `w:drawing` → `a:blip r:embed` → rels → media part.
 * @param {Element} el
 * @param {object} ctx
 * @returns {object|null}
 */
function parseDrawing(el, ctx) {
    let embedId = null;
    for (const blip of el.getElementsByTagNameNS(NS.a, 'blip')) {
        const embed = attrNS(blip, NS.r, 'embed');
        if (embed) {
            embedId = embed;
            break;
        }
        const link = attrNS(blip, NS.r, 'link');
        if (link) {
            warn(ctx, 'EXTERNAL_IMAGE');
            return null;
        }
    }
    if (!embedId) return null;
    const rel = ctx.rels.get(embedId);
    if (!rel || !rel.target) return null;
    const mediaPath = resolveRelTarget(rel);
    if (!mediaPath || !ctx.reader.parts.has(mediaPath)) return null;

    let width = null;
    let height = null;
    const ext = el.getElementsByTagNameNS(NS.wp, 'extent')[0];
    if (ext) {
        const cx = parseFloat(ext.getAttribute('cx'));
        const cy = parseFloat(ext.getAttribute('cy'));
        if (isFinite(cx) && cx > 0) width = emuToPx(cx);
        if (isFinite(cy) && cy > 0) height = emuToPx(cy);
    }
    return buildImageRun(mediaPath, ctx, width, height);
}

/**
 * Legacy path: `w:pict`/`w:object` → `v:imagedata r:id`; extents from the
 * `v:shape` style string. Imported best effort with a warning.
 * @param {Element} el
 * @param {object} ctx
 * @returns {object|null}
 */
function parseLegacyImage(el, ctx) {
    warn(ctx, 'LEGACY_IMAGE');
    const imagedata = el.getElementsByTagNameNS(NS.v, 'imagedata')[0];
    if (!imagedata) return null;
    const rId = attrNS(imagedata, NS.r, 'id');
    if (!rId) return null;
    const rel = ctx.rels.get(rId);
    if (!rel || !rel.target) return null;
    const mediaPath = resolveRelTarget(rel);
    if (!mediaPath || !ctx.reader.parts.has(mediaPath)) return null;

    let width = null;
    let height = null;
    const shape = el.getElementsByTagNameNS(NS.v, 'shape')[0];
    if (shape) {
        const style = shape.getAttribute('style') || '';
        const wm = style.match(/width\s*:\s*([\d.]+)\s*(pt|px|em|mm|cm|in)?/i);
        const hm = style.match(/height\s*:\s*([\d.]+)\s*(pt|px|em|mm|cm|in)?/i);
        if (wm) width = lengthToPx(parseFloat(wm[1]), (wm[2] || 'pt').toLowerCase());
        if (hm) height = lengthToPx(parseFloat(hm[1]), (hm[2] || 'pt').toLowerCase());
    }
    return buildImageRun(mediaPath, ctx, width, height);
}

// ─── T6. Page setup ───────────────────────────────────────────────────────────

function classifyFormat(widthMM, heightMM) {
    for (const p of PAGE_PRESETS) {
        if (Math.abs(widthMM - p.w) <= 1 && Math.abs(heightMM - p.h) <= 1) return p.format;
        if (Math.abs(widthMM - p.h) <= 1 && Math.abs(heightMM - p.w) <= 1) return p.format;
    }
    return 'custom';
}

/**
 * Parses `w:sectPr` into a full `section` model block (exact page size,
 * margins, header/footer blocks, page-number flag) and mirrors the setup
 * into `ctx.pageSetup` for backward compatibility (last body-level sectPr
 * wins).
 * @param {Element} sectPr
 * @param {object} ctx
 * @returns {object} section block
 */
export function parseSectPr(sectPr, ctx) {
    const section = { type: 'section', pageFormat: 'a4', orientation: 'portrait', widthMM: 210, heightMM: 297 };

    const pgSz = child(sectPr, 'pgSz');
    if (pgSz) {
        const wRaw = attr(pgSz, 'w:w');
        const hRaw = attr(pgSz, 'w:h');
        if (wRaw != null && hRaw != null) {
            const wTwips = measureToTwips(wRaw);
            const hTwips = measureToTwips(hRaw);
            if (wTwips != null && hTwips != null) {
                const orientation = attr(pgSz, 'w:orient') === 'landscape' ? 'landscape' : 'portrait';
                section.orientation = orientation;
                let widthMM = twipsToMm(wTwips);
                let heightMM = twipsToMm(hTwips);
                if (orientation === 'landscape') {
                    // Normalize both writers that store the long side in w:w and
                    // those that keep portrait dimensions with an orientation flag.
                    const max = Math.max(widthMM, heightMM);
                    const min = Math.min(widthMM, heightMM);
                    widthMM = max;
                    heightMM = min;
                }
                section.widthMM = widthMM;
                section.heightMM = heightMM;
                section.pageFormat = classifyFormat(widthMM, heightMM);
            }
        }
    }

    const margins = {};
    const pgMar = child(sectPr, 'pgMar');
    if (pgMar) {
        margins.top = twipsToMm(attr(pgMar, 'w:top'));
        margins.bottom = twipsToMm(attr(pgMar, 'w:bottom'));
        margins.left = twipsToMm(attr(pgMar, 'w:left'));
        margins.right = twipsToMm(attr(pgMar, 'w:right'));
        const header = twipsToMm(attr(pgMar, 'w:header'));
        const footer = twipsToMm(attr(pgMar, 'w:footer'));
        if (header != null) section.headerDistance = header;
        if (footer != null) section.footerDistance = footer;
    }
    if (Object.keys(margins).length) section.margins = margins;

    const header = resolvePartBlocks(sectPr, 'headerReference', ctx);
    if (header) section.header = header;
    const footer = resolvePartBlocks(sectPr, 'footerReference', ctx);
    if (footer) section.footer = footer;

    if (child(sectPr, 'pgNumType')) section.pageNumbering = true;
    if (containsPageNumber(section.header)) section.pageNumbering = true;
    if (containsPageNumber(section.footer)) section.pageNumbering = true;

    ctx.pageSetup = {
        format: section.pageFormat,
        orientation: section.orientation,
        widthMM: section.widthMM,
        heightMM: section.heightMM,
        margins: {
            top: margins.top != null ? margins.top : null,
            bottom: margins.bottom != null ? margins.bottom : null,
            left: margins.left != null ? margins.left : null,
            right: margins.right != null ? margins.right : null
        }
    };
    return section;
}

/**
 * Resolves a `w:headerReference`/`w:footerReference` relationship to its
 * part and walks that part (header/footer body) with the shared walker,
 * attaching its blocks to the section. Falls back to null when unresolvable.
 * @param {Element} sectPr
 * @param {'headerReference'|'footerReference'} localName
 * @param {object} ctx
 * @returns {object[]|null}
 */
function resolvePartBlocks(sectPr, localName, ctx) {
    const refs = children(sectPr, localName);
    if (refs.length === 0) return null;
    const ref = refs.find(r => (attr(r, 'w:type') || 'default') === 'default') || refs[0];
    const rId = attr(ref, 'r:id');
    const rel = rId ? ctx.rels.get(rId) : null;
    if (!rel || !rel.target) return null;
    const partPath = resolveRelTarget(rel);
    if (!partPath || !ctx.reader.parts.has(partPath)) return null;
    const doc = ctx.reader.getPart(partPath);
    if (!doc) return null;
    // Header/footer parts reference their own media via a sibling rels file.
    const subCtx = { ...ctx, rels: parseRels(ctx.reader.getPart(relsPathFor(partPath))) };
    return walkBody(doc.documentElement, subCtx);
}

function relsPathFor(partPath) {
    const parts = String(partPath).split('/');
    const file = parts.pop();
    return parts.concat('_rels', `${file}.rels`).join('/');
}

function containsPageNumber(blocks) {
    return (blocks || []).some(b => (b.runs || []).some(r => r && r.type === 'pageNumber'));
}

// ─── T7. Styles, themes ───────────────────────────────────────────────────────

/**
 * Lazily loads `word/theme/theme1.xml` into a color map
 * (theme color name → '#rrggbb'). Cached on ctx.
 * @param {object} ctx
 * @returns {object} { colors: Map<string, string> }
 */
function loadTheme(ctx) {
    if (ctx.theme) return ctx.theme;
    ctx.theme = { colors: new Map() };
    const doc = ctx.reader.getPart('word/theme/theme1.xml');
    if (!doc) return ctx.theme;
    const scheme = doc.getElementsByTagNameNS(NS.a, 'clrScheme')[0];
    if (!scheme) return ctx.theme;
    for (const el of Array.from(scheme.children)) {
        if (el.nodeType !== Node.ELEMENT_NODE) continue;
        const name = localNameOf(el);
        if (!name) continue;
        const srgb = el.getElementsByTagNameNS(NS.a, 'srgbClr')[0];
        let val = srgb ? attr(srgb, 'val') : null;
        if (!val) {
            const sys = el.getElementsByTagNameNS(NS.a, 'sysClr')[0];
            val = sys ? (attr(sys, 'lastClr') || attr(sys, 'val')) : null;
        }
        if (val) ctx.theme.colors.set(name, String(val).toLowerCase());
    }
    return ctx.theme;
}

function hexWithShadeTint(hex, shade, tint) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const comps = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    let [r, g, b] = comps;
    const shadeN = parseInt(shade, 10);
    const tintN = parseInt(tint, 10);
    if (isFinite(shadeN)) {
        const f = Math.max(0, Math.min(100, shadeN)) / 100;
        r = Math.round(r * f); g = Math.round(g * f); b = Math.round(b * f);
    }
    if (isFinite(tintN)) {
        const f = Math.max(0, Math.min(100, tintN)) / 100;
        r = Math.round(r + (255 - r) * f);
        g = Math.round(g + (255 - g) * f);
        b = Math.round(b + (255 - b) * f);
    }
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolves a theme color reference (e.g. accent1) to a concrete color,
 * applying an optional shade/tint. Returns null so the caller keeps the
 * literal `w:val` (document default) instead.
 * @param {string} themeColor
 * @param {string|null} shade
 * @param {string|null} tint
 * @param {object} ctx
 * @returns {string|null}
 */
function resolveThemeColor(themeColor, shade, tint, ctx) {
    if (!themeColor) return null;
    const base = loadTheme(ctx).colors.get(String(themeColor).toLowerCase());
    if (!base) return null;
    if (shade != null || tint != null) {
        const modified = hexWithShadeTint(base, shade, tint);
        if (modified) return modified;
    }
    return '#' + base;
}

/**
 * Lazily loads `word/styles.xml` into a map of styleId → resolved props plus
 * the docDefaults. Cached on ctx.
 * @param {object} ctx
 * @returns {object} { map, docDefaults: { pPr, rPr } }
 */
function loadStyles(ctx) {
    if (ctx.styles) return ctx.styles;
    ctx.styles = { map: new Map(), docDefaults: { pPr: {}, rPr: {} } };
    const doc = ctx.reader.getPart('word/styles.xml');
    if (!doc) return ctx.styles;
    const root = doc.documentElement;
    const dd = child(root, 'docDefaults');
    if (dd) {
        const rPrDefault = child(dd, 'rPrDefault');
        const pPrDefault = child(dd, 'pPrDefault');
        if (rPrDefault) ctx.styles.docDefaults.rPr = parseRPr(child(rPrDefault, 'rPr'), ctx);
        if (pPrDefault) ctx.styles.docDefaults.pPr = parsePPr(child(pPrDefault, 'pPr'), ctx);
    }
    for (const style of doc.getElementsByTagNameNS(NS.w, 'style')) {
        const id = attr(style, 'w:styleId');
        if (!id) continue;
        const info = {
            type: attr(style, 'w:type') || 'paragraph',
            basedOn: null,
            pPr: {},
            rPr: {}
        };
        const basedOn = child(style, 'basedOn');
        if (basedOn) info.basedOn = attr(basedOn, 'w:val') || null;
        info.pPr = parsePPr(child(style, 'pPr'), ctx);
        info.rPr = parseRPr(child(style, 'rPr'), ctx);
        ctx.styles.map.set(id, info);
    }
    return ctx.styles;
}

/**
 * Walks the `basedOn` chain from a style to its base, returning the merged
 * props for the requested kind ('pPr' | 'rPr'). Unresolvable styles
 * contribute nothing (callers fall back to docDefaults).
 * @param {string} styleId
 * @param {object} ctx
 * @param {'pPr'|'rPr'} kind
 * @returns {object}
 */
function resolveStyleProps(styleId, ctx, kind) {
    const styles = loadStyles(ctx);
    const chain = [];
    const seen = new Set();
    let id = styleId;
    while (id) {
        if (seen.has(id)) break;
        seen.add(id);
        const info = styles.map.get(id);
        if (!info) break;
        chain.push(info);
        id = info.basedOn || null;
    }
    const merged = { ...styles.docDefaults[kind] };
    for (let i = chain.length - 1; i >= 0; i--) {
        Object.assign(merged, chain[i][kind]);
    }
    return merged;
}

/**
 * Effective run props: paragraph-inherited defaults, then the character
 * style chain (if any), then the run's direct formatting.
 * @param {object} direct
 * @param {object} inherit paragraph-level default run props
 * @param {object} ctx
 * @returns {object}
 */
function resolveRunProps(direct, inherit, ctx) {
    const out = { ...(inherit || {}) };
    if (direct && direct.styleId) {
        Object.assign(out, resolveStyleProps(direct.styleId, ctx, 'rPr'));
    }
    Object.assign(out, direct || {});
    delete out.styleId;
    return out;
}

// ─── T8. Tables ───────────────────────────────────────────────────────────────

const BORDER_SIDE_NAMES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];

function parseBorderSet(bordersEl) {
    if (!bordersEl) return null;
    const out = {};
    let any = false;
    for (const name of BORDER_SIDE_NAMES) {
        const el = bordersEl.getElementsByTagNameNS(NS.w, name)[0];
        if (!el) continue;
        const style = attr(el, 'w:val');
        if (!style || style === 'nil' || style === 'none') continue;
        const border = { style: String(style) };
        const size = parseInt(attr(el, 'w:sz'), 10);
        if (isFinite(size)) border.size = size;
        const color = attr(el, 'w:color');
        if (color && color !== 'auto') border.color = color;
        out[name] = border;
        any = true;
    }
    return any ? out : null;
}

/**
 * Parses `w:tbl` into a model `table` block (rows × cells, merging flags,
 * shading, borders, table width/alignment).
 * @param {Element} tblEl
 * @param {object} ctx
 * @returns {object}
 */
function parseTable(tblEl, ctx) {
    const out = { type: 'table', rows: [] };

    const tblPr = child(tblEl, 'tblPr');
    if (tblPr) {
        const tblW = child(tblPr, 'tblW');
        if (tblW) {
            const wVal = attr(tblW, 'w:w');
            const type = attr(tblW, 'w:type');
            if (type === 'pct' && wVal != null) {
                const raw = String(wVal);
                const hasSuffix = /%$/.test(raw);
                const n = parseFloat(raw);
                const pct = hasSuffix ? Math.round(n * 10) / 10 : Math.round((n / 50) * 10) / 10;
                if (isFinite(pct) && pct > 0) out.width = pct + '%';
            } else if (type === 'dxa' && wVal != null) {
                const pt = twipsToPt(wVal);
                if (pt != null && pt > 0) out.width = pt + 'pt';
            }
        }
        const jc = child(tblPr, 'jc');
        if (jc) {
            const align = mapAlignment(attr(jc, 'w:val'));
            if (align && align !== 'justify') out.alignment = align;
        }
        const borders = parseBorderSet(child(tblPr, 'tblBorders'));
        if (borders) out.borders = borders;
    }

    const rows = [];
    for (const node of Array.from(tblEl.childNodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (localNameOf(node) !== 'tr') continue;
        rows.push(parseTableRow(node, ctx));
    }
    out.rows = rows;
    let cols = 0;
    for (const row of rows) {
        let width = 0;
        for (const cell of row) {
            width += (cell && typeof cell === 'object' && Number.isInteger(cell.gridSpan)) ? cell.gridSpan : 1;
        }
        cols = Math.max(cols, width);
    }
    out.cols = cols;
    return out;
}

function parseTableRow(trEl, ctx) {
    const cells = [];
    for (const node of Array.from(trEl.childNodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (localNameOf(node) !== 'tc') continue;
        cells.push(parseTableCell(node, ctx));
    }
    return cells;
}

function parseTableCell(tcEl, ctx) {
    const cell = {};
    const tcPr = child(tcEl, 'tcPr');
    if (tcPr) {
        const gridSpan = child(tcPr, 'gridSpan');
        if (gridSpan) {
            const v = parseInt(attr(gridSpan, 'w:val'), 10);
            if (isFinite(v) && v > 1) cell.gridSpan = v;
        }
        const vMerge = child(tcPr, 'vMerge');
        if (vMerge) {
            cell.vMerge = (attr(vMerge, 'w:val') || 'continue') === 'restart' ? 'restart' : 'continue';
        }
        const shd = child(tcPr, 'shd');
        if (shd) {
            const fill = attr(shd, 'w:fill');
            if (fill && fill !== 'auto') cell.shading = '#' + fill;
            else {
                const themeFill = attr(shd, 'w:themeFill');
                if (themeFill) {
                    const resolved = resolveThemeColor(themeFill, null, null, ctx);
                    if (resolved) cell.shading = resolved;
                }
            }
        }
        const tcW = child(tcPr, 'tcW');
        if (tcW) {
            const wVal = attr(tcW, 'w:w');
            const type = attr(tcW, 'w:type');
            if (type === 'dxa' && wVal != null) {
                const pt = twipsToPt(wVal);
                if (pt != null && pt > 0) cell.width = pt + 'pt';
            }
        }
    }

    const texts = [];
    for (const node of Array.from(tcEl.childNodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const name = localNameOf(node);
        if (name === 'p') {
            for (const block of parseParagraph(node, ctx)) {
                if (block.type === 'paragraph' || block.type === 'heading') {
                    const t = (block.runs || []).map(r => r.text ?? '').join('');
                    texts.push(t);
                }
            }
        } else if (name === 'tbl') {
            warn(ctx, 'NESTED_TABLE_SKIPPED');
        }
    }

    const text = texts.join('\n');
    if (text !== '') cell.text = text;
    const hasProps = cell.shading !== undefined || cell.gridSpan !== undefined || cell.vMerge !== undefined || cell.width !== undefined;
    if (text === '' && !hasProps) return '';
    return cell;
}

// ─── T8b. Basic list best effort ──────────────────────────────────────────────

function loadNumbering(ctx) {
    if (ctx.numbering) return ctx.numbering;
    ctx.numbering = { map: new Map() };
    const doc = ctx.reader.getPart('word/numbering.xml');
    if (!doc) return ctx.numbering;

    const abstractNums = new Map();
    for (const an of doc.getElementsByTagNameNS(NS.w, 'abstractNum')) {
        const id = attr(an, 'w:abstractNumId');
        if (id == null) continue;
        const levels = [];
        for (const lvl of an.getElementsByTagNameNS(NS.w, 'lvl')) {
            const ilvlAttr = attr(lvl, 'w:ilvl');
            const ilvl = ilvlAttr != null ? parseInt(ilvlAttr, 10) : levels.length;
            if (!isFinite(ilvl)) continue;
            const info = {};
            const numFmtEl = child(lvl, 'numFmt');
            if (numFmtEl) info.numFmt = attr(numFmtEl, 'w:val');
            const startEl = child(lvl, 'start');
            const startVal = startEl ? parseInt(attr(startEl, 'w:val'), 10) : 1;
            if (isFinite(startVal)) info.start = startVal;
            const pPr = child(lvl, 'pPr');
            const indEl = pPr ? child(pPr, 'ind') : null;
            if (indEl) {
                const left = twipsToPt(attr(indEl, 'w:left'));
                const hanging = twipsToPt(attr(indEl, 'w:hanging'));
                if (left != null) info.indentLeft = left;
                if (hanging != null) info.hanging = hanging;
            }
            levels[ilvl] = info;
        }
        abstractNums.set(id, levels);
    }

    for (const num of doc.getElementsByTagNameNS(NS.w, 'num')) {
        const numId = attr(num, 'w:numId');
        const anIdEl = child(num, 'abstractNumId');
        const anId = anIdEl ? attr(anIdEl, 'w:val') : null;
        if (numId == null || anId == null) continue;
        const overrides = [];
        for (const ov of num.getElementsByTagNameNS(NS.w, 'lvlOverride')) {
            const lvl = parseInt(attr(ov, 'w:ilvl'), 10);
            const startOv = child(ov, 'startOverride');
            const val = startOv ? parseInt(attr(startOv, 'w:val'), 10) : NaN;
            if (isFinite(lvl) && isFinite(val)) overrides[lvl] = val;
        }
        ctx.numbering.map.set(numId, {
            levels: abstractNums.get(anId) || [],
            overrides
        });
    }
    return ctx.numbering;
}

const ORDERED_NUM_FMTS = [
    'decimal', 'decimalzero',
    'lowerletter', 'upperletter',
    'lowerroman', 'upperroman',
    'ordinal', 'cardinaltext', 'ordinaltext'
];

/**
 * Resolves a paragraph's `w:numPr` to a listItem shape. Reads the abstract
 * numbering level for the paragraph's ilvl: numFmt → listType, start + indent.
 * Returns null when numbering.xml is missing/malformed (the caller degrades to
 * a flat paragraph with NUMBERING_DEFERRED).
 * @param {{numId:string, level:number}} list
 * @param {object} ctx
 * @returns {{listType:string, level:number, start?:number, indentLeft?:number, hanging?:number}|null}
 */
function resolveList(list, ctx) {
    const numbering = loadNumbering(ctx);
    const numInfo = numbering.map.get(String(list.numId));
    if (!numInfo) return null;
    const level = Math.min(8, Math.max(0, Number(list.level) || 0));
    const lvlInfo = (numInfo.levels || [])[level];
    if (!lvlInfo || !lvlInfo.numFmt) return null;
    const fmt = String(lvlInfo.numFmt).toLowerCase();
    if (fmt === 'bullet') {
        return { listType: 'unordered', level };
    }
    if (!ORDERED_NUM_FMTS.includes(fmt)) return null;

    const out = { listType: 'ordered', level };
    let start = lvlInfo.start;
    const override = (numInfo.overrides || [])[level];
    if (override != null) start = override;
    if (start != null && start !== 1) out.start = start;
    if (lvlInfo.indentLeft != null) out.indentLeft = lvlInfo.indentLeft;
    if (lvlInfo.hanging != null) out.hanging = lvlInfo.hanging;
    return out;
}

// ─── Paragraph assembly ───────────────────────────────────────────────────────

function makeParagraphBlock(props) {
    const block = { type: 'paragraph', runs: [] };
    if (props.align) block.align = props.align;
    if (props.indentLeft != null) block.indentLeft = props.indentLeft;
    if (props.indentRight != null) block.indentRight = props.indentRight;
    if (props.firstLine != null) block.firstLine = props.firstLine;
    if (props.spaceBefore != null) block.spaceBefore = props.spaceBefore;
    if (props.spaceAfter != null) block.spaceAfter = props.spaceAfter;
    if (props.lineSpacing != null) block.lineSpacing = props.lineSpacing;
    if (props.lineRule) block.lineRule = props.lineRule;
    if (props.keepNext) block.keepNext = true;
    if (props.keepLines) block.keepLines = true;
    return block;
}

function headingInfo(props, ctx) {
    const styleId = props.styleId;
    if (styleId) {
        const norm = String(styleId).toLowerCase().replace(/[\s_-]+/g, '');
        const m = norm.match(/^heading([1-6])$/);
        if (m) return { level: parseInt(m[1], 10) };
        if (norm === 'title') return { level: 1 };
        if (/^(head|heading|title)/.test(norm)) warn(ctx, 'UNKNOWN_STYLE');
    }
    if (props.outlineLvl !== undefined) return { level: props.outlineLvl + 1 };
    return null;
}

/**
 * Converts a built paragraph block into heading/listItem per its props.
 * @param {object} block
 * @param {object} props
 * @param {object} ctx
 */
function finalizeParagraph(block, props, ctx) {
    const heading = headingInfo(props, ctx);
    if (heading) {
        block.type = 'heading';
        block.level = heading.level;
        return block;
    }
    if (props.list) {
        const resolved = resolveList(props.list, ctx);
        if (resolved) {
            block.type = 'listItem';
            block.listType = resolved.listType;
            block.level = resolved.level;
            if (resolved.start != null) block.start = resolved.start;
            if (resolved.indentLeft != null) block.indentLeft = resolved.indentLeft;
            if (resolved.hanging != null) block.hanging = resolved.hanging;
        } else {
            warn(ctx, 'NUMBERING_DEFERRED');
        }
    }
    return block;
}

function parseContainer(container, ctx, paragraphEl, inherit) {
    const { el, type } = container;
    if (type === 'run') return parseRun(el, ctx, paragraphEl, inherit);
    if (type === 'hyperlink') return parseLink(el, ctx, paragraphEl, inherit);
    if (type === 'commentRangeStart') {
        return [{ type: 'commentRangeStart', id: attr(el, 'w:id') || '' }];
    }
    if (type === 'commentRangeEnd') {
        return [{ type: 'commentRangeEnd', id: attr(el, 'w:id') || '' }];
    }
    // ins / del: preserve tracked changes as insRun/delRun runs carrying the
    // change's author/date.
    const change = {
        kind: type === 'del' ? 'delete' : 'insert',
        author: attr(el, 'w:author') || '',
        date: attr(el, 'w:date') || ''
    };
    const runs = [];
    for (const node of Array.from(el.childNodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const name = localNameOf(node);
        if (name === 'r') runs.push(...parseRun(node, ctx, paragraphEl, inherit));
        else if (name === 'hyperlink') runs.push(...parseLink(node, ctx, paragraphEl, inherit));
        else if (name === 'sdt') {
            const content = child(node, 'sdtContent');
            if (content) {
                for (const sub of Array.from(content.childNodes)) {
                    if (sub.nodeType === Node.ELEMENT_NODE && localNameOf(sub) === 'r') {
                        runs.push(...parseRun(sub, ctx, paragraphEl, inherit));
                    }
                }
            }
        }
    }
    return wrapChange(runs, change);
}

/**
 * Wraps plain text runs in a tracked-change wrapper when a change context is
 * active. Runs that are already tracked, markers, or images are left as-is so
 * the model stays valid (tracked runs require text).
 * @param {object[]} runs
 * @param {{kind:string, author?:string, date?:string}|null} change
 * @returns {object[]}
 */
function wrapChange(runs, change) {
    if (!change) return runs;
    const type = change.kind === 'delete' ? 'delRun' : 'insRun';
    return runs.map(r => {
        if (!r || typeof r !== 'object') return r;
        if (r.type === 'insRun' || r.type === 'delRun') return r;
        if (r.text === undefined) return r;
        const wrapped = { type, ...r };
        if (change.author) wrapped.author = change.author;
        if (change.date) wrapped.date = change.date;
        return wrapped;
    });
}

/**
 * Parses a `w:p` into one or more blocks. Manual page-break `<br>` splits a
 * paragraph into multiple blocks around a `pageBreak` block. A `w:sectPr`
 * nested in `w:pPr` terminates the section and appends a `section` block.
 * @param {Element} pEl
 * @param {object} ctx
 * @returns {object[]}
 */
function parseParagraph(pEl, ctx) {
    const pPr = child(pEl, 'pPr');
    const props = parsePPr(pPr, ctx);

    // Resolve paragraph/character styles + docDefaults into effective props.
    // Direct (inline) formatting always wins over style-derived values.
    const styles = loadStyles(ctx);
    const blockProps = { ...styles.docDefaults.pPr };
    const inheritedRunProps = { ...styles.docDefaults.rPr };
    if (props.styleId) {
        Object.assign(blockProps, resolveStyleProps(props.styleId, ctx, 'pPr'));
        Object.assign(inheritedRunProps, resolveStyleProps(props.styleId, ctx, 'rPr'));
    }
    Object.assign(blockProps, props);

    const blocks = [];
    let current = makeParagraphBlock(blockProps);
    blocks.push(current);

    if (blockProps.pageBreakBefore) blocks.unshift({ type: 'pageBreak' });

    for (const container of collectRuns(pEl, ctx)) {
        const parsed = wrapChange(parseContainer(container, ctx, pEl, inheritedRunProps), ctx.change);
        for (const run of parsed) {
            if (run && run.__pageBreak) {
                blocks.push({ type: 'pageBreak' });
                current = makeParagraphBlock(blockProps);
                blocks.push(current);
                continue;
            }
            current.runs.push(run);
        }
    }

    const sectPr = pPr ? child(pPr, 'sectPr') : null;
    if (sectPr) {
        blocks.push(parseSectPr(sectPr, ctx));
    }

    return blocks.map(b => {
        if (b.type === 'pageBreak' || b.type === 'section') return b;
        b.runs = resolveFields(b.runs);
        b.runs = mergeRunsLocal(b.runs);
        return finalizeParagraph(b, blockProps, ctx);
    });
}

// ─── T9. Annotations (footnotes, comments, tracked changes) ───────────────────

/**
 * Loads the annotation parts (footnotes.xml, endnotes.xml, comments.xml) into
 * `ctx.footnoteMap` / `ctx.endnoteMap` / `ctx.commentMap`, keyed by their
 * `w:id`. Special footnotes (separators, continuation markers) are skipped.
 * Must run before `walkBody` so footnoteReference availability can be checked
 * while runs are parsed. No-op on missing parts.
 * @param {object} ctx
 */
export function loadAnnotationParts(ctx) {
    ctx.footnoteMap = new Map();
    ctx.endnoteMap = new Map();
    ctx.commentMap = new Map();
    const specialTypes = new Set(['separator', 'continuationSeparator', 'continuationNotice', 'separatorNote']);

    const footnotePart = ctx.reader.getPart('word/footnotes.xml');
    if (footnotePart) {
        for (const fn of footnotePart.getElementsByTagNameNS(NS.w, 'footnote')) {
            const id = attr(fn, 'w:id');
            if (id == null) continue;
            if (parseInt(id, 10) < 0) continue;
            const typeEl = child(fn, 'type');
            const fnType = attr(fn, 'w:type') || (typeEl ? attr(typeEl, 'w:val') : null);
            if (fnType && specialTypes.has(fnType)) continue;
            ctx.footnoteMap.set(String(id), walkBody(fn, ctx));
        }
    }

    const endnotePart = ctx.reader.getPart('word/endnotes.xml');
    if (endnotePart) {
        for (const en of endnotePart.getElementsByTagNameNS(NS.w, 'endnote')) {
            const id = attr(en, 'w:id');
            if (id == null) continue;
            if (parseInt(id, 10) < 0) continue;
            const typeEl = child(en, 'type');
            const fnType = attr(en, 'w:type') || (typeEl ? attr(typeEl, 'w:val') : null);
            if (fnType && specialTypes.has(fnType)) continue;
            ctx.endnoteMap.set(String(id), walkBody(en, ctx));
        }
    }

    const commentsPart = ctx.reader.getPart('word/comments.xml');
    if (commentsPart) {
        for (const cm of commentsPart.getElementsByTagNameNS(NS.w, 'comment')) {
            const id = attr(cm, 'w:id');
            if (id == null) continue;
            const author = attr(cm, 'w:author') || '';
            const date = attr(cm, 'w:date') || '';
            const blocks = walkBody(cm, ctx);
            const text = blocks
                .filter(b => b && (b.type === 'paragraph' || b.type === 'heading'))
                .map(b => (b.runs || []).map(r => r.text ?? '').join(''))
                .join('\n');
            ctx.commentMap.set(String(id), { author, date, text });
        }
    }
}

/**
 * Collects unique tracked-change records ({ kind, author?, date? }) from every
 * run in a set of blocks, walking section header/footer blocks too. Records
 * are de-duplicated on (kind, author, date); order is first occurrence.
 * @param {object[]} blocks
 * @returns {object[]}
 */
function collectRevisions(blocks) {
    const revisions = [];
    const seen = new Set();
    const add = (kind, author, date) => {
        const key = `${kind}\u0000${author || ''}\u0000${date || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        const r = { kind };
        if (author) r.author = author;
        if (date) r.date = date;
        revisions.push(r);
    };
    const visitRuns = runs => {
        for (const run of runs || []) {
            if (!run || typeof run !== 'object') continue;
            if (run.type === 'insRun') add('insert', run.author, run.date);
            else if (run.type === 'delRun') add('delete', run.author, run.date);
            if (run.formatChange) add('format', run.formatChange.author, run.formatChange.date);
        }
    };
    const visitBlock = block => {
        if (!block || typeof block !== 'object') return;
        visitRuns(block.runs);
        for (const key of ['header', 'footer']) {
            for (const b of block[key] || []) visitBlock(b);
        }
    };
    for (const b of blocks) visitBlock(b);
    return revisions;
}

/**
 * Returns the document's default run font family (from `styles.xml`
 * docDefaults), or undefined when none is declared. Runs that carry this exact
 * family are merely inheriting the document default, which the canonical model
 * folds away for stable round-trip comparison.
 * @param {object} ctx
 * @returns {string|undefined}
 */
export function getDocDefaultFont(ctx) {
    return loadStyles(ctx).docDefaults.rPr.fontFamily;
}

/**
 * Builds the canonical annotation sections for a document: `footnotes`
 * ({ id, index, blocks[] }; endnotes merged in with an `e`-prefixed id so the
 * two id spaces never collide), `comments` ({ id, author?, date?, text }) and
 * `revisions` (deduplicated tracked-change records derived from the runs).
 * @param {object} ctx
 * @param {object[]} [blocks] body blocks (used to derive the revisions list)
 * @returns {{footnotes:object[], comments:object[], revisions:object[]}}
 */
export function buildAnnotationSections(ctx, blocks = []) {
    const footnotes = [];
    const footnoteIds = Array.from((ctx.footnoteMap || new Map()).keys()).sort();
    footnoteIds.forEach((id, i) => {
        footnotes.push({ id, index: i + 1, blocks: ctx.footnoteMap.get(id) });
    });
    const endnoteIds = Array.from((ctx.endnoteMap || new Map()).keys()).sort();
    endnoteIds.forEach((id, i) => {
        footnotes.push({ id: 'e' + id, index: footnotes.length + i + 1, blocks: ctx.endnoteMap.get(id) });
    });

    const comments = [];
    Array.from((ctx.commentMap || new Map()).keys())
        .sort()
        .forEach(id => {
            const c = ctx.commentMap.get(id);
            const comment = { id };
            if (c.author) comment.author = c.author;
            if (c.date) comment.date = c.date;
            if (c.text) comment.text = c.text;
            comments.push(comment);
        });

    const allBlocks = blocks.slice();
    (ctx.footnoteMap || new Map()).forEach(b => allBlocks.push(...b));
    (ctx.endnoteMap || new Map()).forEach(b => allBlocks.push(...b));

    return { footnotes, comments, revisions: collectRevisions(allBlocks) };
}