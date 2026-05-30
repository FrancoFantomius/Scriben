import { state, getPages } from './state.js';

// ─── Toolbar UI References ───────────────────────────────────────────────────
let toolbarButtons  = null;
let fontSelect      = null;
let fontSizeSelect  = null;

/**
 * Caches frequently used toolbar DOM references.
 * Must be called once after the DOM is ready.
 */
export function initToolbarRefs() {
    toolbarButtons = document.querySelectorAll('.tool-button[data-command]');
    fontSelect     = document.getElementById('fontSelect');
    fontSizeSelect = document.getElementById('fontSizeSelect');
}

export function getToolbarButtons()  { return toolbarButtons; }
export function getFontSelect()      { return fontSelect; }
export function getFontSizeSelect()  { return fontSizeSelect; }

// ─── Active State ─────────────────────────────────────────────────────────────

/**
 * Reflects the current selection's formatting state onto toolbar button
 * active classes and font/size select values.
 */
export function updateActiveStates() {
    if (!toolbarButtons) return;
    toolbarButtons.forEach(btn => btn.classList.remove('active'));

    if (document.queryCommandState('bold'))      document.querySelector('[data-command="bold"]')?.classList.add('active');
    if (document.queryCommandState('italic'))    document.querySelector('[data-command="italic"]')?.classList.add('active');
    if (document.queryCommandState('underline')) document.querySelector('[data-command="underline"]')?.classList.add('active');

    // Sync font family dropdown
    if (fontSelect) {
        const currentFont = document.queryCommandValue('fontName');
        if (currentFont) {
            fontSelect.value = currentFont;
            if (!fontSelect.value) {
                const primaryFont = currentFont.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
                for (let i = 0; i < fontSelect.options.length; i++) {
                    const opt      = fontSelect.options[i];
                    const optPrimary = opt.value.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
                    if (optPrimary === primaryFont) {
                        fontSelect.selectedIndex = i;
                        break;
                    }
                }
            }
        }
    }

    // Sync font size dropdown
    if (fontSizeSelect) {
        const currentSize = document.queryCommandValue('fontSize');
        if (currentSize) {
            fontSizeSelect.value = currentSize;
        }
    }
}

// ─── Page Format ─────────────────────────────────────────────────────────────

const VALID_FORMATS = ['a4', 'a5', 'letter', 'legal'];

/**
 * Applies the given page format class to the pages container and updates
 * the checkmarks in the Format menu.
 * @param {string} format
 */
export function applyPageFormat(format) {
    if (!VALID_FORMATS.includes(format)) format = 'a4';

    const container = document.getElementById('pages-container');
    if (container) {
        VALID_FORMATS.forEach(f => container.classList.remove(`format-${f}`));
        container.classList.add(`format-${format}`);
    }

    VALID_FORMATS.forEach(f => {
        const check = document.getElementById(`format-${f}-check`);
        if (check) check.style.display = (f === format) ? 'block' : 'none';
    });

    state.currentDoc.pageFormat = format;
}

// ─── Font Family ─────────────────────────────────────────────────────────────

/**
 * Sets the font-family CSS property on all page elements and syncs the
 * font family dropdown selection.
 * @param {string} fontFamily
 */
export function applyFontFamily(fontFamily) {
    const pages = getPages();
    pages.forEach(page => {
        page.style.fontFamily = fontFamily;
    });
    state.currentDoc.fontFamily = fontFamily;

    if (fontSelect) {
        fontSelect.value = fontFamily;
        if (!fontSelect.value) {
            const primaryFont = fontFamily.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
            for (let i = 0; i < fontSelect.options.length; i++) {
                const opt      = fontSelect.options[i];
                const optPrimary = opt.value.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
                if (optPrimary === primaryFont) {
                    fontSelect.selectedIndex = i;
                    break;
                }
            }
        }
    }
}

// ─── Offline Menu ─────────────────────────────────────────────────────────────

/**
 * Updates the checkmark visibility next to the 'Offline use' menu item.
 * @param {boolean} isOffline
 */
export function updateOfflineMenuCheckmark(isOffline) {
    const check = document.getElementById('offline-check');
    if (check) check.style.display = isOffline ? 'block' : 'none';
}

// ─── Dropdown Menu ────────────────────────────────────────────────────────────

const DROPDOWN_DEFS = [
    { trigger: 'menu-file-trigger',   menu: 'file-dropdown' },
    { trigger: 'menu-edit-trigger',   menu: 'edit-dropdown' },
    { trigger: 'menu-view-trigger',   menu: 'view-dropdown' },
    { trigger: 'menu-insert-trigger', menu: 'insert-dropdown' },
    { trigger: 'menu-format-trigger', menu: 'format-dropdown' }
];

/**
 * Wires up click-outside and inter-dropdown toggle behaviour for all
 * menu-bar dropdowns.
 */
export function initDropdowns() {
    DROPDOWN_DEFS.forEach(({ trigger: triggerId, menu: menuId }) => {
        const trigger = document.getElementById(triggerId);
        const menu    = document.getElementById(menuId);
        if (trigger && menu) {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close all other open dropdowns
                DROPDOWN_DEFS.forEach(d => {
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

    document.addEventListener('click', closeAllDropdowns);
}

/**
 * Collapses every dropdown panel.
 */
export function closeAllDropdowns() {
    DROPDOWN_DEFS.forEach(d => {
        const m = document.getElementById(d.menu);
        if (m) m.style.display = 'none';
    });
}

/**
 * Returns the DROPDOWN_DEFS list so other modules can reference menu IDs.
 */
export function getDropdownDefs() {
    return DROPDOWN_DEFS;
}
