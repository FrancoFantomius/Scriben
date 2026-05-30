import { state } from './state.js';
import { exec } from './commands.js';
import { paginate } from './pagination.js';
import { saveContent } from './document.js';

let linkModal = null;
let linkUrlInput = null;
let linkTextInput = null;
let btnLinkCancel = null;
let btnLinkInsert = null;

let tableModal = null;
let tableRowsInput = null;
let tableColsInput = null;
let btnTableCancel = null;
let btnTableInsert = null;

/**
 * Initializes dialog variables and registers listeners.
 */
export function initModals() {
    linkModal = document.getElementById('link-modal');
    linkUrlInput = document.getElementById('link-url');
    linkTextInput = document.getElementById('link-text');
    btnLinkCancel = document.getElementById('btn-link-cancel');
    btnLinkInsert = document.getElementById('btn-link-insert');

    tableModal = document.getElementById('table-modal');
    tableRowsInput = document.getElementById('table-rows');
    tableColsInput = document.getElementById('table-cols');
    btnTableCancel = document.getElementById('btn-table-cancel');
    btnTableInsert = document.getElementById('btn-table-insert');

    if (btnLinkCancel) {
        btnLinkCancel.addEventListener('click', closeLinkModal);
    }

    if (btnLinkInsert) {
        btnLinkInsert.addEventListener('click', () => {
            const url = linkUrlInput.value.trim();
            const text = linkTextInput.value.trim();
            closeLinkModal();

            if (url && url !== 'https://') {
                if (state.activeLinkToEdit) {
                    state.activeLinkToEdit.setAttribute('href', url);
                    state.activeLinkToEdit.textContent = text || url;
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
}

/**
 * Shows the Link dialog, optionally pre-populating inputs for an existing anchor.
 * @param {HTMLAnchorElement|null} linkToEdit 
 */
export function openLinkModal(linkToEdit = null) {
    if (!linkModal) return;
    state.activeLinkToEdit = linkToEdit;

    let selectedText = '';
    const sel = window.getSelection();
    if (sel.rangeCount > 0) {
        selectedText = sel.toString().trim();
    }

    if (state.activeLinkToEdit) {
        if (linkUrlInput) linkUrlInput.value = state.activeLinkToEdit.getAttribute('href') || '';
        if (linkTextInput) linkTextInput.value = state.activeLinkToEdit.textContent || '';
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

export function closeLinkModal() {
    if (linkModal) linkModal.style.display = 'none';
    state.activeLinkToEdit = null;
}

/**
 * Shows the Grid/Table insertion dialog.
 */
export function openTableModal() {
    if (tableModal && tableRowsInput && tableColsInput) {
        tableRowsInput.value = '3';
        tableColsInput.value = '3';
        tableModal.style.display = 'flex';
        tableRowsInput.focus();
    }
}

export function closeTableModal() {
    if (tableModal) tableModal.style.display = 'none';
}
