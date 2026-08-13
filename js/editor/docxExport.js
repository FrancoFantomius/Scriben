import { state, getPages } from './state.js';
import { pagesToModel } from './html.js';
import { normalizeModel, DEFAULT_FONT_FAMILY } from './model.js';

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

const PAGE_MARGIN = '25.4mm';

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
 * Builds the TextRun options object for a single model run.
 * @param {object} run
 * @param {string} text
 * @param {object} docx
 * @returns {object}
 */
function runOptions(run, text, docx) {
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
    return opts;
}

/**
 * Emits one or more TextRuns for a model run, splitting on '\n' (hard breaks)
 * into separate runs so each line keeps its formatting.
 * @param {object} run
 * @param {object} docx
 * @returns {object[]}
 */
function runToTextRuns(run, docx) {
    if (!run || run.image || run.text === undefined) return [];
    const lines = String(run.text).split('\n');
    const runs = [];
    lines.forEach((line, i) => {
        const opts = runOptions(run, line, docx);
        if (i > 0) opts.break = 1;
        runs.push(new docx.TextRun(opts));
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
        const info = byKey.get(key) || { maxLevel: 0 };
        if (level > info.maxLevel) info.maxLevel = level;
        byKey.set(key, info);
    }

    const config = [];
    for (const [key, info] of byKey) {
        const ordered = key !== 'unordered';
        const start = ordered ? (key === 'ordered' ? 1 : parseInt(key.slice('ordered-'.length), 10) || 1) : 1;
        const levels = [];
        for (let lvl = 0; lvl <= info.maxLevel; lvl++) {
            if (ordered) {
                levels.push({
                    level: lvl,
                    format: docx.LevelFormat.DECIMAL,
                    text: `%${lvl + 1}.`,
                    start: lvl === 0 ? start : 1
                });
            } else {
                levels.push({
                    level: lvl,
                    format: docx.LevelFormat.BULLET,
                    text: BULLET_SYMBOLS[lvl % BULLET_SYMBOLS.length]
                });
            }
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
 * hyperlink wrapping) or an inline image.
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
    if (run.text === undefined) return [];
    const textRuns = runToTextRuns(run, docx);
    if (isInternalHref(run.href)) {
        if (!ctx.bookmarkChildren) return textRuns; // dangling anchor → plain text
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

function tableBlockToTable(block, docx) {
    const rows = [];
    const cols = Number(block.cols) || 0;
    for (const rowData of (block.rows || [])) {
        const cells = [];
        for (let c = 0; c < cols; c++) {
            const text = rowData[c] == null ? '' : String(rowData[c]);
            cells.push(new docx.TableCell({
                children: [new docx.Paragraph({ children: [new docx.TextRun({ text })] })]
            }));
        }
        rows.push(new docx.TableRow({ children: cells }));
    }
    return new docx.Table({
        width: { size: 100, type: docx.WidthType.PERCENTAGE },
        rows
    });
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

// ─── Document assembly (pure) ────────────────────────────────────────────────

/**
 * Builds a `docx.Document` from a canonical model. Pure with respect to the
 * given model (no `state`, no DOM reads) so it is unit-testable in isolation
 * and shared by the browser download path and the golden round-trip harness.
 * @param {object} model canonical model (from normalizeModel)
 * @param {object} docx the docx library namespace
 * @returns {object} docx.Document
 */
export function buildDocxDocument(model, docx) {
    const { width, height } = pageSizeForFormat(model.pageFormat);
    const sectionProperties = {
        page: {
            size: { width, height },
            margin: {
                top: PAGE_MARGIN,
                right: PAGE_MARGIN,
                bottom: PAGE_MARGIN,
                left: PAGE_MARGIN
            }
        }
    };

    const numberingConfig = buildNumberingConfig(model.blocks, docx);
    const anchors = collectInternalAnchors(model.blocks);

    const ctx = {
        numbering: null,
        listNumbering: buildListNumberingMap(model.blocks),
        bookmarkChildren: anchors.size > 0
            ? Array.from(anchors.entries()).flatMap(([name, id]) => [
                new docx.BookmarkStart(name, id),
                new docx.BookmarkEnd(id)
            ])
            : null,
        bookmarksPlaced: false
    };

    const children = [];
    for (const block of model.blocks) {
        children.push(...blockToChildren(block, docx, ctx));
    }

    return new docx.Document({
        ...(numberingConfig.length ? { numbering: { config: numberingConfig } } : {}),
        styles: {
            default: {
                document: {
                    run: { font: mapFontToWord(model.fontFamily) }
                }
            }
        },
        sections: [
            {
                properties: sectionProperties,
                children
            }
        ]
    });
}

/**
 * Serializes a canonical model to .docx bytes (used by the golden round-trip
 * tests; deterministic apart from docx's internal hyperlink relationship ids,
 * which do not affect the re-imported model).
 * @param {object} model
 * @returns {Promise<Uint8Array>}
 */
export async function modelToDocxBuffer(model) {
    const docx = await ensureDocxLib();
    const document = buildDocxDocument(model, docx);
    return await docx.Packer.toBuffer(document);
}

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Serializes the current pages workspace to a `.docx` file and downloads it.
 */
export async function exportDocx() {
    const docx = await ensureDocxLib();

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

    const wordDocument = buildDocxDocument(model, docx);
    const blob = await docx.Packer.toBlob(wordDocument);
    const docName = title.replace(/[^a-zA-Z0-9_\- ]/g, '') || 'ScribenDocument';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${docName}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
            await exportDocx();
        } catch (err) {
            console.error('DOCX export failed:', err);
            alert('DOCX export failed. Check the console for details.');
        } finally {
            menuItem.disabled = false;
            if (icon) icon.textContent = origIcon;
        }
    });
}
