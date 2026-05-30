import { state, getPages, findParentPage } from './state.js';

/**
 * Registers the document-level selectionchange listener.
 * Must be called once after the DOM is ready.
 */
export function initSelection() {
    document.addEventListener('selectionchange', saveSelection);
}

/**
 * Saves the current caret/selection range.
 */
export function saveSelection() {
    const sel = window.getSelection();
    if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (findParentPage(range.startContainer)) {
            state.lastSelectionRange = range.cloneRange();
        }
    }
}

/**
 * Restores the last saved selection, or focuses the start of the first page.
 */
export function restoreSelection() {
    if (state.lastSelectionRange) {
        const sel = window.getSelection();
        const page = findParentPage(state.lastSelectionRange.startContainer);
        if (page) page.focus();
        sel.removeAllRanges();
        sel.addRange(state.lastSelectionRange);
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

/**
 * Places the text caret cursor at the end of the specified element.
 * @param {HTMLElement} el 
 */
export function placeCursorAtEnd(el) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

/**
 * Inserts a temporary span marker at the current cursor position to save it.
 * @returns {HTMLSpanElement|null}
 */
export function saveCursor() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const marker = document.createElement('span');
    marker.id = '_scriben_cursor';
    marker.style.display = 'none';
    range.insertNode(marker);
    return marker;
}

/**
 * Restores the cursor position to the location of the temporary span marker,
 * and removes the marker.
 * @param {HTMLSpanElement} marker 
 */
export function restoreCursor(marker) {
    if (!marker || !marker.parentNode) return;
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(marker);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    marker.remove();
}
