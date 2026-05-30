/**
 * main.js — Scriben Editor entry point.
 *
 * Imports all feature modules and wires them together once the DOM is ready.
 */

import {
    setActiveDocId,
    registerCallbacks,
    getSyncSettings,
    saveSyncSettings,
    saveDocument,
    startSync,
    stopSync,
    destroyDatabase
} from '../sync.js';
import { initFonts } from '../options.js';

// Editor sub-modules
import { state, getPages } from './state.js';
import { initSelection } from './selection.js';
import { paginate, createPage, bindPageEvents } from './pagination.js';
import { exec, getActivePage } from './commands.js';
import {
    getActiveDocumentId,
    saveContent,
    debouncedSaveContent,
    loadContent,
    handleSyncStatusChange,
    loadSyncModalState,
    updateOfflineMenuCheckmark
} from './document.js';
import { exportPdf, initPdfExport } from './pdf.js';
import { applyAppTheme } from './theme.js';
import { initModals, openLinkModal, openTableModal } from './modals.js';
import { initColorPicker, showColorPicker, hideColorPicker, getColorPickerPopover, isColorPickerVisible } from './colorPicker.js';
import { initLinkTooltip, checkLinkTooltip, hideLinkTooltip, getLinkTooltipEl, isLinkTooltipVisible } from './linkTooltip.js';
import {
    initToolbarRefs,
    initDropdowns,
    closeAllDropdowns,
    updateActiveStates,
    applyPageFormat,
    applyFontFamily,
    getFontSelect,
    getFontSizeSelect,
    getToolbarButtons
} from './ui.js';

document.addEventListener('DOMContentLoaded', async () => {
    localStorage.setItem('scriben-has-used', 'true');

    // ── Bootstrap shared state ──────────────────────────────────────────────
    state.container = document.getElementById('pages-container');

    // Resolve and register document ID
    const docId = getActiveDocumentId();
    state.docId = docId;
    setActiveDocId(docId);

    // ── Init UI sub-systems ─────────────────────────────────────────────────
    initToolbarRefs();
    initDropdowns();
    initSelection();
    initModals();
    initColorPicker();
    initLinkTooltip();

    // ── Toolbar command bindings ────────────────────────────────────────────
    const toolbarButtons = getToolbarButtons();
    toolbarButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const cmd = btn.dataset.command;
            if (cmd === 'formatBlock') {
                exec(cmd, btn.dataset.value);
            } else if (cmd === 'createLink') {
                openLinkModal();
            } else if (cmd === 'foreColor' || cmd === 'backColor') {
                showColorPicker(btn, cmd);
            } else {
                exec(cmd);
            }
        });
    });

    // ── Font family / size selects ──────────────────────────────────────────
    const fontSelect = getFontSelect();
    const fontSizeSelect = getFontSizeSelect();

    if (fontSelect) {
        fontSelect.addEventListener('change', () => {
            const selectedValue = fontSelect.value;
            const sel = window.getSelection();
            if (sel.rangeCount > 0 && !sel.isCollapsed) {
                exec('fontName', selectedValue);
            } else {
                applyFontFamily(selectedValue);
                saveContent();
            }
        });
    }

    if (fontSizeSelect) {
        fontSizeSelect.addEventListener('change', () => {
            exec('fontSize', fontSizeSelect.value);
        });
    }

    // Font size ± buttons
    const btnFontDecrease = document.getElementById('btn-font-decrease');
    const btnFontIncrease = document.getElementById('btn-font-increase');

    if (btnFontDecrease) {
        btnFontDecrease.addEventListener('click', () => {
            const currentSizeVal = document.queryCommandValue('fontSize');
            let currentSize = parseInt(currentSizeVal) || 4;
            if (!currentSizeVal && fontSizeSelect) currentSize = parseInt(fontSizeSelect.value) || 4;
            if (currentSize < 1 || currentSize > 7) currentSize = 4;
            const newSize = Math.max(1, currentSize - 1);
            exec('fontSize', newSize);
            if (fontSizeSelect) fontSizeSelect.value = newSize;
        });
    }

    if (btnFontIncrease) {
        btnFontIncrease.addEventListener('click', () => {
            const currentSizeVal = document.queryCommandValue('fontSize');
            let currentSize = parseInt(currentSizeVal) || 4;
            if (!currentSizeVal && fontSizeSelect) currentSize = parseInt(fontSizeSelect.value) || 4;
            if (currentSize < 1 || currentSize > 7) currentSize = 4;
            const newSize = Math.min(7, currentSize + 1);
            exec('fontSize', newSize);
            if (fontSizeSelect) fontSizeSelect.value = newSize;
        });
    }

    // ── Image insertion ─────────────────────────────────────────────────────
    const imageInput = document.getElementById('imageInput');
    const imageBtn = document.getElementById('imageBtn');

    if (imageBtn && imageInput) {
        imageBtn.addEventListener('click', () => imageInput.click());
        imageInput.addEventListener('change', () => {
            const file = imageInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = e => exec('insertImage', e.target.result);
            reader.readAsDataURL(file);
            imageInput.value = '';
        });
    }

    // ── Page break button ───────────────────────────────────────────────────
    const pageBreakBtn = document.getElementById('pageBreakBtn');
    if (pageBreakBtn) {
        pageBreakBtn.addEventListener('click', () => {
            exec('insertHTML', '<div class="page-break unbreakable" contenteditable="false"></div>');
        });
    }

    // ── PDF export button ───────────────────────────────────────────────────
    initPdfExport();

    // ── Global outside-click: close color picker & link tooltip ────────────
    document.addEventListener('mousedown', (e) => {
        if (isLinkTooltipVisible()) {
            const tooltipEl = getLinkTooltipEl();
            if (!tooltipEl.contains(e.target) && !state.container.contains(e.target)) {
                hideLinkTooltip();
            }
        }
        if (isColorPickerVisible()) {
            const popoverEl = getColorPickerPopover();
            if (!popoverEl.contains(e.target)) {
                hideColorPicker();
            }
        }
    });

    // ── Link tooltip on container events ───────────────────────────────────
    state.container.addEventListener('click', checkLinkTooltip);
    state.container.addEventListener('keyup', checkLinkTooltip);

    // ── Select All across pages (Ctrl+A) ────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            const pages = getPages();
            if (pages.length <= 1) return;
            e.preventDefault();
            const first = pages[0];
            const last = pages[pages.length - 1];
            const sel = window.getSelection();
            const range = document.createRange();
            range.setStartBefore(first.firstChild || first);
            range.setEndAfter(last.lastChild || last);
            sel.removeAllRanges();
            sel.addRange(range);
        }
    });

    // ── Edit menu items ─────────────────────────────────────────────────────
    const tryClipboardCommand = (cmd) => {
        try {
            const success = document.execCommand(cmd);
            if (!success) {
                alert(`Browser blocked clipboard '${cmd}'. Please use keyboard shortcut.`);
            }
        } catch {
            alert(`Browser blocked clipboard '${cmd}'. Please use keyboard shortcut.`);
        }
    };

    const bindMenuItem = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', (e) => { e.preventDefault(); handler(); closeAllDropdowns(); });
    };

    bindMenuItem('menu-edit-undo', () => exec('undo'));
    bindMenuItem('menu-edit-redo', () => exec('redo'));
    bindMenuItem('menu-edit-cut', () => tryClipboardCommand('cut'));
    bindMenuItem('menu-edit-copy', () => tryClipboardCommand('copy'));
    bindMenuItem('menu-edit-paste', () => tryClipboardCommand('paste'));
    bindMenuItem('menu-edit-selectall', () => {
        const pages = getPages();
        if (pages.length > 0) {
            const first = pages[0];
            const last = pages[pages.length - 1];
            const sel = window.getSelection();
            const range = document.createRange();
            range.setStartBefore(first.firstChild || first);
            range.setEndAfter(last.lastChild || last);
            sel.removeAllRanges();
            sel.addRange(range);
        }
    });

    // ── Insert menu items ───────────────────────────────────────────────────
    bindMenuItem('menu-insert-image', () => { const i = document.getElementById('imageInput'); if (i) i.click(); });
    bindMenuItem('menu-insert-link', () => openLinkModal());
    bindMenuItem('menu-insert-table', () => openTableModal());
    bindMenuItem('menu-insert-hr', () => exec('insertHorizontalRule'));
    bindMenuItem('menu-insert-pagebreak', () => exec('insertHTML', '<div class="page-break unbreakable" contenteditable="false"></div>'));

    // ── Page format menu items ──────────────────────────────────────────────
    ['a4', 'letter', 'legal', 'a5'].forEach(f => {
        bindMenuItem(`menu-format-${f}`, () => {
            applyPageFormat(f);
            paginate();
            saveContent();
        });
    });

    // ── Theme menu items ────────────────────────────────────────────────────
    bindMenuItem('menu-theme-auto', () => applyAppTheme('auto'));
    bindMenuItem('menu-theme-light', () => applyAppTheme('light'));
    bindMenuItem('menu-theme-dark', () => applyAppTheme('dark'));

    // ── File menu items ─────────────────────────────────────────────────────
    const newDocBtn = document.getElementById('menu-new-doc');
    if (newDocBtn) {
        newDocBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const newId = 'doc_' + crypto.randomUUID();
            window.location.href = `${window.location.pathname}?id=${newId}`;
        });
    }

    const toggleOfflineBtn = document.getElementById('menu-toggle-offline');
    const fileDropdownEl = document.getElementById('file-dropdown');
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

    const exportPdfBtnMenu = document.getElementById('menu-export-pdf');
    const exportPdfBtn = document.getElementById('exportPdfBtn');
    if (exportPdfBtnMenu && exportPdfBtn) {
        exportPdfBtnMenu.addEventListener('click', (e) => {
            e.preventDefault();
            exportPdfBtn.click();
            if (fileDropdownEl) fileDropdownEl.style.display = 'none';
        });
    }

    // ── Document title auto-save ─────────────────────────────────────────────
    const documentTitleInput = document.getElementById('document-title');
    if (documentTitleInput) {
        documentTitleInput.addEventListener('input', debouncedSaveContent);
    }

    // ── Settings / Sync modal ───────────────────────────────────────────────
    const btnSyncLogin = document.getElementById('btn-sync-login');
    const btnSyncProfile = document.getElementById('btn-sync-profile');
    const settingsModal = document.getElementById('settings-modal');
    const btnSaveSyncCancel = document.getElementById('btn-save-sync-cancel');
    const btnSaveSync = document.getElementById('btn-save-sync');
    const accountDropdown = document.getElementById('account-dropdown');
    const btnDropdownSignout = document.getElementById('btn-dropdown-signout');
    const btnDropdownPurge = document.getElementById('btn-dropdown-purge');

    if (btnSyncLogin && settingsModal) {
        btnSyncLogin.addEventListener('click', async () => {
            settingsModal.style.display = 'flex';
            await loadSyncModalState();
        });
    }

    if (btnSyncProfile && accountDropdown) {
        btnSyncProfile.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = accountDropdown.style.display === 'flex' || accountDropdown.style.display === 'block';
            accountDropdown.style.display = isVisible ? 'none' : 'flex';
        });
    }

    // Close account dropdown on outside click
    document.addEventListener('click', (e) => {
        if (accountDropdown && accountDropdown.style.display !== 'none') {
            if (!accountDropdown.contains(e.target) && (!btnSyncProfile || !btnSyncProfile.contains(e.target))) {
                accountDropdown.style.display = 'none';
            }
        }
    });

    if (btnSaveSyncCancel && settingsModal) {
        btnSaveSyncCancel.addEventListener('click', () => {
            settingsModal.style.display = 'none';
        });
    }

    if (btnSaveSync) {
        btnSaveSync.addEventListener('click', async () => {
            const inputEmail = document.getElementById('sync-email');
            const inputPassword = document.getElementById('sync-password');
            const input2FA = document.getElementById('sync-twofactor');
            const statusText = document.getElementById('sync-settings-status');

            const email = inputEmail?.value.trim() || '';
            const password = inputPassword?.value.trim() || '';
            const twoFactorCode = input2FA?.value.trim() || '';

            if (!email || !password) {
                if (statusText) { statusText.textContent = 'Email and password are required.'; statusText.style.color = '#b3261e'; }
                return;
            }

            if (statusText) { statusText.textContent = 'Connecting and authenticating...'; statusText.style.color = '#d97706'; }

            try {
                startSync({ email, password, twoFactorCode, enabled: true });
                if (statusText) { statusText.textContent = 'Sync enabled successfully!'; statusText.style.color = '#15803d'; }
                setTimeout(() => { if (settingsModal) settingsModal.style.display = 'none'; }, 1000);
            } catch (err) {
                console.error('Login failed:', err);
                if (statusText) { statusText.textContent = 'Sync connection failed. Check credentials.'; statusText.style.color = '#b3261e'; }
            }
        });
    }

    if (btnDropdownSignout) {
        btnDropdownSignout.addEventListener('click', async () => {
            const settings = await getSyncSettings();
            settings.enabled = false;
            ['username', 'avatarURL', 'apiKey', 'masterKeys', 'publicKey', 'privateKey',
                'baseFolderUUID', 'userId', 'authVersion', 'email', 'password', 'twoFactorCode']
                .forEach(k => delete settings[k]);

            await saveSyncSettings(settings);
            stopSync();
            if (accountDropdown) accountDropdown.style.display = 'none';
            await loadSyncModalState();
        });
    }

    if (btnDropdownPurge) {
        btnDropdownPurge.addEventListener('click', async () => {
            if (confirm('Are you sure you want to delete all local document cache and sign out? This cannot be undone.')) {
                try {
                    if (accountDropdown) accountDropdown.style.display = 'none';
                    await destroyDatabase();
                } catch (err) {
                    console.error('Purging database failed:', err);
                    alert('Purging database failed. Try again.');
                }
            }
        });
    }

    // ── Sync callbacks ──────────────────────────────────────────────────────
    registerCallbacks(null, handleSyncStatusChange);

    // ── Initialization sequence ─────────────────────────────────────────────
    const syncSettings = await getSyncSettings();
    await loadSyncModalState();

    if (syncSettings?.enabled) {
        startSync(syncSettings);
    }

    await initFonts(fontSelect);

    // Apply stored theme
    const currentTheme = localStorage.getItem('scriben-theme') || 'auto';
    applyAppTheme(currentTheme);

    // Load document content
    await loadContent();
});
