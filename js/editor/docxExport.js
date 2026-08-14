import { state, getPages } from './state.js';
import { pagesToModel } from './html.js';
import { normalizeModel, DEFAULT_FONT_FAMILY } from './model.js';
import { loadFflate } from './ooxml.js';
import { showToast } from './toast.js';

// ─── On-demand library loading ───────────────────────────────────────────────
// `docx` is a large client-side OOXML generator. It is loaded lazily via a
// dynamic `import()` so Vite emits it as a separate chunk fetched only when the
// user first exports. The app start never pulls it in.

let docxModulePromise = null;

/**
 * Loads the `docx` library on demand and caches the module promise.
 * @returns {Promise<object>}
 */
export function ensureDocxLib() {
    if (!docxModulePromise) {
        docxModulePromise = import('docx').catch(err => {
            docxModulePromise = null;
            throw err;
        });
    }
    return docxModulePromise;
}

// ─── Font mapping (fonts.json → Word families) ───────────────────────────────
// Scriben ships Google Fonts that Microsoft Word does not install by default.
// Map them to the closest system-equivalent so documents open cleanly in Word.
// System fonts (Arial, Georgia, Times New Roman, Calibri) pass through by name.

const FONT_MAP = {
    'noto sans': 'Calibri',
    'google sans': 'Arial',
    'inter': 'Calibri',
    'montserrat': 'Century Gothic',
    'lato': 'Calibri',
    'oswald': 'Arial Narrow',
    'nunito': 'Segoe UI',
    'nunito sans': 'Segoe UI',
    'playfair display': 'Georgia',
    'playwrite gb s guides': 'Comic Sans MS',
    'playwrite gb j': 'Comic Sans MS',
    'roboto slab': 'Georgia',
    'ubuntu': 'Verdana',
    'roboto': 'Arial',
    'arial': 'Arial',
    'georgia': 'Georgia',
    'times new roman': 'Times New Roman',
    'calibri': 'Calibri'
};

/**
 * Maps a Scriben font (single name or CSS stack) to a Word-family name.
 * Unknown fonts pass through unchanged.
 * @param {string} name
 * @returns {string}
 */
export function mapFontToWord(name) {
    if (!name) return 'Calibri';
    const primary = String(name).split(',')[0].replace(/['"]/g, '').trim();
    if (!primary) return 'Calibri';
    const mapped = FONT_MAP[primary.toLowerCase()];
    return mapped || primary;
}

// ─── Page setup ──────────────────────────────────────────────────────────────
// Same table as pdf.js:36. Margins mirror the editor page padding (.page, 25.4mm).

const PAGE_SIZES = {
    a4: { width: '210mm', height: '297mm' },
    a5: { width: '148mm', height: '210mm' },
    letter: { width: '215.9mm', height: '279.4mm' },
    legal: { width: '215.9mm', height: '355.6mm' }
};

function pageSizeForFormat(format) {
    return PAGE_SIZES[format] || PAGE_SIZES.a4;
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

/**
 * Converts a CSS color to the 6-digit hex (no '#') Word expects.
 * Handles #rgb/#rrggbb, rgb()/rgba() and named colors (via a probe element
 * when a DOM is available; pure #hex inputs never need it).
 * @param {string} value
 * @returns {string|undefined}
 */
function toHexColor(value) {
    if (!value) return undefined;
    const v = String(value).trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.slice(1).toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(v)) {
        return v.slice(1).split('').map(c => c + c).join('').toUpperCase();
    }
    if (typeof document === 'undefined') return undefined;
    try {
        const probe = document.createElement('span');
        probe.style.color = v;
        probe.style.display = 'none';
        document.body.appendChild(probe);
        const computed = getComputedStyle(probe).color;
        document.body.removeChild(probe);
        const m = computed.match(/[\d.]+/g);
        if (m && m.length >= 3) {
            return m.slice(0, 3)
                .map(n => Math.round(Number(n)).toString(16).padStart(2, '0'))
                .join('')
                .toUpperCase();
        }
    } catch (err) {
        // Fall through to undefined; the run just keeps the default color.
    }
    return undefined;
}

/**
 * Converts a CSS font-size (px/pt/em) to Word half-points.
 * @param {string|number} value
 * @returns {number|undefined}
 */
function fontSizeToHalfPoints(value) {
    if (value === undefined || value === null) return undefined;
    const s = String(value).trim();
    const m = s.match(/^([\d.]+)\s*(px|pt|em)?$/i);
    if (!m) return undefined;
    const n = parseFloat(m[1]);
    if (!isFinite(n) || n <= 0) return undefined;
    const unit = m[2] ? m[2].toLowerCase() : '';
    if (unit === 'pt') return Math.round(n * 2);
    if (unit === 'em') return Math.round(n * 24); // 1em = 12pt
    return Math.round(n * 1.5); // px → pt (×0.75) → half-points (×2)
}

function mapAlignment(align, docx) {
    switch (String(align).toLowerCase()) {
        case 'center': return docx.AlignmentType.CENTER;
        case 'right': return docx.AlignmentType.RIGHT;
        case 'justify': return docx.AlignmentType.JUSTIFIED;
        case 'start': return docx.AlignmentType.START;
        case 'end': return docx.AlignmentType.END;
        default: return docx.AlignmentType.LEFT;
    }
}

/**
 * Builds the TextRun options object for a single model run. A tracked format
 * change (`run.formatChange`) is re-emitted as a `w:rPrChange` revision with a
 * fresh numeric id (deterministic per build).
 * @param {object} run
 * @param {string} text
 * @param {object} docx
 * @param {object} [ctx]
 * @returns {object}
 */
function runOptions(run, text, docx, ctx) {
    const opts = { text };
    if (run.bold) opts.bold = true;
    if (run.italic) opts.italics = true;
    if (run.underline) opts.underline = {};
    if (run.strikethrough) opts.strike = true;
    if (run.superscript) opts.superScript = true;
    if (run.subscript) opts.subScript = true;
    if (run.color) {
        const color = toHexColor(run.color);
        if (color) opts.color = color;
    }
    if (run.backgroundColor) {
        const fill = toHexColor(run.backgroundColor);
        if (fill) opts.shading = { type: docx.ShadingType.CLEAR, fill };
    }
    if (run.fontFamily) opts.font = mapFontToWord(run.fontFamily);
    if (run.fontSize) {
        const size = fontSizeToHalfPoints(run.fontSize);
        if (size) opts.size = size;
    }
    if (run.formatChange && run.formatChange.author && ctx) {
        opts.revision = {
            id: ctx.revId++,
            author: run.formatChange.author,
            date: run.formatChange.date || ''
        };
    }
    return opts;
}

/**
 * Emits one or more runs for a model text run, splitting on '\n' (hard breaks)
 * into separate runs so each line keeps its formatting. `makeRun` overrides
 * the run constructor so tracked inserts/deletes reuse the same split logic.
 * @param {object} run
 * @param {object} docx
 * @param {object} [ctx]
 * @param {(opts:object)=>object} [makeRun] run factory
 * @returns {object[]}
 */
function runToTextRuns(run, docx, ctx, makeRun) {
    if (!run || run.image || run.text === undefined) return [];
    const make = makeRun || (opts => new docx.TextRun(opts));
    const lines = String(run.text).split('\n');
    const runs = [];
    lines.forEach((line, i) => {
        const opts = runOptions(run, line, docx, ctx);
        if (i > 0) opts.break = 1;
        runs.push(make(opts));
    });
    return runs;
}

// ─── Images ──────────────────────────────────────────────────────────────────

/**
 * Converts a CSS length (px/pt/in/mm/cm/em) to pixels for OOXML drawing extents.
 * @param {string|number} value
 * @returns {number|null}
 */
function lengthToPx(value) {
    if (value === undefined || value === null || value === '') return null;
    const m = String(value).trim().match(/^([\d.]+)\s*(px|pt|in|mm|cm|em)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!isFinite(n) || n < 0) return null;
    switch ((m[2] || 'px').toLowerCase()) {
        case 'pt': return Math.round(n * 96 / 72 * 10) / 10;
        case 'in': return Math.round(n * 96 * 10) / 10;
        case 'mm': return Math.round(n * 96 / 25.4 * 10) / 10;
        case 'cm': return Math.round(n * 96 / 2.54 * 10) / 10;
        case 'em': return Math.round(n * 16 * 10) / 10;
        default: return n; // px or unitless
    }
}

/**
 * Builds a docx ImageRun from a Base64 data-URL. Bytes are used verbatim — no
 * decoding, rasterizing or re-encoding ever happens (privacy + quality).
 * @param {string} src data URL
 * @param {string|number|null} width
 * @param {string|number|null} height
 * @param {object} docx
 * @returns {object|null}
 */
function imageRunFromDataUrl(src, width, height, docx) {
    if (typeof src !== 'string') return null;
    const m = src.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
    if (!m) return null;
    const mime = m[1].toLowerCase();
    let type = 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) type = 'jpg';
    else if (mime.includes('gif')) type = 'gif';
    else if (mime.includes('bmp')) type = 'bmp';

    let bytes;
    try {
        const binary = atob(m[2]);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } catch (err) {
        return null;
    }

    const w = lengthToPx(width) || 100;
    const h = lengthToPx(height) || 100;
    return new docx.ImageRun({
        type,
        data: bytes,
        transformation: { width: Math.max(1, w), height: Math.max(1, h) }
    });
}

// ─── Lists ───────────────────────────────────────────────────────────────────
// One numbering reference per (list type, start) combination, with up to
// max-observed-depth levels. Consecutive listItem blocks sharing a reference
// key render as one logical list in Word.

const BULLET_SYMBOLS = ['\u2022', '\u25E6', '\u25AA'];

/**
 * Reference key for a listItem. Ordered lists carry their `start` so a
 * `start=5` list round-trips as an independent numbering definition.
 * @param {object} item
 * @returns {string}
 */
function listReferenceKey(item) {
    if (item.listType !== 'ordered') return 'unordered';
    const start = Number(item.start) || 1;
    return start === 1 ? 'ordered' : `ordered-${start}`;
}

/**
 * Builds the docx `numbering.config` from the model's listItem blocks.
 * @param {object[]} blocks
 * @param {object} docx
 * @returns {object[]}
 */
function buildNumberingConfig(blocks, docx) {
    const byKey = new Map();
    for (const block of blocks) {
        if (!block || block.type !== 'listItem') continue;
        const key = listReferenceKey(block);
        const level = Number(block.level) || 0;
        const info = byKey.get(key) || { maxLevel: 0, indents: {} };
        if (level > info.maxLevel) info.maxLevel = level;
        if (block.indentLeft != null || block.hanging != null) {
            info.indents[level] = {
                ...(block.indentLeft != null ? { left: Math.round(Number(block.indentLeft) * 20) } : {}),
                ...(block.hanging != null ? { hanging: Math.round(Number(block.hanging) * 20) } : {})
            };
        }
        byKey.set(key, info);
    }

    const config = [];
    for (const [key, info] of byKey) {
        const ordered = key !== 'unordered';
        const start = ordered ? (key === 'ordered' ? 1 : parseInt(key.slice('ordered-'.length), 10) || 1) : 1;
        const levels = [];
        for (let lvl = 0; lvl <= info.maxLevel; lvl++) {
            const levelOpts = { level: lvl };
            const indent = info.indents[lvl];
            if (indent) levelOpts.style = { paragraph: { indent } };
            if (ordered) {
                levelOpts.format = docx.LevelFormat.DECIMAL;
                levelOpts.text = `%${lvl + 1}.`;
                levelOpts.start = lvl === 0 ? start : 1;
            } else {
                levelOpts.format = docx.LevelFormat.BULLET;
                levelOpts.text = BULLET_SYMBOLS[lvl % BULLET_SYMBOLS.length];
            }
            levels.push(levelOpts);
        }
        config.push({ reference: key, levels });
    }
    return config;
}

/**
 * Maps each listItem block to its numbering reference key (grouping
 * consecutive same-key items into one logical list).
 * @param {object[]} blocks
 * @returns {Map<object, string>}
 */
function buildListNumberingMap(blocks) {
    const map = new Map();
    let i = 0;
    while (i < blocks.length) {
        const block = blocks[i];
        if (block && block.type === 'listItem') {
            const key = listReferenceKey(block);
            while (i < blocks.length && blocks[i] && blocks[i].type === 'listItem' && listReferenceKey(blocks[i]) === key) {
                map.set(blocks[i], key);
                i++;
            }
        } else {
            i++;
        }
    }
    return map;
}

// ─── Links ───────────────────────────────────────────────────────────────────
// External links become w:hyperlink + rels (docx emits the rels automatically).
// Internal anchors (`#...`) become bookmarks + w:anchor hyperlinks. Bookmarks
// are attached to the first heading (or first paragraph when no heading exists)
// so every anchor referenced by the model survives a round-trip.

function isInternalHref(href) {
    return typeof href === 'string' && href.startsWith('#') && href.length > 1;
}

/**
 * Collects the unique internal anchor names referenced by the model and
 * assigns each a stable numeric bookmark id.
 * @param {object[]} blocks
 * @returns {Map<string, number>} anchor name → numeric id
 */
function collectInternalAnchors(blocks) {
    const anchors = new Map();
    const visitRuns = runs => {
        for (const run of runs || []) {
            if (run && isInternalHref(run.href) && !anchors.has(run.href.slice(1))) {
                anchors.set(run.href.slice(1), 0);
            }
        }
    };
    for (const block of blocks) {
        if (!block) continue;
        if (block.type === 'link' && isInternalHref(block.href) && !anchors.has(block.href.slice(1))) {
            anchors.set(block.href.slice(1), 0);
        }
        visitRuns(block.runs);
    }
    let id = 1;
    for (const name of anchors.keys()) anchors.set(name, id++);
    return anchors;
}

// ─── Block → OOXML ───────────────────────────────────────────────────────────

/**
 * Prepends bookmark markers on the first paragraph-capable block once.
 * @param {object[]} children
 * @param {object} ctx
 * @param {object} docx
 * @returns {object[]}
 */
function wrapWithBookmarks(children, ctx, docx) {
    if (ctx.bookmarksPlaced || !ctx.bookmarkChildren || ctx.bookmarkChildren.length === 0) return children;
    ctx.bookmarksPlaced = true;
    return [...ctx.bookmarkChildren, ...children];
}

/**
 * Emits OOXML paragraph children for a single model run: text (with optional
 * hyperlink wrapping), an inline image, a footnote/endnote reference, comment
 * range markers, or a tracked insert/delete run.
 * @param {object} run
 * @param {object} docx
 * @param {object} ctx
 * @returns {object[]}
 */
function runToChildren(run, docx, ctx) {
    if (!run) return [];
    if (run.image) {
        const img = imageRunFromDataUrl(run.image, run.width, run.height, docx);
        return img ? [img] : [];
    }
    if (run.type === 'pageNumber') {
        return [new docx.TextRun({ children: [docx.PageNumber.CURRENT] })];
    }
    if (run.type === 'footnoteRef') {
        const id = String(run.id);
        if (id.startsWith('e')) {
            const num = parseInt(id.slice(1), 10);
            return isFinite(num) ? [new docx.EndnoteReferenceRun(num)] : [];
        }
        const num = parseInt(id, 10);
        return isFinite(num) ? [new docx.FootnoteReferenceRun(num)] : [];
    }
    if (run.type === 'commentRangeStart') {
        const id = ctx.commentDocxIds.get(String(run.id));
        return id != null ? [new docx.CommentRangeStart(id)] : [];
    }
    if (run.type === 'commentRangeEnd') {
        const id = ctx.commentDocxIds.get(String(run.id));
        return id != null ? [new docx.CommentRangeEnd(id)] : [];
    }
    if (run.type === 'insRun' || run.type === 'delRun') {
        const isIns = run.type === 'insRun';
        const makeRun = opts => isIns
            ? new docx.InsertedTextRun({ id: ctx.revId++, author: run.author || '', date: run.date || '', ...opts })
            : new docx.DeletedTextRun({ id: ctx.revId++, author: run.author || '', date: run.date || '', ...opts });
        return wrapHyperlink(run, runToTextRuns(run, docx, ctx, makeRun), docx, ctx);
    }
    if (run.text === undefined) return [];
    return wrapHyperlink(run, runToTextRuns(run, docx, ctx), docx, ctx);
}

/**
 * Wraps text runs in an internal/external hyperlink when the run carries one.
 * Dangling internal anchors degrade to plain text.
 * @param {object} run
 * @param {object[]} textRuns
 * @param {object} docx
 * @param {object} ctx
 * @returns {object[]}
 */
function wrapHyperlink(run, textRuns, docx, ctx) {
    if (isInternalHref(run.href)) {
        if (!ctx.bookmarkChildren) return textRuns;
        return [new docx.InternalHyperlink({ anchor: run.href.slice(1), children: textRuns })];
    }
    if (run.href) {
        return [new docx.ExternalHyperlink({ link: run.href, children: textRuns })];
    }
    return textRuns;
}

function blockToParagraph(block, docx, ctx) {
    const opts = { children: [] };
    if (block.align) opts.alignment = mapAlignment(block.align, docx);
    if (block.type === 'heading' && block.level) {
        opts.heading = docx.HeadingLevel['HEADING_' + Math.min(6, Math.max(1, Number(block.level)))];
    }
    if (ctx.numbering) opts.numbering = ctx.numbering;
    for (const run of (block.runs || [])) {
        opts.children.push(...runToChildren(run, docx, ctx));
    }
    opts.children = wrapWithBookmarks(opts.children, ctx, docx);
    return new docx.Paragraph(opts);
}

function linkBlockToParagraph(block, docx, ctx) {
    const children = [];
    for (const run of (block.runs || [])) {
        children.push(...runToChildren(run, docx, ctx));
    }
    let wrapped = wrapWithBookmarks(children, ctx, docx);
    if (block.href) {
        if (isInternalHref(block.href)) {
            if (ctx.bookmarkChildren) {
                wrapped = [new docx.InternalHyperlink({ anchor: block.href.slice(1), children: wrapped })];
            }
            // else: dangling anchor → plain text (children are already plain)
        } else {
            wrapped = [new docx.ExternalHyperlink({ link: block.href, children: wrapped })];
        }
    }
    return new docx.Paragraph({
        ...(block.align ? { alignment: mapAlignment(block.align, docx) } : {}),
        children: wrapped
    });
}

function imageBlockToParagraph(block, docx, ctx) {
    const img = imageRunFromDataUrl(block.src, block.width, block.height, docx);
    const children = img ? wrapWithBookmarks([img], ctx, docx) : [];
    return new docx.Paragraph({ children });
}

function horizontalRuleToParagraph(docx) {
    return new docx.Paragraph({
        border: {
            bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: '000000', space: 1 }
        },
        children: []
    });
}

function pageBreakToParagraph(docx) {
    return new docx.Paragraph({ children: [new docx.PageBreak()] });
}

// ─── Tables ──────────────────────────────────────────────────────────────────
// OOXML table borders (the `style` stored on the model is the OOXML `w:val`,
// e.g. 'single'/'dashed') are mapped onto docx.BorderStyle keys.

const BORDER_STYLE_TO_DOCX = {
    single: 'SINGLE', solid: 'SINGLE', thick: 'THICK', double: 'DOUBLE',
    dotted: 'DOTTED', dashed: 'DASHED', dotDash: 'DOT_DASH', dotDotDash: 'DOT_DOT_DASH',
    dashSmallGap: 'DASH_SMALL_GAP', dashDotStroked: 'DASH_DOT_STROKED',
    thinThickSmallGap: 'THIN_THICK_SMALL_GAP', thickThinSmallGap: 'THICK_THIN_SMALL_GAP',
    thinThickThinSmallGap: 'THIN_THICK_THIN_SMALL_GAP',
    thinThickMediumGap: 'THIN_THICK_MEDIUM_GAP', thickThinMediumGap: 'THICK_THIN_MEDIUM_GAP',
    thinThickThinMediumGap: 'THIN_THICK_THIN_MEDIUM_GAP',
    thinThickLargeGap: 'THIN_THICK_LARGE_GAP', thickThinLargeGap: 'THICK_THIN_LARGE_GAP',
    thinThickThinLargeGap: 'THIN_THICK_THIN_LARGE_GAP',
    wave: 'DOUBLE_WAVE', doubleWave: 'DOUBLE_WAVE',
    none: 'NONE', nil: 'NONE', inset: 'INSET', outset: 'OUTSET',
    threeDEmboss: 'THREE_D_EMBOSS', threeDEngrave: 'THREE_D_ENGRAVE'
};

function borderStyleToDocx(style, docx) {
    const key = BORDER_STYLE_TO_DOCX[String(style || '').toLowerCase()] || 'SINGLE';
    return docx.BorderStyle[key] || docx.BorderStyle.SINGLE;
}

function tableCellToDocx(cell, docx) {
    const isObject = cell && typeof cell === 'object';
    const text = isObject ? (cell.text ?? '') : (cell == null ? '' : String(cell));
    const opts = {
        children: [new docx.Paragraph({ children: [new docx.TextRun({ text })] })]
    };
    if (isObject) {
        if (cell.shading) {
            const fill = toHexColor(cell.shading);
            if (fill) opts.shading = { type: docx.ShadingType.CLEAR, fill };
        }
        if (Number.isInteger(cell.gridSpan) && cell.gridSpan > 1) opts.columnSpan = cell.gridSpan;
        if (cell.vMerge === 'restart' || cell.vMerge === 'continue') opts.verticalMerge = cell.vMerge;
        if (cell.width) {
            const pt = parseFloat(cell.width);
            if (isFinite(pt) && pt > 0) opts.width = { size: Math.round(pt * 1440 / 25.4), type: docx.WidthType.DXA };
        }
    }
    return new docx.TableCell(opts);
}

function tableWidthToDocx(width, docx) {
    if (typeof width !== 'string') return null;
    if (width.endsWith('%')) {
        const pct = parseFloat(width);
        if (isFinite(pct) && pct > 0) return { size: pct, type: docx.WidthType.PERCENTAGE };
        return null;
    }
    const m = width.match(/^([\d.]+)\s*pt$/i);
    if (m) {
        const pt = parseFloat(m[1]);
        if (isFinite(pt) && pt > 0) return { size: Math.round(pt * 1440 / 25.4), type: docx.WidthType.DXA };
        return null;
    }
    return null;
}

function tableBlockToTable(block, docx) {
    const rows = [];
    for (const rowData of (block.rows || [])) {
        const cells = [];
        for (const cell of rowData) cells.push(tableCellToDocx(cell, docx));
        rows.push(new docx.TableRow({ children: cells }));
    }

    const opts = { rows };
    if (block.width) {
        const parsed = tableWidthToDocx(block.width, docx);
        if (parsed) opts.width = parsed;
    }
    if (block.alignment) {
        const align = mapAlignment(block.alignment, docx);
        if (align) opts.alignment = align;
    }
    if (block.borders && typeof block.borders === 'object') {
        const borders = {};
        for (const [key, b] of Object.entries(block.borders)) {
            if (!b || typeof b !== 'object') continue;
            const side = key === 'insideH' ? 'insideHorizontal' : key === 'insideV' ? 'insideVertical' : key;
            const border = { style: borderStyleToDocx(b.style, docx) };
            if (b.size !== undefined && b.size !== null) border.size = Number(b.size);
            if (b.color) {
                const color = toHexColor(String(b.color).replace(/^#/, '#'));
                if (color) border.color = color;
            }
            borders[side] = border;
        }
        if (Object.keys(borders).length) opts.borders = borders;
    }
    return new docx.Table(opts);
}

function blockToChildren(block, docx, ctx) {
    switch (block.type) {
        case 'paragraph':
            return [blockToParagraph(block, docx, ctx)];
        case 'heading':
            return [blockToParagraph(block, docx, ctx)];
        case 'horizontalRule':
            return [horizontalRuleToParagraph(docx)];
        case 'pageBreak':
            return [pageBreakToParagraph(docx)];
        case 'listItem': {
            const key = ctx.listNumbering.get(block);
            return [blockToParagraph(block, docx, {
                ...ctx,
                numbering: key ? { reference: key, level: Number(block.level) || 0 } : null
            })];
        }
        case 'link':
            return [linkBlockToParagraph(block, docx, ctx)];
        case 'image':
            return [imageBlockToParagraph(block, docx, ctx)];
        case 'table':
            return [tableBlockToTable(block, docx)];
        case 'section':
            return []; // metadata-only block
        default:
            return [];
    }
}

// ─── Notes & comments (footnotes, endnotes, comments) ─────────────────────────

/**
 * Builds the docx `footnotes`/`endnotes`/`comments` registration from the
 * model's annotation sections. Numeric footnote ids map back to their original
 * `w:id` (so references round-trip); `e`-prefixed ids are endnotes.
 * @param {object} model
 * @param {object} docx
 * @param {object} ctx
 * @returns {object}
 */
function buildNotes(model, docx, ctx) {
    const out = {};
    const footnotes = {};
    const endnotes = {};
    for (const fn of model.footnotes || []) {
        const id = String(fn.id);
        const isEndnote = id.startsWith('e');
        const num = parseInt(isEndnote ? id.slice(1) : id, 10);
        if (!isFinite(num) || num <= 0) continue;
        const noteCtx = { ...ctx, bookmarkChildren: null };
        const children = [];
        for (const block of (fn.blocks || [])) children.push(...blockToChildren(block, docx, noteCtx));
        if (children.length === 0) continue;
        if (isEndnote) endnotes[num] = { children };
        else footnotes[num] = { children };
    }
    if (Object.keys(footnotes).length) out.footnotes = footnotes;
    if (Object.keys(endnotes).length) out.endnotes = endnotes;

    const commentChildren = [];
    for (const comment of model.comments || []) {
        const id = ctx.commentDocxIds.get(String(comment.id));
        if (id == null) continue;
        let dateObj = null;
        try {
            dateObj = new Date(comment.date);
        } catch (err) {
            dateObj = null;
        }
        if (!dateObj || isNaN(dateObj.getTime())) dateObj = new Date(FIXED_CORE_TIMESTAMP);
        commentChildren.push({
            id,
            author: comment.author || '',
            date: dateObj,
            children: [new docx.Paragraph({ children: [new docx.TextRun({ text: comment.text || '' })] })]
        });
    }
    if (commentChildren.length) out.comments = { children: commentChildren };
    return out;
}

// ─── Document assembly (pure) ────────────────────────────────────────────────

function mmString(mm) {
    return `${Math.round(mm * 1000) / 1000}mm`;
}

/**
 * Resolves the docx page size for a section. Exact imported dimensions
 * (widthMM/heightMM on the section block) win; otherwise the preset table.
 * @param {object|null} sec section model block or null
 * @param {object} model
 * @returns {{width:string, height:string}}
 */
function sectionPageSize(sec, model) {
    if (sec && Number.isFinite(Number(sec.widthMM)) && Number.isFinite(Number(sec.heightMM))) {
        return { width: mmString(Number(sec.widthMM)), height: mmString(Number(sec.heightMM)) };
    }
    const fmt = (sec && sec.pageFormat) || model.pageFormat;
    return pageSizeForFormat(fmt);
}

/**
 * Builds the docx `properties` object for a section model block.
 * @param {object|null} sec
 * @param {object} model
 * @param {object} docx
 * @returns {object}
 */
function sectionPropertiesFor(sec, model, docx) {
    const { width, height } = sectionPageSize(sec, model);
    const margins = (sec && sec.margins) || {};
    const page = {
        size: { width, height },
        margin: {
            top: mmString(margins.top != null ? margins.top : 25.4),
            right: mmString(margins.right != null ? margins.right : 25.4),
            bottom: mmString(margins.bottom != null ? margins.bottom : 25.4),
            left: mmString(margins.left != null ? margins.left : 25.4)
        }
    };
    if (sec && sec.orientation === 'landscape') {
        page.size.orientation = docx.PageOrientation.LANDSCAPE;
    } else if (sec && sec.orientation === 'portrait') {
        page.size.orientation = docx.PageOrientation.PORTRAIT;
    }
    if (sec && sec.headerDistance != null) page.margin.header = mmString(Number(sec.headerDistance));
    if (sec && sec.footerDistance != null) page.margin.footer = mmString(Number(sec.footerDistance));
    return { page };
}

/**
 * Maps a section's header/footer blocks into docx Header/Footer wrappers.
 * @param {object|null} sec
 * @param {object} docx
 * @param {object} ctx
 * @returns {{headers?:object, footers?:object}}
 */
function sectionChromeFor(sec, docx, ctx) {
    if (!sec) return {};
    const out = {};
    const headerCtx = { ...ctx, bookmarkChildren: null };
    if (Array.isArray(sec.header) && sec.header.length) {
        const children = [];
        for (const block of sec.header) children.push(...blockToChildren(block, docx, headerCtx));
        out.headers = { default: new docx.Header({ children }) };
    }
    if (Array.isArray(sec.footer) && sec.footer.length) {
        const children = [];
        for (const block of sec.footer) children.push(...blockToChildren(block, docx, headerCtx));
        out.footers = { default: new docx.Footer({ children }) };
    }
    return out;
}

/**
 * Builds a `docx.Document` from a canonical model. Section blocks split the
 * body into multiple sections (the block that follows a run of content
 * carries that section's properties, mirroring how OOXML writes sectPr).
 * Pure with respect to the given model (no `state`, no DOM reads) so it is
 * unit-testable in isolation and shared by the browser download path and the
 * golden round-trip harness.
 * @param {object} model canonical model (from normalizeModel)
 * @param {object} docx the docx library namespace
 * @returns {object} docx.Document
 */
export function buildDocxDocument(model, docx) {
    const numberingConfig = buildNumberingConfig(model.blocks, docx);
    const anchors = collectInternalAnchors(model.blocks);

    // Stable numeric id space for comment ranges (references in the body share
    // this map). Numeric string ids pass through so ranges round-trip.
    const commentDocxIds = new Map();
    let nextCommentId = 1;
    for (const comment of model.comments || []) {
        const num = parseInt(String(comment.id), 10);
        commentDocxIds.set(String(comment.id), isFinite(num) && num > 0 ? num : nextCommentId++);
    }

    const ctx = {
        numbering: null,
        revId: 1,
        commentDocxIds,
        listNumbering: buildListNumberingMap(model.blocks),
        bookmarkChildren: anchors.size > 0
            ? Array.from(anchors.entries()).flatMap(([name, id]) => [
                new docx.BookmarkStart(name, id),
                new docx.BookmarkEnd(id)
            ])
            : null,
        bookmarksPlaced: false
    };

    const sections = [];
    let children = [];
    let lastSectionBlock = null;

    const flush = () => {
        if (children.length > 0 || sections.length === 0) {
            sections.push({
                properties: sectionPropertiesFor(lastSectionBlock, model, docx),
                ...sectionChromeFor(lastSectionBlock, docx, ctx),
                children
            });
            children = [];
        }
        lastSectionBlock = null;
    };

    for (const block of model.blocks) {
        if (block && block.type === 'section') {
            if (children.length === 0 && sections.length > 0) {
                // Consecutive section blocks (no content between): the newer
                // block's properties replace the just-emitted section's.
                lastSectionBlock = block;
                continue;
            }
            lastSectionBlock = block;
            flush();
        } else {
            children.push(...blockToChildren(block, docx, ctx));
        }
    }
    if (children.length > 0) flush();
    if (sections.length === 0) {
        sections.push({
            properties: sectionPropertiesFor(null, model, docx),
            children: children.length ? children : []
        });
    }

    return new docx.Document({
        title: model.title || '',
        ...(numberingConfig.length ? { numbering: { config: numberingConfig } } : {}),
        ...buildNotes(model, docx, ctx),
        styles: {
            default: {
                document: {
                    run: { font: mapFontToWord(model.fontFamily) }
                }
            }
        },
        sections
    });
}

// ─── Deterministic serialization ─────────────────────────────────────────────
// docx embeds the pack time in docProps/core.xml; the repair invariant demands
// that re-exporting an unchanged document yields byte-identical output, so the
// timestamps are pinned to a fixed value and the package is re-zipped. fflate's
// zipSync is stable: repeated runs produce identical bytes.

const FIXED_CORE_TIMESTAMP = '2020-01-01T00:00:00.000Z';

/**
 * Rewrites every relationship id in the package to a deterministic `rId1..N`
 * sequence. docx generates a random suffix for hyperlink relationships, which
 * would otherwise make two exports of the same model differ. The full token
 * space (references in every part + Id attributes in every rels part) is
 * remapped in a stable order, so the r:id↔Id correspondence is preserved and
 * re-import (which never stores raw rIds) is unaffected.
 * @param {Record<string, Uint8Array>} parts
 * @param {function(Uint8Array):string} strFromU8
 * @param {function(string):Uint8Array} strToU8
 */
function remapRelationshipIds(parts, strFromU8, strToU8) {
    const refPattern = /\br:(?:id|embed)="(rId[^"]*)"/g;
    const relsPattern = /\bId="(rId[^"]*)"/g;
    const xmlNames = Object.keys(parts).filter(n => n.endsWith('.xml')).sort();
    const relsNames = Object.keys(parts).filter(n => n.endsWith('.rels')).sort();

    const mapping = new Map();
    const claim = token => {
        if (!mapping.has(token)) mapping.set(token, `rId${mapping.size + 1}`);
    };
    for (const name of xmlNames) {
        const xml = strFromU8(parts[name]);
        refPattern.lastIndex = 0;
        let m;
        while ((m = refPattern.exec(xml)) !== null) claim(m[1]);
    }
    for (const name of relsNames) {
        const rels = strFromU8(parts[name]);
        relsPattern.lastIndex = 0;
        let m;
        while ((m = relsPattern.exec(rels)) !== null) claim(m[1]);
    }
    if (mapping.size === 0) return;

    const rewrite = pattern => xml => xml.replace(pattern, (full, token) => {
        const canon = mapping.get(token);
        return canon ? full.replace(token, canon) : full;
    });
    const rewriteRefs = rewrite(refPattern);
    const rewriteRels = rewrite(relsPattern);
    for (const name of xmlNames) parts[name] = strToU8(rewriteRefs(strFromU8(parts[name])));
    for (const name of relsNames) parts[name] = strToU8(rewriteRels(strFromU8(parts[name])));
}

/**
 * Rezips a .docx byte array with pinned core.xml timestamps and deterministic
 * relationship ids, producing byte-identical output (the repair invariant:
 * unchanged in → identical out).
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function deterministicZip(bytes) {
    const { zipSync, unzipSync, strFromU8, strToU8 } = await loadFflate();
    const parts = unzipSync(bytes);
    const core = parts['docProps/core.xml'];
    if (core) {
        const coreXml = strFromU8(core);
        parts['docProps/core.xml'] = strToU8(
            coreXml
                .replace(/(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/, `$1${FIXED_CORE_TIMESTAMP}$2`)
                .replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${FIXED_CORE_TIMESTAMP}$2`)
        );
    }
    remapRelationshipIds(parts, strFromU8, strToU8);
    return zipSync(parts, { mtime: FIXED_CORE_TIMESTAMP });
}

/**
 * Serializes a canonical model to deterministic .docx bytes.
 * @param {object} model
 * @returns {Promise<Uint8Array>}
 */
export async function modelToDocxBuffer(model) {
    const docx = await ensureDocxLib();
    const document = buildDocxDocument(model, docx);
    const bytes = await docx.Packer.toBuffer(document);
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return deterministicZip(raw);
}

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Serializes the current pages workspace to a deterministic `.docx` file and
 * downloads it.
 * @returns {Promise<string>} the downloaded file name
 */
export async function exportDocx() {
    const titleInput = document.querySelector('header input[type="text"]');
    const title = (titleInput && titleInput.value.trim())
        ? titleInput.value.trim()
        : 'Untitled document';

    const model = normalizeModel({
        title,
        blocks: pagesToModel(getPages()),
        pageFormat: state.currentDoc.pageFormat || 'a4',
        fontFamily: state.currentDoc.fontFamily || DEFAULT_FONT_FAMILY,
        updatedAt: Date.now()
    });

    const bytes = await modelToDocxBuffer(model);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const docName = title.replace(/[^a-zA-Z0-9_\- ]/g, '') || 'ScribenDocument';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${docName}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return `${docName}.docx`;
}

/**
 * Wires the File → "Export as Word" menu item to exportDocx().
 * Mirrors the disabled/icon spinner pattern of initPdfExport().
 * Call once after the DOM is ready.
 */
export function initDocxExport() {
    const menuItem = document.getElementById('menu-export-docx');
    if (!menuItem) return;

    menuItem.addEventListener('click', async (e) => {
        e.preventDefault();
        const fileDropdown = document.getElementById('file-dropdown');
        if (fileDropdown) fileDropdown.style.display = 'none';

        menuItem.disabled = true;
        const icon = menuItem.querySelector('.material-symbols-outlined');
        const origIcon = icon ? icon.textContent : '';
        if (icon) icon.textContent = 'hourglass_empty';

        try {
            const fileName = await exportDocx();
            showToast(`Exported "${fileName}"`);
        } catch (err) {
            console.error('DOCX export failed:', err);
            alert('DOCX export failed. Check the console for details.');
        } finally {
            menuItem.disabled = false;
            if (icon) icon.textContent = origIcon;
        }
    });
}
