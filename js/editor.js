// Scriben WYSIWYG Editor
// Multi-format pagination, toolbar commands, font switching,
// image insertion, PDF export, PouchDB database sync.

import { 
    setActiveDocId,
    registerCallbacks,
    getSyncSettings,
    saveSyncSettings,
    saveDocument,
    getDocument,
    fetchDocumentContentFromCloud,
    startSync,
    stopSync,
    destroyDatabase
} from './sync.js';
import { initFonts } from './options.js';

document.addEventListener('DOMContentLoaded', () => {
    localStorage.setItem('scriben-has-used', 'true');
    const container = document.getElementById('pages-container');

    let lastSelectionRange = null;

    function saveSelection() {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            if (findParentPage(range.startContainer)) {
                lastSelectionRange = range.cloneRange();
            }
        }
    }

    function restoreSelection() {
        if (lastSelectionRange) {
            const sel = window.getSelection();
            const page = findParentPage(lastSelectionRange.startContainer);
            if (page) page.focus();
            sel.removeAllRanges();
            sel.addRange(lastSelectionRange);
        } else {
            const pages = getPages();
            if (pages.length > 0) {
                const firstPage = pages[0];
                firstPage.focus();
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(firstPage);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
    }

    document.addEventListener('selectionchange', saveSelection);

    // --- Custom Modal Handlers for Link and Table ---
    const linkModal = document.getElementById('link-modal');
    const linkUrlInput = document.getElementById('link-url');
    const linkTextInput = document.getElementById('link-text');
    const btnLinkCancel = document.getElementById('btn-link-cancel');
    const btnLinkInsert = document.getElementById('btn-link-insert');

    const tableModal = document.getElementById('table-modal');
    const tableRowsInput = document.getElementById('table-rows');
    const tableColsInput = document.getElementById('table-cols');
    const btnTableCancel = document.getElementById('btn-table-cancel');
    const btnTableInsert = document.getElementById('btn-table-insert');

    // Link Floating Tooltip Elements
    const linkTooltip = document.getElementById('link-tooltip');
    const linkTooltipUrl = document.getElementById('link-tooltip-url');
    const linkTooltipEdit = document.getElementById('link-tooltip-edit');
    const linkTooltipRemove = document.getElementById('link-tooltip-remove');

    let activeLinkToEdit = null;
    let hoveredLink = null;

    function openLinkModal(linkToEdit = null) {
        if (!linkModal) return;
        activeLinkToEdit = linkToEdit;

        let selectedText = '';
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
            selectedText = sel.toString().trim();
        }

        if (activeLinkToEdit) {
            if (linkUrlInput) linkUrlInput.value = activeLinkToEdit.getAttribute('href') || '';
            if (linkTextInput) linkTextInput.value = activeLinkToEdit.textContent || '';
        } else {
            if (linkUrlInput) linkUrlInput.value = 'https://';
            if (linkTextInput) linkTextInput.value = selectedText;
        }

        linkModal.style.display = 'flex';
        
        if (linkTextInput && linkTextInput.value) {
            if (linkUrlInput) {
                linkUrlInput.focus();
                setTimeout(() => linkUrlInput.select(), 50);
            }
        } else if (linkTextInput) {
            linkTextInput.focus();
        }
    }

    function closeLinkModal() {
        if (linkModal) linkModal.style.display = 'none';
        activeLinkToEdit = null;
    }

    if (btnLinkCancel) {
        btnLinkCancel.addEventListener('click', closeLinkModal);
    }

    if (btnLinkInsert) {
        btnLinkInsert.addEventListener('click', () => {
            const url = linkUrlInput.value.trim();
            const text = linkTextInput.value.trim();
            closeLinkModal();

            if (url && url !== 'https://') {
                if (activeLinkToEdit) {
                    activeLinkToEdit.setAttribute('href', url);
                    activeLinkToEdit.textContent = text || url;
                    paginate();
                    saveContent();
                } else {
                    const display = text || url;
                    const anchorHtml = `<a href="${url}" target="_blank">${display}</a>`;
                    exec('insertHTML', anchorHtml);
                }
            }
        });
    }

    [linkUrlInput, linkTextInput].forEach(input => {
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    btnLinkInsert.click();
                } else if (e.key === 'Escape') {
                    closeLinkModal();
                }
            });
        }
    });

    function openTableModal() {
        if (tableModal && tableRowsInput && tableColsInput) {
            tableRowsInput.value = '3';
            tableColsInput.value = '3';
            tableModal.style.display = 'flex';
            tableRowsInput.focus();
        }
    }

    function closeTableModal() {
        if (tableModal) tableModal.style.display = 'none';
    }

    if (btnTableCancel) {
        btnTableCancel.addEventListener('click', closeTableModal);
    }

    if (btnTableInsert) {
        btnTableInsert.addEventListener('click', () => {
            const rows = parseInt(tableRowsInput.value, 10);
            const cols = parseInt(tableColsInput.value, 10);
            closeTableModal();
            if (!isNaN(rows) && !isNaN(cols) && rows > 0 && rows <= 10 && cols > 0 && cols <= 10) {
                let tableHtml = '<table class="unbreakable">';
                for (let r = 0; r < rows; r++) {
                    tableHtml += '<tr>';
                    for (let c = 0; c < cols; c++) {
                        tableHtml += r === 0 ? '<th>Header</th>' : '<td>Cell</td>';
                    }
                    tableHtml += '</tr>';
                }
                tableHtml += '</table>';
                exec('insertHTML', tableHtml);
            } else {
                alert('Invalid input. Please enter numbers between 1 and 10.');
            }
        });
    }

    [tableRowsInput, tableColsInput].forEach(input => {
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    btnTableInsert.click();
                } else if (e.key === 'Escape') {
                    closeTableModal();
                }
            });
        }
    });

    // --- Custom Color Picker Popover Logic ---
    const colorPickerPopover = document.getElementById('color-picker-popover');
    const colorPickerTitle = document.getElementById('color-picker-title');
    const colorPaletteGrid = document.getElementById('color-palette-grid');
    const btnCustomColor = document.getElementById('btn-custom-color');
    const nativeColorPicker = document.getElementById('native-color-picker');

    let activeColorCommand = 'foreColor';

    const customPaletteColors = [
        '#000000', '#4a5568', '#718096', '#cbd5e0', '#ffffff',
        '#e53e3e', '#dd6b20', '#ecc94b', '#38a169', '#3182ce',
        '#805ad5', '#d53f8c', '#319795', '#2c5282', '#2f855a'
    ];

    if (colorPaletteGrid) {
        customPaletteColors.forEach(color => {
            const cell = document.createElement('div');
            cell.style.width = '20px';
            cell.style.height = '20px';
            cell.style.borderRadius = '50%';
            cell.style.backgroundColor = color;
            cell.style.cursor = 'pointer';
            cell.style.border = '1px solid var(--color-toolbar-border)';
            cell.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.1)';
            cell.style.transition = 'transform 0.15s ease, border-color 0.15s ease';
            cell.title = color;

            cell.addEventListener('mouseover', () => {
                cell.style.transform = 'scale(1.2)';
                cell.style.borderColor = 'var(--color-brand)';
            });
            cell.addEventListener('mouseout', () => {
                cell.style.transform = 'scale(1)';
                cell.style.borderColor = 'var(--color-toolbar-border)';
            });

            cell.addEventListener('click', (e) => {
                e.stopPropagation();
                exec(activeColorCommand, color);
                hideColorPicker();
            });

            colorPaletteGrid.appendChild(cell);
        });
    }

    function showColorPicker(btn, command) {
        if (!colorPickerPopover) return;
        activeColorCommand = command;
        if (colorPickerTitle) {
            colorPickerTitle.textContent = command === 'foreColor' ? 'Text Color' : 'Highlight Color';
        }

        const rect = btn.getBoundingClientRect();
        colorPickerPopover.style.display = 'flex';
        colorPickerPopover.style.top = `${rect.bottom + window.scrollY + 6}px`;
        colorPickerPopover.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 200)}px`;
    }

    function hideColorPicker() {
        if (colorPickerPopover) colorPickerPopover.style.display = 'none';
    }

    if (btnCustomColor && nativeColorPicker) {
        btnCustomColor.addEventListener('click', (e) => {
            e.stopPropagation();
            nativeColorPicker.click();
        });

        nativeColorPicker.addEventListener('change', (e) => {
            const color = e.target.value;
            exec(activeColorCommand, color);
            hideColorPicker();
        });
    }

    // --- Floating Link Tooltip Logic ---
    function checkLinkTooltip(e) {
        let node = e.target;
        while (node && node !== container && !node.classList?.contains('page')) {
            if (node.tagName === 'A') {
                showLinkTooltip(node);
                return;
            }
            node = node.parentNode;
        }
        hideLinkTooltip();
    }

    function showLinkTooltip(anchor) {
        if (!linkTooltip || !linkTooltipUrl) return;
        hoveredLink = anchor;
        const href = anchor.getAttribute('href') || '#';
        linkTooltipUrl.href = href;
        linkTooltipUrl.textContent = href;

        const rect = anchor.getBoundingClientRect();
        linkTooltip.style.display = 'flex';
        
        const top = rect.bottom + window.scrollY + 6;
        const left = rect.left + window.scrollX;
        
        linkTooltip.style.top = `${top}px`;
        linkTooltip.style.left = `${left}px`;
    }

    function hideLinkTooltip() {
        if (linkTooltip) linkTooltip.style.display = 'none';
        hoveredLink = null;
    }

    if (linkTooltipEdit) {
        linkTooltipEdit.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (hoveredLink) {
                openLinkModal(hoveredLink);
            }
            hideLinkTooltip();
        });
    }

    if (linkTooltipRemove) {
        linkTooltipRemove.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (hoveredLink) {
                const textNode = document.createTextNode(hoveredLink.textContent);
                hoveredLink.replaceWith(textNode);
                paginate();
                saveContent();
            }
            hideLinkTooltip();
        });
    }

    container.addEventListener('click', checkLinkTooltip);
    container.addEventListener('keyup', checkLinkTooltip);

    document.addEventListener('mousedown', (e) => {
        if (linkTooltip && linkTooltip.style.display !== 'none') {
            if (!linkTooltip.contains(e.target) && !container.contains(e.target)) {
                hideLinkTooltip();
            }
        }
        if (colorPickerPopover && colorPickerPopover.style.display !== 'none') {
            if (!colorPickerPopover.contains(e.target)) {
                hideColorPicker();
            }
        }
    });

    const toolbarButtons = document.querySelectorAll('.tool-button[data-command]');
    const fontSelect = document.getElementById('fontSelect');
    const fontSizeSelect = document.getElementById('fontSizeSelect');
    const imageInput = document.getElementById('imageInput');
    const imageBtn = document.getElementById('imageBtn');
    const pageBreakBtn = document.getElementById('pageBreakBtn');
    const exportPdfBtn = document.getElementById('exportPdfBtn');

    // --- Page helpers ---
    function getPages() {
        return Array.from(container.querySelectorAll('.page'));
    }

    function createPage() {
        const page = document.createElement('div');
        page.className = 'page';
        page.contentEditable = 'true';
        page.spellcheck = false;
        if (currentDoc && currentDoc.fontFamily) {
            page.style.fontFamily = currentDoc.fontFamily;
        }
        container.appendChild(page);
        bindPageEvents(page);
        return page;
    }

    function getActivePage() {
        const sel = window.getSelection();
        if (sel.rangeCount) {
            let node = sel.anchorNode;
            while (node && !node.classList?.contains('page')) {
                node = node.parentNode;
            }
            return node || getPages().at(-1);
        }
        return getPages().at(-1);
    }

    function findParentPage(node) {
        while (node && !node.classList?.contains('page')) {
            node = node.parentNode;
        }
        return node;
    }

    // --- Overflow detection & pagination ---
    // Temporarily allow overflow on a page so scrollHeight reflects real content height
    function measureOverflow(page) {
        page.style.overflow = 'auto';
        const overflows = page.scrollHeight > page.clientHeight;
        page.style.overflow = '';
        return overflows;
    }

    function findOverflowIndex(container, page) {
        const children = Array.from(container.childNodes);
        if (children.length === 0) return -1;

        // Check for manual page-break elements
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.nodeType === Node.ELEMENT_NODE) {
                if (child.classList.contains('page-break')) {
                    if (i < children.length - 1) {
                        return i + 1; // Start overflow at the next sibling
                    }
                } else if (child.querySelector('.page-break')) {
                    return i; // Force split inside this child
                }
            }
        }

        let low = 0;
        let high = children.length - 1;
        let result = children.length; // Default to length (overflow occurs after these children or elsewhere)

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);

            // Temporarily remove children from mid + 1 to the end
            const detached = [];
            for (let i = mid + 1; i < children.length; i++) {
                detached.push({ node: children[i], nextSibling: children[i].nextSibling });
                children[i].remove();
            }

            const overflows = measureOverflow(page);

            // Re-attach detached children in reverse order to preserve original structure
            for (let i = detached.length - 1; i >= 0; i--) {
                const { node, nextSibling } = detached[i];
                container.insertBefore(node, nextSibling);
            }

            if (overflows) {
                // If it overflows with children 0..mid, the first overflow child is at or before mid
                result = mid;
                high = mid - 1;
            } else {
                // If it doesn't overflow with children 0..mid, the first overflow child is after mid
                low = mid + 1;
            }
        }

        return result;
    }

    function splitNode(node, page, nextContainer, isFirstOnPage) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            let low = 0;
            let high = text.length;
            let splitIdx = text.length;

            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                node.textContent = text.slice(0, mid);

                const overflows = measureOverflow(page);
                if (overflows) {
                    splitIdx = mid;
                    high = mid - 1;
                } else {
                    low = mid + 1;
                }
            }

            // Restore text and split
            if (splitIdx === 0) {
                if (!isFirstOnPage) {
                    node.textContent = text;
                    nextContainer.insertBefore(node, nextContainer.firstChild);
                } else {
                    // Safety: keep at least 1 character to avoid empty/collapsing node
                    const safeSplit = Math.max(1, splitIdx);
                    if (safeSplit < text.length) {
                        node.textContent = text.slice(0, safeSplit);
                        const nextTextNode = document.createTextNode(text.slice(safeSplit));
                        nextContainer.insertBefore(nextTextNode, nextContainer.firstChild);
                    } else {
                        node.textContent = text;
                    }
                }
            } else if (splitIdx < text.length) {
                let adjustedSplitIdx = splitIdx;
                const lastSpace = text.lastIndexOf(' ', splitIdx);
                if (lastSpace > 0 && (splitIdx - lastSpace) < 20) {
                    adjustedSplitIdx = lastSpace + 1;
                }

                if (adjustedSplitIdx === 0 && !isFirstOnPage) {
                    node.textContent = text;
                    nextContainer.insertBefore(node, nextContainer.firstChild);
                } else {
                    const safeSplit = (adjustedSplitIdx === 0 && isFirstOnPage) ? 1 : adjustedSplitIdx;
                    node.textContent = text.slice(0, safeSplit);
                    const nextText = text.slice(safeSplit);
                    if (nextText.length > 0) {
                        const nextTextNode = document.createTextNode(nextText);
                        nextContainer.insertBefore(nextTextNode, nextContainer.firstChild);
                    }
                }
            } else {
                node.textContent = text;
            }
            return;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            const unbreakableTags = ['IMG', 'BR', 'HR', 'TABLE', 'IFRAME', 'VIDEO', 'AUDIO'];
            if (unbreakableTags.includes(node.tagName) || node.classList.contains('unbreakable')) {
                if (!isFirstOnPage) {
                    nextContainer.insertBefore(node, nextContainer.firstChild);
                }
                return;
            }

            const overflowIdx = findOverflowIndex(node, page);
            if (overflowIdx === -1) {
                return; // Everything fits inside this element
            }

            const children = Array.from(node.childNodes);

            // Re-use or create split container
            let clone = nextContainer.firstChild;
            if (!clone || clone.tagName !== node.tagName || !clone.hasAttribute('data-split')) {
                clone = node.cloneNode(false);
                clone.setAttribute('data-split', 'true');
                nextContainer.insertBefore(clone, nextContainer.firstChild);
            }

            // Move trailing children to the clone
            const insertBeforeRef = clone.firstChild;
            for (let i = overflowIdx + 1; i < children.length; i++) {
                clone.insertBefore(children[i], insertBeforeRef);
            }

            // Recursively split the boundary child
            const boundaryChild = children[overflowIdx];
            if (boundaryChild) {
                const isBoundaryFirst = (overflowIdx === 0 && isFirstOnPage);
                splitNode(boundaryChild, page, clone, isBoundaryFirst);
            }

            // Clean up empty nodes
            if (node.childNodes.length === 0) {
                node.remove();
            }
            if (clone.childNodes.length === 0) {
                clone.remove();
            }
        }
    }

    function splitPage(page, next) {
        const overflowIdx = findOverflowIndex(page, page);
        if (overflowIdx === -1) return;

        const children = Array.from(page.childNodes);

        // Move all children after the overflow point to the next page
        for (let i = overflowIdx + 1; i < children.length; i++) {
            next.insertBefore(children[i], next.firstChild);
        }

        // Split the boundary child
        const boundaryChild = children[overflowIdx];
        if (boundaryChild) {
            const isFirst = (overflowIdx === 0);
            splitNode(boundaryChild, page, next, isFirst);
        }
    }

    function cleanupEmptyPages() {
        const pages = getPages();
        for (let i = pages.length - 1; i > 0; i--) {
            const text = pages[i].textContent.replace(/\s/g, '');
            const hasImages = pages[i].querySelector('img, table, iframe, video, audio') !== null;
            if (text === '' && !hasImages) {
                pages[i].remove();
            } else {
                break;
            }
        }
    }

    function paginate() {
        const pages = getPages();

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];

            if (measureOverflow(page)) {
                let next = pages[i + 1];
                if (!next) {
                    next = createPage();
                    pages.push(next);
                }
                splitPage(page, next);
            } else {
                let next = pages[i + 1];
                if (next) {
                    let pulledAny = false;

                    while (next.childNodes.length > 0 && !measureOverflow(page)) {
                        const firstChild = next.firstChild;
                        const lastChild = page.lastChild;

                        // Only merge if both are elements of the same tag and it was originally split
                        if (lastChild && lastChild.nodeType === Node.ELEMENT_NODE &&
                            firstChild.nodeType === Node.ELEMENT_NODE &&
                            lastChild.tagName === firstChild.tagName &&
                            firstChild.hasAttribute('data-split') &&
                            !firstChild.classList.contains('unbreakable') &&
                            !lastChild.classList.contains('unbreakable')) {

                            while (firstChild.firstChild) {
                                lastChild.appendChild(firstChild.firstChild);
                            }
                            firstChild.remove();
                            lastChild.normalize();
                        } else {
                            page.appendChild(firstChild);
                        }
                        pulledAny = true;
                    }

                    if (pulledAny && measureOverflow(page)) {
                        splitPage(page, next);
                    }
                }
            }
        }

        cleanupEmptyPages();
    }

    // --- Bind events on each page ---
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    function saveCursor() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return null;
        const range = sel.getRangeAt(0);
        const marker = document.createElement('span');
        marker.id = '_scriben_cursor';
        marker.style.display = 'none';
        range.insertNode(marker);
        return marker;
    }

    function restoreCursor(marker) {
        if (!marker || !marker.parentNode) return;
        const sel = window.getSelection();
        const range = document.createRange();
        range.setStartAfter(marker);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        marker.remove();
    }

    function bindPageEvents(page) {
        page.addEventListener('input', () => {
            const marker = saveCursor();
            paginate();
            restoreCursor(marker);
            debouncedSaveContent();
            updateActiveStates();
        });
        page.addEventListener('keyup', updateActiveStates);
        page.addEventListener('mouseup', updateActiveStates);

        // Navigate between pages with arrow keys
        page.addEventListener('keydown', (e) => {
            const pages = getPages();
            const idx = pages.indexOf(page);

            if (e.key === 'Backspace') {
                // If at start of a non-first page and it's empty, move to previous
                const sel = window.getSelection();
                if (idx > 0 && sel.anchorOffset === 0 && page.textContent === '') {
                    e.preventDefault();
                    page.remove();
                    const prev = pages[idx - 1];
                    placeCursorAtEnd(prev);
                    debouncedSaveContent();
                }
            }
        });
    }

    function placeCursorAtEnd(el) {
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    // --- Persistence & Sync ---
    const STORAGE_KEY = 'scriben-wysiwyg-content';
    
    // --- Document ID routing ---
    function getActiveDocumentId() {
        const params = new URLSearchParams(window.location.search);
        let id = params.get('id');
        if (!id) {
            id = localStorage.getItem('scriben-active-doc-id');
        }
        if (!id) {
            id = 'doc_' + crypto.randomUUID();
            params.set('id', id);
            window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
        }
        localStorage.setItem('scriben-active-doc-id', id);
        return id;
    }
    
    const docId = getActiveDocumentId();
    setActiveDocId(docId);

    let currentDoc = {
        title: 'Untitled document',
        content: [],
        offlineUse: true,
        pageFormat: 'a4',
        fontFamily: "'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari', 'Noto Sans CJK TC', 'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', 'Noto Color Emoji', sans-serif",
        updatedAt: Date.now()
    };

    async function saveContent() {
        const pages = getPages();
        const data = pages.map(p => p.innerHTML);
        const titleInput = document.getElementById('document-title');
        const title = titleInput ? titleInput.value.trim() : 'Untitled document';

        currentDoc.title = title || 'Untitled document';
        currentDoc.content = data;
        currentDoc.updatedAt = Date.now();

        try {
            await saveDocument(docId, currentDoc);
        } catch (err) {
            console.error("Failed to save content to PouchDB:", err);
        }
    }

    const debouncedSaveContent = debounce(saveContent, 1000);

    async function loadContent() {
        try {
            let doc;
            try {
                doc = await getDocument(docId);
            } catch (err) {
                if (err.status === 404) {
                    doc = null;
                } else {
                    throw err;
                }
            }

            if (!doc) {
                const legacyRaw = localStorage.getItem(STORAGE_KEY);
                let contentData = [];
                if (legacyRaw) {
                    try {
                        const parsed = JSON.parse(legacyRaw);
                        if (Array.isArray(parsed)) contentData = parsed;
                    } catch {
                        contentData = [legacyRaw];
                    }
                    localStorage.removeItem(STORAGE_KEY);
                }

                doc = {
                    title: 'Untitled document',
                    content: contentData,
                    offlineUse: true,
                    pageFormat: 'a4',
                    fontFamily: "'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari', 'Noto Sans CJK TC', 'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', 'Noto Color Emoji', sans-serif",
                    updatedAt: Date.now()
                };
                await saveDocument(docId, doc);
            }

            // If the document was synced but its content was pruned (offlineUse: false),
            // lazily fetch the content from Filen cloud before rendering.
            const contentIsEmpty = !doc.content || !Array.isArray(doc.content) || doc.content.length === 0;
            if (contentIsEmpty && doc.synced) {
                const cloudDoc = await fetchDocumentContentFromCloud(docId);
                if (cloudDoc) {
                    doc = cloudDoc;
                }
            }

            currentDoc = doc;
            renderDocument(doc);
        } catch (err) {
            console.error("Failed to load content from PouchDB:", err);
        }
    }

    function renderDocument(doc) {
        const titleInput = document.getElementById('document-title');
        if (titleInput) {
            titleInput.value = doc.title || 'Untitled document';
        }

        applyPageFormat(doc.pageFormat || 'a4');
        applyFontFamily(doc.fontFamily || "'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari', 'Noto Sans CJK TC', 'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', 'Noto Color Emoji', sans-serif");

        let contentArray = [];
        if (doc.content) {
            if (Array.isArray(doc.content)) {
                contentArray = doc.content;
            } else if (typeof doc.content === 'string') {
                contentArray = [doc.content];
            }
        }

        if (contentArray.length > 0) {
            container.innerHTML = '';
            contentArray.forEach(html => {
                const page = createPage();
                page.innerHTML = html;
            });
        } else {
            container.innerHTML = '';
            createPage();
        }

        updateOfflineMenuCheckmark(doc.offlineUse !== false);

        // Paginate on load to ensure content fits the current format and splits correctly
        requestAnimationFrame(() => {
            paginate();
        });
    }

    // --- Toolbar Command Execution ---
    const exec = (command, value = null) => {
        restoreSelection();
        const sel = window.getSelection();
        const pages = getPages();

        // Check if the selection spans multiple pages
        let multiPage = false;
        if (sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const startPage = findParentPage(range.startContainer);
            const endPage = findParentPage(range.endContainer);

            if (startPage && endPage && startPage !== endPage) {
                multiPage = true;
                const startIdx = pages.indexOf(startPage);
                const endIdx = pages.indexOf(endPage);
                // Save boundary info before we manipulate selections
                const origStartContainer = range.startContainer;
                const origStartOffset = range.startOffset;
                const origEndContainer = range.endContainer;
                const origEndOffset = range.endOffset;

                for (let i = startIdx; i <= endIdx; i++) {
                    const page = pages[i];
                    const pageRange = document.createRange();

                    if (i === startIdx) {
                        pageRange.setStart(origStartContainer, origStartOffset);
                        if (page.lastChild) {
                            pageRange.setEndAfter(page.lastChild);
                        } else {
                            pageRange.setEnd(page, page.childNodes.length);
                        }
                    } else if (i === endIdx) {
                        if (page.firstChild) {
                            pageRange.setStartBefore(page.firstChild);
                        } else {
                            pageRange.setStart(page, 0);
                        }
                        pageRange.setEnd(origEndContainer, origEndOffset);
                    } else {
                        pageRange.selectNodeContents(page);
                    }

                    page.focus();
                    sel.removeAllRanges();
                    sel.addRange(pageRange);
                    document.execCommand(command, false, value);
                }

                // Restore cross-page selection so it stays visible
                // and subsequent commands continue to work across all pages
                const updatedPages = getPages();
                const first = updatedPages[startIdx];
                const last = updatedPages[Math.min(endIdx, updatedPages.length - 1)];
                if (first && last) {
                    const restoreRange = document.createRange();
                    restoreRange.setStartBefore(first.firstChild || first);
                    restoreRange.setEndAfter(last.lastChild || last);
                    sel.removeAllRanges();
                    sel.addRange(restoreRange);
                }
            }
        }

        if (!multiPage) {
            document.execCommand(command, false, value);
            const active = getActivePage();
            if (active) active.focus();
        }

        updateActiveStates();
        // Re-check pagination after formatting changes
        requestAnimationFrame(() => {
            paginate();
            saveContent();
        });
    };

    toolbarButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const cmd = btn.dataset.command;
            if (cmd === 'formatBlock') {
                exec(cmd, btn.dataset.value);
            } else if (cmd === 'createLink') {
                openLinkModal();
            } else if (cmd === 'foreColor' || cmd === 'backColor') {
                showColorPicker(btn, cmd);
            } else {
                exec(cmd);
            }
        });
    });

    // --- Font Family & Size ---
    fontSelect.addEventListener('change', () => {
        const selectedValue = fontSelect.value;
        const sel = window.getSelection();
        if (sel.rangeCount > 0 && !sel.isCollapsed) {
            exec('fontName', selectedValue);
        } else {
            applyFontFamily(selectedValue);
            saveContent();
        }
    });
    fontSizeSelect.addEventListener('change', () => {
        exec('fontSize', fontSizeSelect.value);
    });

    const btnFontDecrease = document.getElementById('btn-font-decrease');
    const btnFontIncrease = document.getElementById('btn-font-increase');

    if (btnFontDecrease) {
        btnFontDecrease.addEventListener('click', () => {
            const currentSizeVal = document.queryCommandValue('fontSize');
            let currentSize = parseInt(currentSizeVal) || 4;
            if (!currentSizeVal && fontSizeSelect) {
                currentSize = parseInt(fontSizeSelect.value) || 4;
            }
            if (currentSize < 1 || currentSize > 7) {
                currentSize = 4;
            }
            const newSize = Math.max(1, currentSize - 1);
            exec('fontSize', newSize);
            if (fontSizeSelect) {
                fontSizeSelect.value = newSize;
            }
        });
    }

    if (btnFontIncrease) {
        btnFontIncrease.addEventListener('click', () => {
            const currentSizeVal = document.queryCommandValue('fontSize');
            let currentSize = parseInt(currentSizeVal) || 4;
            if (!currentSizeVal && fontSizeSelect) {
                currentSize = parseInt(fontSizeSelect.value) || 4;
            }
            if (currentSize < 1 || currentSize > 7) {
                currentSize = 4;
            }
            const newSize = Math.min(7, currentSize + 1);
            exec('fontSize', newSize);
            if (fontSizeSelect) {
                fontSizeSelect.value = newSize;
            }
        });
    }

    // --- Image Insertion ---
    imageBtn.addEventListener('click', () => {
        imageInput.click();
    });
    imageInput.addEventListener('change', () => {
        const file = imageInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            exec('insertImage', e.target.result);
        };
        reader.readAsDataURL(file);
        imageInput.value = '';
    });

    if (pageBreakBtn) {
        pageBreakBtn.addEventListener('click', () => {
            const pageBreakHtml = '<div class="page-break unbreakable" contenteditable="false"></div>';
            exec('insertHTML', pageBreakHtml);
        });
    }

    // --- PDF Export ---
    // Dynamically load a script and return a promise
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) {
                resolve();
                return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(s);
        });
    }

    async function ensurePdfLibs() {
        const libs = [
            'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
            'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js'
        ];
        for (const src of libs) {
            await loadScript(src);
        }
    }

    exportPdfBtn.addEventListener('click', async () => {
        // Disable button & show feedback
        exportPdfBtn.disabled = true;
        const icon = exportPdfBtn.querySelector('.material-symbols-outlined');
        const origIcon = icon.textContent;
        icon.textContent = 'hourglass_empty';

        try {
            document.documentElement.setAttribute('data-theme-pdf', 'true');
            await ensurePdfLibs();
            await generatePdf();
        } catch (err) {
            console.error('PDF export failed:', err);
            alert('PDF export failed. Check the console for details.');
        } finally {
            document.documentElement.removeAttribute('data-theme-pdf');
            exportPdfBtn.disabled = false;
            icon.textContent = origIcon;
        }
    });

    async function generatePdf() {
        const { jsPDF } = window.jspdf;
        const format = currentDoc.pageFormat || 'a4';

        let pageWidthMM = 210;
        let pageHeightMM = 297;

        if (format === 'a5') {
            pageWidthMM = 148;
            pageHeightMM = 210;
        } else if (format === 'letter') {
            pageWidthMM = 215.9;
            pageHeightMM = 279.4;
        } else if (format === 'legal') {
            pageWidthMM = 215.9;
            pageHeightMM = 355.6;
        }

        const pdf = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: format,
            compress: true
        });

        const pages = getPages();

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];

            // Render each page element to a high-resolution canvas
            const canvas = await html2canvas(page, {
                scale: 2,                  // 2× resolution for crisp text
                useCORS: true,             // allow cross-origin images
                allowTaint: true,
                backgroundColor: '#ffffff',
                logging: false,
                width: page.offsetWidth,
                height: page.offsetHeight,
                windowWidth: page.offsetWidth,
                windowHeight: page.offsetHeight
            });

            const imgData = canvas.toDataURL('image/png');

            if (i > 0) {
                pdf.addPage(format, 'portrait');
            }

            pdf.addImage(imgData, 'PNG', 0, 0, pageWidthMM, pageHeightMM);
        }

        // Use the document title input value as the filename
        const titleInput = document.querySelector('header input[type="text"]');
        const docName = (titleInput && titleInput.value.trim())
            ? titleInput.value.trim().replace(/[^a-zA-Z0-9_\- ]/g, '')
            : 'ScribenDocument';
        pdf.save(`${docName}.pdf`);
    }

    // --- Active State UI ---
    function updateActiveStates() {
        toolbarButtons.forEach(btn => btn.classList.remove('active'));
        if (document.queryCommandState('bold')) document.querySelector('[data-command="bold"]')?.classList.add('active');
        if (document.queryCommandState('italic')) document.querySelector('[data-command="italic"]')?.classList.add('active');
        if (document.queryCommandState('underline')) document.querySelector('[data-command="underline"]')?.classList.add('active');

        // Sync font family selection with current caret position
        if (fontSelect) {
            const currentFont = document.queryCommandValue('fontName');
            if (currentFont) {
                fontSelect.value = currentFont;
                if (!fontSelect.value) {
                    const primaryFont = currentFont.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
                    for (let i = 0; i < fontSelect.options.length; i++) {
                        const opt = fontSelect.options[i];
                        const optPrimary = opt.value.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
                        if (optPrimary === primaryFont) {
                            fontSelect.selectedIndex = i;
                            break;
                        }
                    }
                }
            }
        }

        // Sync font size selection with current caret position
        if (fontSizeSelect) {
            const currentSize = document.queryCommandValue('fontSize');
            if (currentSize) {
                fontSizeSelect.value = currentSize;
            }
        }
    }

    // --- Select All across pages ---
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            const pages = getPages();
            if (pages.length <= 1) return; // let native behaviour handle single page
            e.preventDefault();
            const first = pages[0];
            const last = pages[pages.length - 1];
            const sel = window.getSelection();
            const range = document.createRange();
            range.setStartBefore(first.firstChild || first);
            range.setEndAfter(last.lastChild || last);
            sel.removeAllRanges();
            sel.addRange(range);
        }
    });

    // --- Dropdown Menus (Generic Toggle & Populating Submenus) ---
    const dropdowns = [
        { trigger: 'menu-file-trigger', menu: 'file-dropdown' },
        { trigger: 'menu-edit-trigger', menu: 'edit-dropdown' },
        { trigger: 'menu-view-trigger', menu: 'view-dropdown' },
        { trigger: 'menu-insert-trigger', menu: 'insert-dropdown' },
        { trigger: 'menu-format-trigger', menu: 'format-dropdown' }
    ];

    dropdowns.forEach(({ trigger: triggerId, menu: menuId }) => {
        const trigger = document.getElementById(triggerId);
        const menu = document.getElementById(menuId);
        if (trigger && menu) {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close all other dropdowns
                dropdowns.forEach(d => {
                    if (d.menu !== menuId) {
                        const m = document.getElementById(d.menu);
                        if (m) m.style.display = 'none';
                    }
                });
                const isVisible = menu.style.display === 'block';
                menu.style.display = isVisible ? 'none' : 'block';
            });
        }
    });

    document.addEventListener('click', () => {
        dropdowns.forEach(d => {
            const m = document.getElementById(d.menu);
            if (m) m.style.display = 'none';
        });
    });

    // Helper to close all dropdowns
    function closeAllDropdowns() {
        dropdowns.forEach(d => {
            const m = document.getElementById(d.menu);
            if (m) m.style.display = 'none';
        });
    }

    // --- Edit Dropdown Event Listeners ---
    const editUndo = document.getElementById('menu-edit-undo');
    const editRedo = document.getElementById('menu-edit-redo');
    const editCut = document.getElementById('menu-edit-cut');
    const editCopy = document.getElementById('menu-edit-copy');
    const editPaste = document.getElementById('menu-edit-paste');
    const editSelectAll = document.getElementById('menu-edit-selectall');

    if (editUndo) {
        editUndo.addEventListener('click', (e) => {
            e.preventDefault();
            exec('undo');
            closeAllDropdowns();
        });
    }
    if (editRedo) {
        editRedo.addEventListener('click', (e) => {
            e.preventDefault();
            exec('redo');
            closeAllDropdowns();
        });
    }

    const tryClipboardCommand = (cmd) => {
        try {
            const success = document.execCommand(cmd);
            if (!success) {
                alert(`Browser blocked standard clipboard '${cmd}'. Please use keyboard shortcut (Ctrl+${cmd === 'cut' ? 'X' : cmd === 'copy' ? 'C' : 'V'}).`);
            }
        } catch (err) {
            alert(`Browser blocked standard clipboard '${cmd}'. Please use keyboard shortcut (Ctrl+${cmd === 'cut' ? 'X' : cmd === 'copy' ? 'C' : 'V'}).`);
        }
    };

    if (editCut) {
        editCut.addEventListener('click', (e) => {
            e.preventDefault();
            tryClipboardCommand('cut');
            closeAllDropdowns();
        });
    }
    if (editCopy) {
        editCopy.addEventListener('click', (e) => {
            e.preventDefault();
            tryClipboardCommand('copy');
            closeAllDropdowns();
        });
    }
    if (editPaste) {
        editPaste.addEventListener('click', (e) => {
            e.preventDefault();
            tryClipboardCommand('paste');
            closeAllDropdowns();
        });
    }
    if (editSelectAll) {
        editSelectAll.addEventListener('click', (e) => {
            e.preventDefault();
            const pages = getPages();
            if (pages.length > 0) {
                const first = pages[0];
                const last = pages[pages.length - 1];
                const sel = window.getSelection();
                const range = document.createRange();
                range.setStartBefore(first.firstChild || first);
                range.setEndAfter(last.lastChild || last);
                sel.removeAllRanges();
                sel.addRange(range);
            }
            closeAllDropdowns();
        });
    }

    // --- Insert Dropdown Event Listeners ---
    const insertImage = document.getElementById('menu-insert-image');
    const insertLink = document.getElementById('menu-insert-link');
    const insertTable = document.getElementById('menu-insert-table');
    const insertHr = document.getElementById('menu-insert-hr');
    const insertPageBreak = document.getElementById('menu-insert-pagebreak');

    if (insertImage) {
        insertImage.addEventListener('click', (e) => {
            e.preventDefault();
            const imageInput = document.getElementById('imageInput');
            if (imageInput) imageInput.click();
            closeAllDropdowns();
        });
    }
    if (insertLink) {
        insertLink.addEventListener('click', (e) => {
            e.preventDefault();
            openLinkModal();
            closeAllDropdowns();
        });
    }
    if (insertTable) {
        insertTable.addEventListener('click', (e) => {
            e.preventDefault();
            openTableModal();
            closeAllDropdowns();
        });
    }
    if (insertHr) {
        insertHr.addEventListener('click', (e) => {
            e.preventDefault();
            exec('insertHorizontalRule');
            closeAllDropdowns();
        });
    }
    if (insertPageBreak) {
        insertPageBreak.addEventListener('click', (e) => {
            e.preventDefault();
            // Insert page-break divider element
            const pageBreakHtml = '<div class="page-break unbreakable" contenteditable="false"></div>';
            exec('insertHTML', pageBreakHtml);
            closeAllDropdowns();
        });
    }

    // --- Page Formatting ---
    function applyPageFormat(format) {
        const validFormats = ['a4', 'a5', 'letter', 'legal'];
        if (!validFormats.includes(format)) format = 'a4';

        const container = document.getElementById('pages-container');
        if (container) {
            validFormats.forEach(f => container.classList.remove(`format-${f}`));
            container.classList.add(`format-${format}`);
        }

        validFormats.forEach(f => {
            const check = document.getElementById(`format-${f}-check`);
            if (check) {
                check.style.display = (f === format) ? 'block' : 'none';
            }
        });

        currentDoc.pageFormat = format;
    }

    function applyFontFamily(fontFamily) {
        const pages = getPages();
        pages.forEach(page => {
            page.style.fontFamily = fontFamily;
        });
        currentDoc.fontFamily = fontFamily;
        if (fontSelect) {
            fontSelect.value = fontFamily;
            if (!fontSelect.value) {
                const primaryFont = fontFamily.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
                for (let i = 0; i < fontSelect.options.length; i++) {
                    const opt = fontSelect.options[i];
                    const optPrimary = opt.value.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
                    if (optPrimary === primaryFont) {
                        fontSelect.selectedIndex = i;
                        break;
                    }
                }
            }
        }
    }

    const formats = ['a4', 'letter', 'legal', 'a5'];
    formats.forEach(f => {
        const btn = document.getElementById(`menu-format-${f}`);
        if (btn) {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                applyPageFormat(f);
                paginate();
                saveContent();
            });
        }
    });

    function updateOfflineMenuCheckmark(isOffline) {
        const check = document.getElementById('offline-check');
        if (check) {
            check.style.display = isOffline ? 'block' : 'none';
        }
    }

    const newDocBtn = document.getElementById('menu-new-doc');
    if (newDocBtn) {
        newDocBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const newId = 'doc_' + crypto.randomUUID();
            window.location.href = `${window.location.pathname}?id=${newId}`;
        });
    }

    const toggleOfflineBtn = document.getElementById('menu-toggle-offline');
    if (toggleOfflineBtn) {
        toggleOfflineBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentDoc.offlineUse = (currentDoc.offlineUse !== false) ? false : true;
            await saveDocument(docId, currentDoc);
            updateOfflineMenuCheckmark(currentDoc.offlineUse);
            fileDropdown.style.display = 'none';
        });
    }

    const exportPdfBtnMenu = document.getElementById('menu-export-pdf');
    if (exportPdfBtnMenu) {
        exportPdfBtnMenu.addEventListener('click', (e) => {
            e.preventDefault();
            exportPdfBtn.click();
            fileDropdown.style.display = 'none';
        });
    }

    // --- Document Title Change Auto-Save ---
    const documentTitleInput = document.getElementById('document-title');
    if (documentTitleInput) {
        documentTitleInput.addEventListener('input', () => {
            debouncedSaveContent();
        });
    }

    // --- Settings & Sync UI Modal ---
    const btnSyncLogin = document.getElementById('btn-sync-login');
    const btnSyncProfile = document.getElementById('btn-sync-profile');
    const settingsModal = document.getElementById('settings-modal');
    const btnSaveSyncCancel = document.getElementById('btn-save-sync-cancel');

    const inputEmail = document.getElementById('sync-email');
    const inputPassword = document.getElementById('sync-password');
    const input2FA = document.getElementById('sync-twofactor');
    const statusText = document.getElementById('sync-settings-status');
    const btnSaveSync = document.getElementById('btn-save-sync');

    // Google-style Dropdown Popover Elements
    const accountDropdown = document.getElementById('account-dropdown');
    const dropdownEmail = document.getElementById('account-dropdown-email');
    const dropdownAvatarContainer = document.getElementById('dropdown-profile-avatar-container');
    const dropdownAvatar = document.getElementById('dropdown-profile-avatar');
    const dropdownLetter = document.getElementById('dropdown-profile-letter');
    const dropdownIcon = document.getElementById('dropdown-profile-icon');
    const dropdownUsername = document.getElementById('dropdown-profile-username');
    const btnDropdownSignout = document.getElementById('btn-dropdown-signout');
    const btnDropdownPurge = document.getElementById('btn-dropdown-purge');

    // Header letter fallback element
    const headerProfileLetter = document.getElementById('header-profile-letter');

    // Google color palette for avatar initials fallback
    const googleColors = ['#1a73e8', '#d93025', '#f9ab00', '#188038', '#ab47bc', '#00acc1'];
    function getAvatarColor(str) {
        if (!str) return googleColors[0];
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        const index = Math.abs(hash) % googleColors.length;
        return googleColors[index];
    }

    if (btnSyncLogin && settingsModal) {
        btnSyncLogin.addEventListener('click', async () => {
            settingsModal.style.display = 'flex';
            await loadSyncModalState();
        });
    }

    // Toggle dropdown popover on profile click
    if (btnSyncProfile && accountDropdown) {
        btnSyncProfile.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = accountDropdown.style.display === 'flex' || accountDropdown.style.display === 'block';
            accountDropdown.style.display = isVisible ? 'none' : 'flex';
        });
    }

    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
        if (accountDropdown && accountDropdown.style.display !== 'none') {
            if (!accountDropdown.contains(e.target) && (!btnSyncProfile || !btnSyncProfile.contains(e.target))) {
                accountDropdown.style.display = 'none';
            }
        }
    });

    if (btnSaveSyncCancel && settingsModal) {
        btnSaveSyncCancel.addEventListener('click', () => {
            settingsModal.style.display = 'none';
        });
    }

    async function loadSyncModalState() {
        const settings = await getSyncSettings();
        
        // Populate sync modal email field if stored
        inputEmail.value = settings.email || '';
        inputPassword.value = '';
        input2FA.value = '';
        statusText.textContent = '';
        statusText.className = '';

        const isSyncActive = settings.enabled && settings.apiKey;

        // Update header controls
        const btnLogin = document.getElementById('btn-sync-login');
        const btnProfile = document.getElementById('btn-sync-profile');
        const imgAvatar = document.getElementById('header-profile-avatar');
        const iconAvatar = document.getElementById('header-profile-icon');

        if (btnLogin && btnProfile) {
            if (isSyncActive) {
                btnLogin.style.display = 'none';
                btnProfile.style.display = 'flex';
                
                const profileIdentity = settings.username || settings.email || '';
                const initialLetter = profileIdentity.trim().charAt(0).toUpperCase();

                if (settings.avatarURL) {
                    imgAvatar.src = settings.avatarURL;
                    imgAvatar.style.display = 'block';
                    if (headerProfileLetter) headerProfileLetter.style.display = 'none';
                    if (iconAvatar) iconAvatar.style.display = 'none';
                    
                    imgAvatar.onerror = () => {
                        imgAvatar.style.display = 'none';
                        if (headerProfileLetter && initialLetter) {
                            headerProfileLetter.textContent = initialLetter;
                            headerProfileLetter.style.backgroundColor = getAvatarColor(profileIdentity);
                            headerProfileLetter.style.display = 'flex';
                        } else if (iconAvatar) {
                            iconAvatar.style.display = 'block';
                        }
                    };
                } else if (initialLetter) {
                    imgAvatar.style.display = 'none';
                    if (headerProfileLetter) {
                        headerProfileLetter.textContent = initialLetter;
                        headerProfileLetter.style.backgroundColor = getAvatarColor(profileIdentity);
                        headerProfileLetter.style.display = 'flex';
                    }
                    if (iconAvatar) iconAvatar.style.display = 'none';
                } else {
                    imgAvatar.style.display = 'none';
                    if (headerProfileLetter) headerProfileLetter.style.display = 'none';
                    if (iconAvatar) iconAvatar.style.display = 'block';
                }
            } else {
                btnLogin.style.display = 'block';
                btnProfile.style.display = 'none';
                if (accountDropdown) {
                    accountDropdown.style.display = 'none';
                }
            }
        }

        // Update floating Google Account Dropdown contents
        if (isSyncActive) {
            const profileIdentity = settings.username || settings.email || '';
            const initialLetter = profileIdentity.trim().charAt(0).toUpperCase();

            if (dropdownEmail) {
                dropdownEmail.textContent = settings.email || '';
            }
            if (dropdownUsername) {
                dropdownUsername.textContent = settings.username || 'Connected';
            }

            if (settings.avatarURL) {
                if (dropdownAvatar) {
                    dropdownAvatar.src = settings.avatarURL;
                    dropdownAvatar.style.display = 'block';
                }
                if (dropdownLetter) dropdownLetter.style.display = 'none';
                if (dropdownIcon) dropdownIcon.style.display = 'none';
                if (dropdownAvatarContainer) {
                    dropdownAvatarContainer.style.backgroundColor = '#f1f3f4';
                }

                if (dropdownAvatar) {
                    dropdownAvatar.onerror = () => {
                        dropdownAvatar.style.display = 'none';
                        if (dropdownLetter && initialLetter) {
                            dropdownLetter.textContent = initialLetter;
                            dropdownLetter.style.display = 'flex';
                            if (dropdownAvatarContainer) {
                                dropdownAvatarContainer.style.backgroundColor = getAvatarColor(profileIdentity);
                            }
                        } else if (dropdownIcon) {
                            dropdownIcon.style.display = 'block';
                        }
                    };
                }
            } else if (initialLetter) {
                if (dropdownAvatar) dropdownAvatar.style.display = 'none';
                if (dropdownLetter) {
                    dropdownLetter.textContent = initialLetter;
                    dropdownLetter.style.display = 'flex';
                }
                if (dropdownIcon) dropdownIcon.style.display = 'none';
                if (dropdownAvatarContainer) {
                    dropdownAvatarContainer.style.backgroundColor = getAvatarColor(profileIdentity);
                }
            } else {
                if (dropdownAvatar) dropdownAvatar.style.display = 'none';
                if (dropdownLetter) dropdownLetter.style.display = 'none';
                if (dropdownIcon) dropdownIcon.style.display = 'block';
                if (dropdownAvatarContainer) {
                    dropdownAvatarContainer.style.backgroundColor = '#f1f3f4';
                }
            }
        }
    }

    if (btnSaveSync) {
        btnSaveSync.addEventListener('click', async () => {
            const email = inputEmail.value.trim();
            const password = inputPassword.value.trim();
            const twoFactorCode = input2FA.value.trim();

            if (!email || !password) {
                statusText.textContent = 'Email and password are required.';
                statusText.style.color = '#b3261e';
                return;
            }

            statusText.textContent = 'Connecting and authenticating...';
            statusText.style.color = '#d97706';

            try {
                startSync({
                    email,
                    password,
                    twoFactorCode,
                    enabled: true
                });
                
                statusText.textContent = 'Sync enabled successfully!';
                statusText.style.color = '#15803d';
                
                setTimeout(() => {
                    settingsModal.style.display = 'none';
                }, 1000);
            } catch (err) {
                console.error("Login failed:", err);
                statusText.textContent = 'Sync connection failed. Check credentials.';
                statusText.style.color = '#b3261e';
            }
        });
    }

    if (btnDropdownSignout) {
        btnDropdownSignout.addEventListener('click', async () => {
            const settings = await getSyncSettings();
            settings.enabled = false;
            
            delete settings.username;
            delete settings.avatarURL;
            delete settings.apiKey;
            delete settings.masterKeys;
            delete settings.publicKey;
            delete settings.privateKey;
            delete settings.baseFolderUUID;
            delete settings.userId;
            delete settings.authVersion;
            delete settings.email;
            delete settings.password;
            delete settings.twoFactorCode;

            await saveSyncSettings(settings);
            stopSync();
            
            if (accountDropdown) {
                accountDropdown.style.display = 'none';
            }
            
            await loadSyncModalState();
        });
    }

    if (btnDropdownPurge) {
        btnDropdownPurge.addEventListener('click', async () => {
            if (confirm("Are you sure you want to delete all local document cache and sign out? This cannot be undone.")) {
                try {
                    if (accountDropdown) {
                        accountDropdown.style.display = 'none';
                    }
                    await destroyDatabase();
                } catch (err) {
                    console.error("Purging database failed:", err);
                    alert("Purging database failed. Try again.");
                }
            }
        });
    }

    // --- Sync Callback Handler ---
    function handleDBChange(change) {
        if (change.id === docId) {
            if (change.deleted) {
                alert("This document was deleted remotely. Redirecting...");
                window.location.href = window.location.pathname;
            } else {
                const doc = change.doc;
                if (doc.updatedAt > (currentDoc.updatedAt || 0)) {
                    currentDoc = doc;
                    renderDocument(doc);
                }
            }
        }
    }

    function handleSyncStatusChange(status) {
        const badge = document.getElementById('sync-status');
        if (!badge) return;
        const text = badge.querySelector('.sync-text');
        const icon = badge.querySelector('.material-symbols-outlined');

        if (!badge || !text || !icon) return;

        badge.className = `sync-badge ${status}`;
        
        if (status === 'online') {
            text.textContent = 'Online';
            icon.textContent = 'cloud_done';
            badge.title = 'Secure cloud sync is online';
        } else if (status === 'syncing') {
            text.textContent = 'Syncing...';
            icon.textContent = 'sync';
            badge.title = 'Reconciling changes with Filen';
        } else if (status === 'error') {
            text.textContent = 'Sync Error';
            icon.textContent = 'error';
            badge.title = 'Synchronization encountered an error';
        } else {
            text.textContent = 'Offline';
            icon.textContent = 'cloud_off';
            badge.title = 'Sync offline';
        }
    }

    registerCallbacks(null, handleSyncStatusChange);

    // --- Initialize ---
    (async () => {
        const syncSettings = await getSyncSettings();
        await loadSyncModalState();
        if (syncSettings && syncSettings.enabled) {
            startSync(syncSettings);
        }
        await initFonts(fontSelect);
        loadContent();
    })();
});

