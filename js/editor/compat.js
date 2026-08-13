/**
 * compat.js — shared menu/file wiring.
 *
 * Hosts the File dropdown bindings shared by every import/export feature so
 * later milestones (M4/M5) can extend them in one place.
 */

import { state } from './state.js';
import { saveDocument } from '../sync.js';
import { updateOfflineMenuCheckmark } from './ui.js';
import { initDocxExport } from './docxExport.js';
import { handleDocxFile } from './docxImport.js';

/**
 * Wires the File menu items (new document, offline toggle, PDF export, DOCX
 * export/import). Call once after the DOM is ready.
 */
export function initCompat() {
    const fileDropdownEl = document.getElementById('file-dropdown');

    // ── New document ────────────────────────────────────────────────────────
    const newDocBtn = document.getElementById('menu-new-doc');
    if (newDocBtn) {
        newDocBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const newId = 'doc_' + crypto.randomUUID();
            window.location.href = `${window.location.pathname}?id=${newId}`;
        });
    }

    // ── Toggle offline ──────────────────────────────────────────────────────
    const toggleOfflineBtn = document.getElementById('menu-toggle-offline');
    if (toggleOfflineBtn) {
        toggleOfflineBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.currentDoc.offlineUse = (state.currentDoc.offlineUse !== false) ? false : true;
            await saveDocument(state.docId, state.currentDoc);
            updateOfflineMenuCheckmark(state.currentDoc.offlineUse);
            if (fileDropdownEl) fileDropdownEl.style.display = 'none';
        });
    }

    // ── Export as PDF (menu item → toolbar button) ──────────────────────────
    const exportPdfBtnMenu = document.getElementById('menu-export-pdf');
    const exportPdfBtn = document.getElementById('exportPdfBtn');
    if (exportPdfBtnMenu && exportPdfBtn) {
        exportPdfBtnMenu.addEventListener('click', (e) => {
            e.preventDefault();
            exportPdfBtn.click();
            if (fileDropdownEl) fileDropdownEl.style.display = 'none';
        });
    }

    // ── Export as Word (DOCX) ───────────────────────────────────────────────
    initDocxExport();

    // ── Import Word document (.docx) ────────────────────────────────────────
    const importDocxBtn = document.getElementById('menu-import-docx');
    const docxInput = document.createElement('input');
    docxInput.type = 'file';
    docxInput.id = 'docx-file-input';
    docxInput.accept = '.docx';
    docxInput.style.display = 'none';
    document.body.appendChild(docxInput);

    if (importDocxBtn) {
        importDocxBtn.addEventListener('click', (e) => {
            e.preventDefault();
            docxInput.click();
            if (fileDropdownEl) fileDropdownEl.style.display = 'none';
        });
    }

    docxInput.addEventListener('change', () => {
        const file = docxInput.files[0];
        if (file) handleDocxFile(file);
        docxInput.value = '';
    });

    // ── Drag & drop ─────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.id = 'docx-drop-overlay';
    overlay.className = 'drop-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML =
        '<div class="drop-overlay-inner">' +
        '<span class="material-symbols-outlined">upload_file</span>' +
        '<div class="drop-overlay-title">Drop your Word document</div>' +
        '</div>';
    document.body.appendChild(overlay);

    const showOverlay = () => { overlay.style.display = 'flex'; };
    const hideOverlay = () => { overlay.style.display = 'none'; };

    const onDragOver = (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        showOverlay();
    };

    ['dragover', 'drop'].forEach(ev => {
        window.addEventListener(ev, e => e.preventDefault());
        if (state.container) state.container.addEventListener(ev, e => e.preventDefault());
    });
    if (state.container) state.container.addEventListener('dragover', onDragOver);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', (e) => {
        if (e.target === document.body || e.target === overlay) hideOverlay();
    });
    window.addEventListener('drop', (e) => {
        hideOverlay();
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) handleDocxFile(file);
    });
}