/**
 * Shared state for the Scriben Editor modules.
 */
export const state = {
    container: null,
    docId: null,
    currentDoc: {
        title: 'Untitled document',
        content: [],
        offlineUse: true,
        pageFormat: 'a4',
        fontFamily: "'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari', 'Noto Sans CJK TC', 'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', 'Noto Color Emoji', sans-serif",
        updatedAt: Date.now()
    },
    lastSelectionRange: null,
    activeLinkToEdit: null,
    hoveredLink: null,
    activeColorCommand: 'foreColor'
};

/**
 * Returns an array of all page elements in the workspace.
 * @returns {HTMLDivElement[]}
 */
export function getPages() {
    if (!state.container) return [];
    return Array.from(state.container.querySelectorAll('.page'));
}

/**
 * Traverses up the DOM to find the parent page element.
 * @param {Node} node 
 * @returns {HTMLDivElement|null}
 */
export function findParentPage(node) {
    while (node && !node.classList?.contains('page')) {
        node = node.parentNode;
    }
    return node;
}
