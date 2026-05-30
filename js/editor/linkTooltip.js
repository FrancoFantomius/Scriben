import { state } from './state.js';
import { openLinkModal } from './modals.js';
import { paginate } from './pagination.js';
import { saveContent } from './document.js';

let linkTooltip   = null;
let linkTooltipUrl   = null;
let linkTooltipEdit  = null;
let linkTooltipRemove = null;

/**
 * Initialises the floating link tooltip and wires up its action buttons.
 * Must be called after DOM is ready.
 */
export function initLinkTooltip() {
    linkTooltip       = document.getElementById('link-tooltip');
    linkTooltipUrl    = document.getElementById('link-tooltip-url');
    linkTooltipEdit   = document.getElementById('link-tooltip-edit');
    linkTooltipRemove = document.getElementById('link-tooltip-remove');

    if (linkTooltipEdit) {
        linkTooltipEdit.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state.hoveredLink) {
                openLinkModal(state.hoveredLink);
            }
            hideLinkTooltip();
        });
    }

    if (linkTooltipRemove) {
        linkTooltipRemove.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state.hoveredLink) {
                const textNode = document.createTextNode(state.hoveredLink.textContent);
                state.hoveredLink.replaceWith(textNode);
                paginate();
                saveContent();
            }
            hideLinkTooltip();
        });
    }
}

/**
 * Inspects the event target (and its ancestors) for an anchor element.
 * Shows the tooltip if one is found, otherwise hides it.
 * @param {MouseEvent|KeyboardEvent} e
 */
export function checkLinkTooltip(e) {
    let node = e.target;
    const container = state.container;
    while (node && node !== container && !node.classList?.contains('page')) {
        if (node.tagName === 'A') {
            showLinkTooltip(node);
            return;
        }
        node = node.parentNode;
    }
    hideLinkTooltip();
}

/**
 * Positions and shows the floating tooltip anchored below an anchor element.
 * @param {HTMLAnchorElement} anchor
 */
export function showLinkTooltip(anchor) {
    if (!linkTooltip || !linkTooltipUrl) return;
    state.hoveredLink = anchor;

    const href = anchor.getAttribute('href') || '#';
    linkTooltipUrl.href        = href;
    linkTooltipUrl.textContent = href;

    const rect = anchor.getBoundingClientRect();
    linkTooltip.style.display = 'flex';
    linkTooltip.style.top  = `${rect.bottom + window.scrollY + 6}px`;
    linkTooltip.style.left = `${rect.left  + window.scrollX}px`;
}

/**
 * Hides the floating link tooltip.
 */
export function hideLinkTooltip() {
    if (linkTooltip) linkTooltip.style.display = 'none';
    state.hoveredLink = null;
}

/**
 * Returns whether the link tooltip is currently visible.
 * @returns {boolean}
 */
export function isLinkTooltipVisible() {
    return linkTooltip && linkTooltip.style.display !== 'none';
}

/**
 * Returns the tooltip element (used for outside-click detection).
 * @returns {HTMLElement|null}
 */
export function getLinkTooltipEl() {
    return linkTooltip;
}
