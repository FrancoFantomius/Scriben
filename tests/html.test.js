import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { pagesToModel, modelToPages } from '../js/editor/html.js';
import {
    emptyModel,
    validateModel,
    normalizeModel,
    mergeRuns,
    DEFAULT_FONT_FAMILY
} from '../js/editor/model.js';

const dom = new JSDOM('<!DOCTYPE html><body><div id="container"></div></body>');
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;

const container = document.getElementById('container');

/**
 * Creates page elements from raw HTML strings (one element per page).
 */
function makePages(htmlArray) {
    container.innerHTML = '';
    return htmlArray.map(html => {
        const page = document.createElement('div');
        page.className = 'page';
        page.innerHTML = html;
        container.appendChild(page);
        return page;
    });
}

/**
 * Page factory mirroring the editor's createPage(): creates a `.page` div
 * appended to the container.
 */
function pageFactory() {
    const page = document.createElement('div');
    page.className = 'page';
    container.appendChild(page);
    return page;
}

/**
 * Runs pagesToModel -> modelToPages -> pagesToModel and asserts identity.
 */
function assertRoundTrip(pageEls) {
    const blocks = pagesToModel(pageEls);
    assert.ok(Array.isArray(blocks));

    const model = {
        title: 'Fixture',
        blocks,
        pageFormat: 'a4',
        fontFamily: DEFAULT_FONT_FAMILY,
        updatedAt: 1700000000000
    };
    validateModel(model);

    const rendered = modelToPages(model, pageFactory);
    assert.ok(rendered.length >= 1);

    const blocks2 = pagesToModel(rendered);
    assert.deepStrictEqual(blocks2, blocks);
    return blocks;
}

const FIXTURE_PAGES = [
    [
        '<h1>Title</h1>',
        '<p>Hello <b>bold</b> and <i>italic</i> <u>under</u> <s>strike</s></p>',
        '<p style="color: rgb(255, 0, 0);">Red <span style="background-color: rgb(255, 255, 0);">highlight</span></p>',
        '<p>See <a href="https://example.com">here</a> now</p>',
        '<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li><li>Three</li></ul>',
        '<ol><li>First</li><li>Second</li></ol>',
        '<p>x<sup>2</sup> H<sub>2</sub>O</p>',
        '<table><tr><th>Head</th><th>Next</th></tr><tr><td>a</td><td>b</td></tr></table>',
        '<img src="data:image/png;base64,AAAA">',
        '<hr>',
        '<p>Line<br>break</p>',
        '<p><br></p>'
    ].join('')
];

describe('pagesToModel', () => {
    test('maps all core block types', () => {
        const blocks = pagesToModel(makePages(FIXTURE_PAGES));
        const types = blocks.map(b => b.type);
        assert.deepStrictEqual(types, [
            'heading', 'paragraph', 'paragraph', 'paragraph',
            'listItem', 'listItem', 'listItem', 'listItem',
            'listItem', 'listItem',
            'paragraph', 'table', 'image', 'horizontalRule',
            'paragraph', 'paragraph'
        ]);
    });

    test('heading captures level', () => {
        const blocks = pagesToModel(makePages(['<h3>Sub</h3>']));
        assert.deepStrictEqual(blocks, [{ type: 'heading', level: 3, runs: [{ text: 'Sub' }] }]);
    });

    test('inline formatting flags are flattened into runs', () => {
        const blocks = pagesToModel(makePages(['<p><b>B</b><i>I</i><u>U</u><s>S</s><sup>P</sup><sub>b</sub></p>']));
        const runs = blocks[0].runs;
        assert.deepStrictEqual(runs, [
            { text: 'B', bold: true },
            { text: 'I', italic: true },
            { text: 'U', underline: true },
            { text: 'S', strikethrough: true },
            { text: 'P', superscript: true },
            { text: 'b', subscript: true }
        ]);
    });

    test('inline styles and font tags become run formatting', () => {
        const blocks = pagesToModel(makePages(['<p><span style="color: rgb(1, 2, 3); background-color: rgb(4, 5, 6);">c</span><font face="Arial" size="4" color="#ff0000">f</font></p>']));
        const runs = blocks[0].runs;
        assert.deepStrictEqual(runs, [
            { text: 'c', color: 'rgb(1, 2, 3)', backgroundColor: 'rgb(4, 5, 6)' },
            { text: 'f', fontFamily: 'Arial', fontSize: '18px', color: '#ff0000' }
        ]);
    });

    test('adjacent runs with identical formatting merge', () => {
        const runs = mergeRuns([
            { text: 'a', bold: true },
            { text: 'b', bold: true },
            { text: 'c' }
        ]);
        assert.deepStrictEqual(runs, [{ text: 'ab', bold: true }, { text: 'c' }]);
    });

    test('inline link becomes a run with href', () => {
        const blocks = pagesToModel(makePages(['<p>See <a href="https://x.test">here</a> now</p>']));
        assert.deepStrictEqual(blocks[0].runs, [
            { text: 'See ' },
            { text: 'here', href: 'https://x.test' },
            { text: ' now' }
        ]);
    });

    test('block-level link maps to a link block', () => {
        const blocks = pagesToModel(makePages(['<a href="https://x.test">block</a>']));
        assert.deepStrictEqual(blocks, [{ type: 'link', href: 'https://x.test', runs: [{ text: 'block' }] }]);
    });

    test('nested lists become flat listItems with level and listType', () => {
        const blocks = pagesToModel(makePages(['<ol><li>One<ul><li>Nested</li></ul></li></ol>']));
        assert.deepStrictEqual(blocks, [
            { type: 'listItem', listType: 'ordered', level: 0, runs: [{ text: 'One' }] },
            { type: 'listItem', listType: 'unordered', level: 1, runs: [{ text: 'Nested' }] }
        ]);
    });

    test('ol start attribute becomes listItem.start at level 0', () => {
        const blocks = pagesToModel(makePages(['<ol start="5"><li>a</li><li>b</li></ol>']));
        assert.deepStrictEqual(blocks, [
            { type: 'listItem', listType: 'ordered', level: 0, start: 5, runs: [{ text: 'a' }] },
            { type: 'listItem', listType: 'ordered', level: 0, start: 5, runs: [{ text: 'b' }] }
        ]);
    });

    test('start applies only to top-level items of the owning ol', () => {
        const blocks = pagesToModel(makePages(['<ol start="3"><li>a<ol><li>b</li></ol></li><li>c</li></ol>']));
        assert.deepStrictEqual(blocks.map(b => [b.level, b.start]), [
            [0, 3], [1, undefined], [0, 3]
        ]);
    });

    test('tables produce cols and rows', () => {
        const blocks = pagesToModel(makePages(['<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>']));
        assert.deepStrictEqual(blocks, [
            { type: 'table', cols: 2, rows: [['a', 'b'], ['c', '']] }
        ]);
    });

    test('page-break divs map to pageBreak blocks and data-split is dropped', () => {
        const blocks = pagesToModel(makePages(['<div class="page-break" contenteditable="false"></div><p data-split="true">split</p><p class="unbreakable">keep</p>']));
        assert.deepStrictEqual(blocks, [
            { type: 'pageBreak' },
            { type: 'paragraph', runs: [{ text: 'split' }] },
            { type: 'paragraph', runs: [{ text: 'keep' }] }
        ]);
    });

    test('images keep src data-URL', () => {
        const blocks = pagesToModel(makePages(['<img src="data:image/png;base64,AAAA">']));
        assert.deepStrictEqual(blocks, [{ type: 'image', src: 'data:image/png;base64,AAAA' }]);
    });

    test('inline image becomes an image run', () => {
        const blocks = pagesToModel(makePages(['<p>a<img src="data:image/png;base64,AAAA">b</p>']));
        assert.deepStrictEqual(blocks[0].runs, [
            { text: 'a' },
            { image: 'data:image/png;base64,AAAA' },
            { text: 'b' }
        ]);
    });

    test('paragraph alignment is captured as a block property', () => {
        const blocks = pagesToModel(makePages(['<p style="text-align: center;">Centered</p>']));
        assert.deepStrictEqual(blocks, [
            { type: 'paragraph', align: 'center', runs: [{ text: 'Centered' }] }
        ]);
    });

    test('block style is not folded into runs as textAlign', () => {
        const blocks = pagesToModel(makePages(['<div style="text-align: right;">Right</div>']));
        assert.deepStrictEqual(blocks, [
            { type: 'paragraph', align: 'right', runs: [{ text: 'Right' }] }
        ]);
    });
});

describe('modelToPages', () => {
    test('reuses the provided page factory', () => {
        container.innerHTML = '';
        const pages = modelToPages(emptyModel(), pageFactory);
        assert.ok(pages.length >= 1);
        assert.equal(pages[0].className, 'page');
        assert.equal(container.children.length, pages.length);
    });

    test('empty model yields at least one page', () => {
        container.innerHTML = '';
        const pages = modelToPages(emptyModel(), pageFactory);
        assert.ok(pages.length >= 1);
    });

    test('listItems are regrouped into a single nested list', () => {
        container.innerHTML = '';
        const model = normalizeModel({
            blocks: [
                { type: 'listItem', listType: 'unordered', level: 0, runs: [{ text: 'One' }] },
                { type: 'listItem', listType: 'unordered', level: 0, runs: [{ text: 'Two' }] },
                { type: 'listItem', listType: 'unordered', level: 1, runs: [{ text: 'Nested' }] },
                { type: 'listItem', listType: 'unordered', level: 0, runs: [{ text: 'Three' }] }
            ]
        });
        const pages = modelToPages(model, pageFactory);
        const html = pages[0].innerHTML;
        assert.ok(html.includes('<ul>'));
        assert.ok(html.includes('<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li><li>Three</li></ul>'));
    });

    test('paragraph blocks emit as divs to match contenteditable output', () => {
        container.innerHTML = '';
        const model = normalizeModel({
            blocks: [{ type: 'paragraph', runs: [{ text: 'x' }] }]
        });
        const pages = modelToPages(model, pageFactory);
        assert.ok(pages[0].innerHTML.startsWith('<div>'));
    });

    test('alignment is emitted on block elements', () => {
        container.innerHTML = '';
        const model = normalizeModel({
            blocks: [
                { type: 'paragraph', align: 'center', runs: [{ text: 'x' }] },
                { type: 'heading', level: 2, align: 'justify', runs: [{ text: 'h' }] }
            ]
        });
        const pages = modelToPages(model, pageFactory);
        const html = pages[0].innerHTML;
        assert.ok(html.includes('text-align: center'));
        assert.ok(html.includes('text-align: justify'));
    });

    test('listItem start is re-emitted on the rebuilt ol', () => {
        container.innerHTML = '';
        const model = normalizeModel({
            blocks: [
                { type: 'listItem', listType: 'ordered', level: 0, start: 5, runs: [{ text: 'a' }] },
                { type: 'listItem', listType: 'ordered', level: 0, start: 5, runs: [{ text: 'b' }] }
            ]
        });
        const pages = modelToPages(model, pageFactory);
        const html = pages[0].innerHTML;
        assert.ok(html.includes('<ol start="5">'), html);
    });
});

describe('round-trip identity', () => {
    test('fixture corpus round-trips stably', () => {
        const blocks = assertRoundTrip(makePages(FIXTURE_PAGES));
        assert.ok(blocks.length > 0);
    });

    test('pagination artifacts round-trip stably', () => {
        assertRoundTrip(makePages([
            '<div class="page-break" contenteditable="false"></div>' +
            '<p data-split="true">continued split text</p>' +
            '<p class="unbreakable">unbreakable para</p>' +
            '<p><font color="#ff0000" size="4">font tag</font></p>'
        ]));
    });

    test('multiple pages round-trip stably', () => {
        assertRoundTrip(makePages([
            '<h1>Page one</h1><p>content</p>',
            '<h2>Page two</h2><p>more content</p>'
        ]));
    });

    test('alignment round-trips stably', () => {
        assertRoundTrip(makePages([
            '<p style="text-align: right;">Right</p>',
            '<h2 style="text-align: justify;">J</h2>'
        ]));
    });

    test('ol start round-trips stably', () => {
        assertRoundTrip(makePages([
            '<ol start="5"><li>a</li><li>b</li></ol>'
        ]));
    });
});

describe('pagination split-collapse', () => {
    const IMG = 'data:image/png;base64,AAAA';

    test('data-split clones map to clean paragraph blocks (attribute dropped)', () => {
        const blocks = pagesToModel(makePages([
            '<div>head text</div>',
            `<div data-split="true">continued <img src="${IMG}"> tail</div>`
        ]));
        assert.deepStrictEqual(blocks, [
            { type: 'paragraph', runs: [{ text: 'head text' }] },
            {
                type: 'paragraph',
                runs: [{ text: 'continued ' }, { image: IMG }, { text: ' tail' }]
            }
        ]);
    });

    test('split clones with an inline image at the boundary round-trip stably', () => {
        assertRoundTrip(makePages([
            '<div>head text</div>',
            `<div data-split="true">continued <img src="${IMG}"> tail</div>`
        ]));
    });

    test('a continuation clone carries no block-level semantics of its own', () => {
        const blocks = pagesToModel(makePages([
            `<div data-split="true" class="unbreakable"><b>bold</b> rest</div>`
        ]));
        assert.deepStrictEqual(blocks, [
            { type: 'paragraph', runs: [{ text: 'bold', bold: true }, { text: ' rest' }] }
        ]);
    });

    test('footnote marker at a split boundary survives model normalization', () => {
        const runs = mergeRuns([
            { text: 'before' },
            { type: 'footnoteRef', id: '1' },
            { text: 'after' },
            { image: IMG }
        ]);
        assert.deepStrictEqual(runs, [
            { text: 'before' },
            { type: 'footnoteRef', id: '1' },
            { text: 'after' },
            { image: IMG }
        ]);
        const model = normalizeModel({
            blocks: [
                { type: 'paragraph', runs },
                { type: 'paragraph', runs: [{ text: 'continuation' }] }
            ]
        });
        assert.deepStrictEqual(model.blocks[0].runs, runs);
    });
});

describe('model.js pure functions', () => {
    test('emptyModel returns canonical shape', () => {
        const m = emptyModel('Doc');
        assert.deepStrictEqual(m.blocks, []);
        assert.equal(m.title, 'Doc');
        assert.equal(m.pageFormat, 'a4');
        assert.equal(typeof m.updatedAt, 'number');
    });

    test('validateModel throws on unknown block type', () => {
        assert.throws(() => validateModel({ blocks: [{ type: 'wat' }] }), /Unknown block type/);
    });

    test('validateModel throws on invalid heading level', () => {
        assert.throws(() => validateModel({ blocks: [{ type: 'heading', level: 9, runs: [] }] }), /heading level/);
    });

    test('validateModel accepts a valid model', () => {
        const m = normalizeModel({
            blocks: [
                { type: 'paragraph', runs: [{ text: 'hi' }] },
                { type: 'heading', level: 2, runs: [{ text: 'sub' }] },
                { type: 'table', cols: 1, rows: [['x']] },
                { type: 'image', src: 'data:image/png;base64,AA' },
                { type: 'pageBreak' },
                { type: 'horizontalRule' },
                { type: 'section' }
            ]
        });
        assert.equal(validateModel(m), true);
    });

    test('normalizeModel drops unknown blocks and coerces defaults', () => {
        const m = normalizeModel({
            title: 42,
            blocks: [
                { type: 'bogus' },
                { type: 'paragraph', runs: [{ text: '' }, { text: 'a' }, { text: 'b' }] }
            ],
            pageFormat: 'not-real'
        });
        assert.equal(m.title, 'Untitled document');
        assert.equal(m.pageFormat, 'a4');
        assert.equal(m.blocks.length, 1);
        assert.deepStrictEqual(m.blocks[0].runs, [{ text: 'ab' }]);
    });

    test('normalizeModel removes empty text runs', () => {
        const m = normalizeModel({
            blocks: [{ type: 'paragraph', runs: [{ text: '' }, { text: 'x' }] }]
        });
        assert.deepStrictEqual(m.blocks[0].runs, [{ text: 'x' }]);
    });
});