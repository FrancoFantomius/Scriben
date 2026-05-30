import { state } from './state.js';
import { exec } from './commands.js';

let colorPickerPopover = null;
let colorPickerTitle = null;
let colorPaletteGrid = null;
let btnCustomColor = null;
let nativeColorPicker = null;

const customPaletteColors = [
    '#000000', '#4a5568', '#718096', '#cbd5e0', '#ffffff',
    '#e53e3e', '#dd6b20', '#ecc94b', '#38a169', '#3182ce',
    '#805ad5', '#d53f8c', '#319795', '#2c5282', '#2f855a'
];

/**
 * Initialises the custom color picker popover and wires up all event listeners.
 */
export function initColorPicker() {
    colorPickerPopover = document.getElementById('color-picker-popover');
    colorPickerTitle   = document.getElementById('color-picker-title');
    colorPaletteGrid   = document.getElementById('color-palette-grid');
    btnCustomColor     = document.getElementById('btn-custom-color');
    nativeColorPicker  = document.getElementById('native-color-picker');

    if (colorPaletteGrid) {
        customPaletteColors.forEach(color => {
            const cell = document.createElement('div');
            cell.style.width           = '20px';
            cell.style.height          = '20px';
            cell.style.borderRadius    = '50%';
            cell.style.backgroundColor = color;
            cell.style.cursor          = 'pointer';
            cell.style.border          = '1px solid var(--color-toolbar-border)';
            cell.style.boxShadow       = 'inset 0 1px 2px rgba(0,0,0,0.1)';
            cell.style.transition      = 'transform 0.15s ease, border-color 0.15s ease';
            cell.title = color;

            cell.addEventListener('mouseover', () => {
                cell.style.transform   = 'scale(1.2)';
                cell.style.borderColor = 'var(--color-brand)';
            });
            cell.addEventListener('mouseout', () => {
                cell.style.transform   = 'scale(1)';
                cell.style.borderColor = 'var(--color-toolbar-border)';
            });

            cell.addEventListener('click', (e) => {
                e.stopPropagation();
                exec(state.activeColorCommand, color);
                hideColorPicker();
            });

            colorPaletteGrid.appendChild(cell);
        });
    }

    if (btnCustomColor && nativeColorPicker) {
        btnCustomColor.addEventListener('click', (e) => {
            e.stopPropagation();
            nativeColorPicker.click();
        });

        nativeColorPicker.addEventListener('change', (e) => {
            const color = e.target.value;
            exec(state.activeColorCommand, color);
            hideColorPicker();
        });
    }
}

/**
 * Shows the color picker popover anchored below the given button.
 * @param {HTMLElement} btn - The toolbar button that triggered the picker.
 * @param {string} command  - 'foreColor' or 'backColor'.
 */
export function showColorPicker(btn, command) {
    if (!colorPickerPopover) return;
    state.activeColorCommand = command;

    if (colorPickerTitle) {
        colorPickerTitle.textContent = command === 'foreColor' ? 'Text Color' : 'Highlight Color';
    }

    const rect = btn.getBoundingClientRect();
    colorPickerPopover.style.display = 'flex';
    colorPickerPopover.style.top  = `${rect.bottom + window.scrollY + 6}px`;
    colorPickerPopover.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 200)}px`;
}

/**
 * Hides the color picker popover.
 */
export function hideColorPicker() {
    if (colorPickerPopover) colorPickerPopover.style.display = 'none';
}

/**
 * Returns whether the color picker popover is currently visible.
 * @returns {boolean}
 */
export function isColorPickerVisible() {
    return colorPickerPopover && colorPickerPopover.style.display !== 'none';
}

/**
 * Returns the color picker popover element (used for outside-click detection).
 * @returns {HTMLElement|null}
 */
export function getColorPickerPopover() {
    return colorPickerPopover;
}
