import { state, getPages } from './state.js';
import { saveCursor, restoreCursor, placeCursorAtEnd } from './selection.js';
import { debouncedSaveContent } from './document.js';
import { updateActiveStates } from './ui.js';

/**
 * Temporarily allow overflow on a page to measure scroll vs client height.
 * @param {HTMLDivElement} page 
 * @returns {boolean} True if the content overflows the page bounds
 */
export function measureOverflow(page) {
    page.style.overflow = 'auto';
    const overflows = page.scrollHeight > page.clientHeight;
    page.style.overflow = '';
    return overflows;
}

/**
 * Finds the index of the child node where overflow starts.
 * @param {Node} container 
 * @param {HTMLDivElement} page 
 * @returns {number} Index of first overflowing child
 */
export function findOverflowIndex(container, page) {
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
    let result = children.length; // Default to length

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);

        // Temporarily remove children from mid + 1 to the end
        const detached = [];
        for (let i = mid + 1; i < children.length; i++) {
            detached.push({ node: children[i], nextSibling: children[i].nextSibling });
            children[i].remove();
        }

        const overflows = measureOverflow(page);

        // Re-attach detached children in reverse order
        for (let i = detached.length - 1; i >= 0; i--) {
            const { node, nextSibling } = detached[i];
            container.insertBefore(node, nextSibling);
        }

        if (overflows) {
            result = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    return result;
}

/**
 * Recursively splits a DOM node at the page overflow boundary.
 * @param {Node} node 
 * @param {HTMLDivElement} page 
 * @param {Node} nextContainer 
 * @param {boolean} isFirstOnPage 
 */
export function splitNode(node, page, nextContainer, isFirstOnPage) {
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
            return;
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

/**
 * Splits page contents moving overflow elements to the next page.
 * @param {HTMLDivElement} page 
 * @param {HTMLDivElement} next 
 */
export function splitPage(page, next) {
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

/**
 * Removes empty pages at the end of the document.
 */
export function cleanupEmptyPages() {
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

/**
 * Main pagination loop checking overflow on all pages.
 */
export function paginate() {
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

/**
 * Creates a new editor page element, applies doc styles, and binds events.
 * @returns {HTMLDivElement}
 */
export function createPage() {
    const page = document.createElement('div');
    page.className = 'page';
    page.contentEditable = 'true';
    page.spellcheck = false;
    if (state.currentDoc && state.currentDoc.fontFamily) {
        page.style.fontFamily = state.currentDoc.fontFamily;
    }
    state.container.appendChild(page);
    bindPageEvents(page);
    return page;
}

/**
 * Binds input and navigation events to a page.
 * @param {HTMLDivElement} page 
 */
export function bindPageEvents(page) {
    page.addEventListener('input', () => {
        const marker = saveCursor();
        paginate();
        restoreCursor(marker);
        debouncedSaveContent();
        updateActiveStates();
    });
    page.addEventListener('keyup', updateActiveStates);
    page.addEventListener('mouseup', updateActiveStates);

    page.addEventListener('keydown', (e) => {
        const pages = getPages();
        const idx = pages.indexOf(page);

        if (e.key === 'Backspace') {
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
