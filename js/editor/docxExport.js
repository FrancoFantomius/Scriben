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
 * Handles #rgb/#rrggbb, rgb()/rgba() and named colors (via a probe element).
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

// ─── Block → OOXML ───────────────────────────────────────────────────────────

function blockToParagraph(block, docx) {
    const opts = { children: [] };
    if (block.align) opts.alignment = mapAlignment(block.align, docx);
    if (block.type === 'heading' && block.level) {
        opts.heading = docx.HeadingLevel['HEADING_' + Math.min(6, Math.max(1, Number(block.level)))];
    }
    for (const run of (block.runs || [])) {
        opts.children.push(...runToTextRuns(run, docx));
    }
    return new docx.Paragraph(opts);
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

function blockToChildren(block, docx) {
    switch (block.type) {
        case 'paragraph':
            return [blockToParagraph(block, docx)];
        case 'heading':
            return [blockToParagraph(block, docx)];
        case 'horizontalRule':
            return [horizontalRuleToParagraph(docx)];
        case 'pageBreak':
            return [pageBreakToParagraph(docx)];
        case 'listItem':
            // Lists keep their text in M2; bullet/numbering wiring is M5.
            return [blockToParagraph(block, docx)];
        case 'link':
            // Block links render as their runs' text; hrefs are M5.
            return [blockToParagraph(block, docx)];
        case 'table':
            return [tableBlockToTable(block, docx)];
        case 'image':
        case 'section':
            // Inline images and section metadata are out of M2 scope.
            return [];
        default:
            return [];
    }
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

    const children = [];
    for (const block of model.blocks) {
        children.push(...blockToChildren(block, docx));
    }

    const wordDocument = new docx.Document({
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