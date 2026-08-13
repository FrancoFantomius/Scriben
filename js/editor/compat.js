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

/**
 * Wires the File menu items (new document, offline toggle, PDF export, DOCX
 * export). Call once after the DOM is ready.
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
}