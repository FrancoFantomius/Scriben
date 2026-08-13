/**
 * html.js — DOM <-> canonical model serializers.
 *
 * pagesToModel(pageEls)     : Element[] -> Block[]
 * modelToPages(model, createPageFn) : Model -> Element[]
 *
 * Both directions are pure with respect to the given DOM elements and are
 * designed to round-trip: pagesToModel(modelToPages(x)) is a stable identity
 * on representative editor DOM (pagination artifacts such as `data-split`
 * are dropped, `.page-break` divs become `pageBreak` blocks).
 */

import { mergeRuns } from './model.js';

export { mergeRuns };

const BLOCK_TAG_SET = new Set([
    'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'LI', 'TABLE', 'HR', 'BLOCKQUOTE',
    'SECTION', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH'
]);

const HTML_FONT_SIZES = {
    '1': '10px', '2': '13px', '3': '16px', '4': '18px',
    '5': '24px', '6': '32px', '7': '48px'
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
}

function parseStyle(styleStr) {
    const out = {};
    const re = /([\w-]+)\s*:\s*([^;]+)/g;
    let m;
    while ((m = re.exec(styleStr))) {
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key === 'font-family') out.fontFamily = value;
        else if (key === 'font-size') out.fontSize = value;
        else if (key === 'color') out.color = value;
        else if (key === 'background-color') out.backgroundColor = value;
        else if (key === 'text-align') out.textAlign = value;
    }
    return out;
}

function sizeToCss(size) {
    if (HTML_FONT_SIZES[size]) return HTML_FONT_SIZES[size];
    const n = parseInt(size, 10);
    if (!isNaN(n) && n >= 1 && n <= 7) return HTML_FONT_SIZES[n];
    return String(size);
}

/**
 * Extracts the formatting contribution of a single inline element.
 * @param {Element} el
 * @returns {object}
 */
function formatFromElement(el) {
    const f = {};
    const tag = el.tagName;

    if (tag === 'B' || tag === 'STRONG') f.bold = true;
    else if (tag === 'I' || tag === 'EM') f.italic = true;
    else if (tag === 'U') f.underline = true;
    else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') f.strikethrough = true;
    else if (tag === 'SUB') f.subscript = true;
    else if (tag === 'SUP') f.superscript = true;
    else if (tag === 'A') {
        f.href = el.getAttribute('href') || '';
        const target = el.getAttribute('target');
        if (target) f.target = target;
    } else if (tag === 'FONT') {
        if (el.getAttribute('face')) f.fontFamily = el.getAttribute('face');
        if (el.getAttribute('size')) f.fontSize = sizeToCss(el.getAttribute('size'));
        if (el.getAttribute('color')) f.color = el.getAttribute('color');
    }

    const style = el.getAttribute && el.getAttribute('style');
    if (style) {
        const parsed = parseStyle(style);
        delete parsed.textAlign; // alignment is a block property, not a run flag
        Object.assign(f, parsed);
    }

    return f;
}

/**
 * True when an element has any block-level child.
 * @param {Element} el
 * @returns {boolean}
 */
function hasBlockChildren(el) {
    for (const child of el.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && BLOCK_TAG_SET.has(child.tagName)) {
            return true;
        }
    }
    return false;
}

// ─── DOM -> model ────────────────────────────────────────────────────────────

function mergeInherited(base, extra) {
    return Object.assign({}, base, extra);
}

/**
 * Collects inline runs from a block element's inline content. The block's own
 * inline formatting (e.g. a `style` attribute on the paragraph) is inherited
 * by every run so no formatting is lost across a round-trip.
 * @param {Element} rootEl
 * @returns {object[]}
 */
function collectRuns(rootEl) {
    const runs = [];
    collectRunsInto(rootEl, runs, formatFromElement(rootEl));
    return mergeRuns(runs);
}

function collectRunsInto(node, runs, inherited) {
    if (node.nodeType === Node.TEXT_NODE) {
        if (node.data.length > 0) runs.push({ text: node.data, ...inherited });
        return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName;
    if (tag === 'BR') {
        runs.push({ text: '\n', ...inherited });
        return;
    }
    if (tag === 'IMG') {
        const run = { image: node.getAttribute('src') || '', ...inherited };
        if (node.getAttribute('alt')) run.alt = node.getAttribute('alt');
        const dims = imageDims(node);
        if (dims.width) run.width = dims.width;
        if (dims.height) run.height = dims.height;
        runs.push(run);
        return;
    }

    // Guard against block-in-inline nesting polluting the run stream.
    if (BLOCK_TAG_SET.has(tag) && hasBlockChildren(node)) {
        return;
    }

    const fmt = mergeInherited(inherited, formatFromElement(node));
    for (const child of node.childNodes) {
        collectRunsInto(child, runs, fmt);
    }
}

/**
 * Reads the drawn display size of an image for the model. Explicit `width`/
 * `height` attributes (or inline styles) win; otherwise the browser's natural
 * rendered dimensions are used so round-tripping through OOXML keeps the
 * displayed size rather than dropping it.
 * @param {HTMLImageElement} img
 * @returns {{width?:string, height?:string}}
 */
function imageDims(img) {
    const out = {};
    const width = img.getAttribute('width') || img.style.width;
    const height = img.getAttribute('height') || img.style.height;
    if (width) out.width = width;
    if (height) out.height = height;
    if (!out.width && img.naturalWidth) out.width = `${img.naturalWidth}px`;
    if (!out.height && img.naturalHeight) out.height = `${img.naturalHeight}px`;
    return out;
}

function imageBlock(img) {
    const block = { type: 'image', src: img.getAttribute('src') || '' };
    if (img.getAttribute('alt')) block.alt = img.getAttribute('alt');
    const dims = imageDims(img);
    if (dims.width) block.width = dims.width;
    if (dims.height) block.height = dims.height;
    return block;
}

function tableBlock(table) {
    const rowEls = [];
    for (const child of table.childNodes) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.tagName === 'TR') {
            rowEls.push(child);
        } else if (['THEAD', 'TBODY', 'TFOOT'].includes(child.tagName)) {
            for (const tr of child.children) {
                if (tr.tagName === 'TR') rowEls.push(tr);
            }
        }
    }

    const rows = [];
    let cols = 0;
    for (const tr of rowEls) {
        const row = [];
        for (const cell of tr.children) {
            if (cell.tagName === 'TD' || cell.tagName === 'TH') {
                row.push(cell.textContent);
            }
        }
        rows.push(row);
        cols = Math.max(cols, row.length);
    }

    // Canonical shape: every row is padded to `cols` so the model is stable.
    for (const row of rows) {
        while (row.length < cols) row.push('');
    }

    return { type: 'table', cols, rows };
}

function sectionBlock(el) {
    const block = { type: 'section' };
    const orientation = el.getAttribute && el.getAttribute('data-orientation');
    const pageFormat = el.getAttribute && el.getAttribute('data-page-format');
    if (orientation) block.orientation = orientation;
    if (pageFormat) block.pageFormat = pageFormat;
    return block;
}

/**
 * Converts a single list <li> into listItem blocks, flattening nested lists.
 * @param {Element} liEl
 * @param {number} depth
 * @param {boolean} ordered
 * @param {number|null} [start] starting number of the owning <ol> (level 0 only)
 * @returns {object[]}
 */
function liToBlocks(liEl, depth, ordered, start = null) {
    const block = {
        type: 'listItem',
        listType: ordered ? 'ordered' : 'unordered',
        level: depth,
        ...(ordered && depth === 0 && start != null ? { start } : {}),
        ...alignOf(liEl)
    };
    const runs = [];
    const nested = [];
    const liFormat = formatFromElement(liEl);

    for (const child of liEl.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            if (child.data.length > 0) runs.push({ text: child.data, ...liFormat });
            continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.tagName === 'UL' || child.tagName === 'OL') {
            nested.push(...listToBlocks(child, depth + 1));
        } else if (hasBlockChildren(child)) {
            nested.push(...flattenBlockChildren(child, depth + 1));
        } else {
            collectRunsInto(child, runs, liFormat);
        }
    }

    block.runs = mergeRuns(runs);
    return [block, ...nested];
}

function listToBlocks(listEl, depth) {
    const ordered = listEl.tagName === 'OL';
    const startAttr = listEl.getAttribute('start');
    let start = null;
    if (ordered && depth === 0 && startAttr != null && startAttr !== '') {
        const parsed = parseInt(startAttr, 10);
        if (Number.isFinite(parsed) && parsed >= 0) start = parsed;
    }
    const out = [];
    for (const child of listEl.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI') {
            out.push(...liToBlocks(child, depth, ordered, start));
        }
    }
    return out;
}

/**
 * Flattens a container element into a list of block objects.
 * @param {Element} el
 * @param {number} [depth]
 * @returns {object[]}
 */
function flattenBlockChildren(el, depth = 0) {
    const out = [];
    for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            if (child.data.trim()) {
                out.push({ type: 'paragraph', runs: [{ text: child.data }] });
            }
            continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const blocks = elementToBlocks(child, depth);
        if (blocks) out.push(...blocks);
    }
    if (out.length === 0) return [{ type: 'paragraph', runs: [] }];
    return out;
}

/**
 * Maps a single block-level element to one or more block objects.
 * @param {Element} el
 * @param {number} [depth]
 * @returns {object[]|null}
 */
function elementToBlocks(el, depth = 0) {
    if (el.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = el.tagName;

    if (el.classList && el.classList.contains('page-break')) {
        return [{ type: 'pageBreak' }];
    }
    if (tag === 'HR') return [{ type: 'horizontalRule' }];
    if (tag === 'IMG') return [imageBlock(el)];
    if (/^H[1-6]$/.test(tag)) {
        return [{ type: 'heading', level: Number(tag[1]), runs: collectRuns(el), ...alignOf(el) }];
    }
    if (tag === 'P' || tag === 'BLOCKQUOTE') {
        if (hasBlockChildren(el)) return flattenBlockChildren(el, depth);
        return [{ type: 'paragraph', runs: collectRuns(el), ...alignOf(el) }];
    }
    if (tag === 'DIV') {
        if (hasBlockChildren(el)) return flattenBlockChildren(el, depth);
        return [{ type: 'paragraph', runs: collectRuns(el), ...alignOf(el) }];
    }
    if (tag === 'UL' || tag === 'OL') {
        return listToBlocks(el, depth);
    }
    if (tag === 'LI') {
        const ordered = liHasOrderedAncestor(el);
        return liToBlocks(el, depth, ordered);
    }
    if (tag === 'TABLE') {
        return [tableBlock(el)];
    }
    if (tag === 'A') {
        const block = { type: 'link', href: el.getAttribute('href') || '', runs: stripLinkFromRuns(collectRuns(el)), ...alignOf(el) };
        const target = el.getAttribute('target');
        if (target) block.target = target;
        return [block];
    }
    if (tag === 'SECTION' || (el.classList && el.classList.contains('section'))) {
        return [sectionBlock(el)];
    }
    return flattenBlockChildren(el, depth);
}

/**
 * Reads the block-level text alignment from an element.
 * @param {Element} el
 * @returns {object}
 */
function alignOf(el) {
    const style = el.getAttribute && el.getAttribute('style');
    if (style) {
        const parsed = parseStyle(style);
        if (parsed.textAlign) return { align: parsed.textAlign };
    }
    const attr = el.getAttribute && el.getAttribute('align');
    if (attr) return { align: attr };
    return {};
}

function liHasOrderedAncestor(liEl) {
    let node = liEl.parentNode;
    while (node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'OL') return true;
            if (node.tagName === 'UL') return false;
            if (node.tagName === 'LI') { /* keep walking past nested li */ }
        }
        node = node.parentNode;
    }
    return false;
}

/**
 * Removes link formatting from runs. Used when a link is represented at the
 * block level (type `link`) so its runs do not also carry `href`.
 * @param {object[]} runs
 * @returns {object[]}
 */
function stripLinkFromRuns(runs) {
    return runs.map(run => {
        if (run.href === undefined && run.target === undefined) return run;
        const copy = { ...run };
        delete copy.href;
        delete copy.target;
        return copy;
    });
}

/**
 * Serializes page elements into an array of canonical blocks.
 * Pagination artifacts are stripped: `data-split` attributes are ignored,
 * `.page-break` divs map to `pageBreak` blocks, `.unbreakable` wrappers are
 * flattened (they carry no content semantics for the model).
 * @param {Element[]} pageEls
 * @returns {object[]}
 */
export function pagesToModel(pageEls) {
    const blocks = [];
    for (const page of pageEls) {
        for (const child of page.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                if (child.data.trim()) {
                    blocks.push({ type: 'paragraph', runs: [{ text: child.data }] });
                }
                continue;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) continue;
            const mapped = elementToBlocks(child);
            if (mapped) blocks.push(...mapped);
        }
    }
    return blocks;
}

/**
 * Converts an HTML string into canonical model blocks. Used by the opt-in
 * mammoth fallback path (docxImport.FALLBACK_TO_MAMMOTH).
 * @param {string} html
 * @returns {object[]}
 */
export function domToBlocks(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    return pagesToModel([wrap]);
}

// ─── Model -> DOM ────────────────────────────────────────────────────────────

function styleFromRun(run) {
    const parts = [];
    if (run.fontFamily) parts.push(`font-family: ${run.fontFamily}`);
    if (run.fontSize) parts.push(`font-size: ${run.fontSize}`);
    if (run.color) parts.push(`color: ${run.color}`);
    if (run.backgroundColor) parts.push(`background-color: ${run.backgroundColor}`);
    return parts.join('; ');
}

function runsToHtml(runs) {
    let html = '';
    for (const run of runs || []) {
        if (run.image) {
            html += imageRunToHtml(run);
            continue;
        }
        const text = run.text ?? '';
        const parts = text.split('\n');
        let inner = '';
        for (let i = 0; i < parts.length; i++) {
            if (i > 0) inner += '<br>';
            inner += escapeHtml(parts[i]);
        }

        let wrapped = inner;
        if (run.bold) wrapped = `<b>${wrapped}</b>`;
        if (run.italic) wrapped = `<i>${wrapped}</i>`;
        if (run.underline) wrapped = `<u>${wrapped}</u>`;
        if (run.strikethrough) wrapped = `<s>${wrapped}</s>`;
        if (run.superscript) wrapped = `<sup>${wrapped}</sup>`;
        if (run.subscript) wrapped = `<sub>${wrapped}</sub>`;

        if (run.href) {
            let attrs = `href="${escapeAttr(run.href)}"`;
            if (run.target) attrs += ` target="${escapeAttr(run.target)}"`;
            wrapped = `<a ${attrs}>${wrapped}</a>`;
        }

        const style = styleFromRun(run);
        if (style) wrapped = `<span style="${escapeAttr(style)}">${wrapped}</span>`;

        html += wrapped;
    }
    return html;
}

function imageRunToHtml(run) {
    let attrs = `src="${escapeAttr(run.image)}"`;
    if (run.alt) attrs += ` alt="${escapeAttr(run.alt)}"`;
    if (run.width) attrs += ` width="${escapeAttr(run.width)}"`;
    if (run.height) attrs += ` height="${escapeAttr(run.height)}"`;
    return `<img ${attrs}>`;
}

function applyAlign(el, block) {
    if (block.align) el.style.textAlign = block.align;
    return el;
}

function makeParagraph(block) {
    // Emit a <div> to match the browser's native contenteditable output
    // (Chrome/Safari default paragraph separator), keeping rendered output
    // byte-identical to what the legacy editor produced.
    const p = document.createElement('div');
    p.innerHTML = runsToHtml(block.runs);
    return applyAlign(p, block);
}

function makeHeading(block) {
    const level = Math.min(6, Math.max(1, Number(block.level) || 1));
    const h = document.createElement(`h${level}`);
    h.innerHTML = runsToHtml(block.runs);
    return applyAlign(h, block);
}

function makeImage(block) {
    const img = document.createElement('img');
    img.setAttribute('src', block.src || '');
    if (block.alt) img.setAttribute('alt', block.alt);
    if (block.width) img.setAttribute('width', block.width);
    if (block.height) img.setAttribute('height', block.height);
    return img;
}

function makeLink(block) {
    const a = document.createElement('a');
    a.setAttribute('href', block.href || '');
    if (block.target) a.setAttribute('target', block.target);
    a.innerHTML = runsToHtml(block.runs);
    return applyAlign(a, block);
}

function makeTable(block) {
    const table = document.createElement('table');
    const cols = Number(block.cols) || 0;
    for (const rowData of (block.rows || [])) {
        const tr = document.createElement('tr');
        for (let c = 0; c < cols; c++) {
            const td = document.createElement('td');
            td.textContent = rowData[c] == null ? '' : String(rowData[c]);
            tr.appendChild(td);
        }
        table.appendChild(tr);
    }
    return table;
}

function makePageBreak() {
    const div = document.createElement('div');
    div.className = 'page-break';
    div.setAttribute('contenteditable', 'false');
    return div;
}

function makeHorizontalRule() {
    return document.createElement('hr');
}

/**
 * Groups consecutive listItem blocks into nested <ul>/<ol> trees.
 * Level-0 ordered groups split when the `start` value changes (mirrors the
 * docx exporter's per-(type,start) numbering references).
 * @param {object[]} listItems
 * @returns {Element[]}
 */
function listItemsToDom(listItems) {
    const roots = [];
    const stack = []; // { level, type, start, el, lastLi }

    /**
     * Returns the list element open at `level`, creating the nesting path
     * (and filler `<li>` wrappers for level gaps) as needed. After the call
     * the stack top is the list at `level`.
     */
    const ensureListAtLevel = (level, type, start) => {
        while (stack.length && stack[stack.length - 1].level > level) stack.pop();
        const top = stack[stack.length - 1];
        if (top && top.level === level && top.type === type && top.start === start) return top.el;
        if (top && top.level === level) stack.pop(); // different type or start: sibling list

        let nextLevel = stack.length ? stack[stack.length - 1].level + 1 : 0;
        let list = null;
        while (nextLevel <= level) {
            if (nextLevel === 0) {
                list = document.createElement(type);
                roots.push(list);
            } else {
                const parent = stack[stack.length - 1];
                if (!parent.lastLi) {
                    const filler = document.createElement('li');
                    parent.el.appendChild(filler);
                    parent.lastLi = filler;
                }
                list = document.createElement(nextLevel === level ? type : parent.type);
                parent.lastLi.appendChild(list);
            }
            if (type === 'ol' && start != null && start > 1 && nextLevel === level) {
                list.setAttribute('start', String(start));
            }
            stack.push({
                level: nextLevel,
                type: nextLevel === level ? type : (stack.length ? stack[stack.length - 1].type : type),
                start: nextLevel === level ? start : null,
                el: list,
                lastLi: null
            });
            nextLevel++;
        }
        return list;
    };

    for (const item of listItems) {
        const type = item.listType === 'ordered' ? 'ol' : 'ul';
        const level = Number(item.level) || 0;
        const start = level === 0 && type === 'ol' ? (Number(item.start) || 1) : null;
        const list = ensureListAtLevel(level, type, start);
        const li = document.createElement('li');
        li.innerHTML = runsToHtml(item.runs);
        if (item.align) li.style.textAlign = item.align;
        list.appendChild(li);
        stack[stack.length - 1].lastLi = li;
    }

    return roots;
}

function blockToElements(block) {
    switch (block.type) {
        case 'paragraph': return [makeParagraph(block)];
        case 'heading': return [makeHeading(block)];
        case 'image': return [makeImage(block)];
        case 'link': return [makeLink(block)];
        case 'table': return [makeTable(block)];
        case 'pageBreak': return [makePageBreak()];
        case 'horizontalRule': return [makeHorizontalRule()];
        case 'section': return []; // metadata-only block
        default: return [];
    }
}

function defaultPageFactory() {
    const page = document.createElement('div');
    page.className = 'page';
    return page;
}

/**
 * Emits a model into fresh page elements. Reuses the supplied page factory
 * (typically `createPage()` from pagination.js) so pages get the editor's
 * styles, contenteditable flag and event bindings. Pages are returned in
 * document order; the factory is responsible for appending them.
 * @param {object} model
 * @param {Function} [createPageFn]
 * @returns {Element[]}
 */
export function modelToPages(model, createPageFn = defaultPageFactory) {
    const pages = [];
    let page = createPageFn();
    pages.push(page);

    const blocks = Array.isArray(model.blocks) ? model.blocks : [];
    let i = 0;
    while (i < blocks.length) {
        const block = blocks[i];
        if (block && block.type === 'listItem') {
            const group = [];
            while (i < blocks.length && blocks[i] && blocks[i].type === 'listItem') {
                group.push(blocks[i]);
                i++;
            }
            for (const el of listItemsToDom(group)) page.appendChild(el);
            continue;
        }
        if (block && block.type !== 'section') {
            for (const el of blockToElements(block)) page.appendChild(el);
        }
        i++;
    }

    return pages;
}