import { getPages, findParentPage } from './state.js';
import { restoreSelection } from './selection.js';
import { updateActiveStates } from './ui.js';
import { paginate } from './pagination.js';
import { saveContent } from './document.js';

/**
 * Returns the page element that currently contains the user's cursor/selection,
 * or the last page as a fallback.
 * @returns {HTMLDivElement}
 */
export function getActivePage() {
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

/**
 * Executes a formatting command on the document. Handles multi-page
 * selections cleanly by dividing the command execution across page boundaries.
 * @param {string} command The document command to execute (e.g. 'bold', 'insertHTML')
 * @param {any} value Optional value parameter for the command
 */
export const exec = (command, value = null) => {
    restoreSelection();
    const sel = window.getSelection();
    const pages = getPages();

    let multiPage = false;
    if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const startPage = findParentPage(range.startContainer);
        const endPage = findParentPage(range.endContainer);

        if (startPage && endPage && startPage !== endPage) {
            multiPage = true;
            const startIdx = pages.indexOf(startPage);
            const endIdx = pages.indexOf(endPage);
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
    requestAnimationFrame(() => {
        paginate();
        saveContent();
    });
};
