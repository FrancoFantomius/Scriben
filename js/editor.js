// Scriben WYSIWYG Editor
// A4 pagination, toolbar commands, font switching,
// image insertion, PDF export, PouchDB database sync.

import { 
    setActiveDocId,
    registerCallbacks,
    getSyncSettings,
    saveSyncSettings,
    saveDocument,
    getDocument,
    startSync,
    stopSync,
    destroyDatabase
} from './sync.js';

document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('pages-container');
    const toolbarButtons = document.querySelectorAll('.tool-button[data-command]');
    const fontSelect = document.getElementById('fontSelect');
    const fontSizeSelect = document.getElementById('fontSizeSelect');
    const imageInput = document.getElementById('imageInput');
    const imageBtn = document.getElementById('imageBtn');
    const exportPdfBtn = document.getElementById('exportPdfBtn');

    // A4 content height in px (297mm - 2 × 25.4mm margins = 246.2mm)
    // 1mm ≈ 3.7795px at 96dpi → 246.2mm ≈ 930px
    const PAGE_CONTENT_HEIGHT = 930;

    // --- Page helpers ---
    function getPages() {
        return Array.from(container.querySelectorAll('.page'));
    }

    function createPage() {
        const page = document.createElement('div');
        page.className = 'page';
        page.contentEditable = 'true';
        page.spellcheck = true;
        container.appendChild(page);
        bindPageEvents(page);
        return page;
    }

    function getActivePage() {
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

    function findParentPage(node) {
        while (node && !node.classList?.contains('page')) {
            node = node.parentNode;
        }
        return node;
    }

    // --- Overflow detection & pagination ---
    function checkOverflow() {
        const pages = getPages();
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];

            let next = pages[i + 1];
            if (!next && page.scrollHeight > page.clientHeight) {
                next = createPage();
                pages.push(next);
            }

            while (page.scrollHeight > page.clientHeight && page.childNodes.length > 0) {
                const lastChild = page.lastChild;

                if (lastChild.nodeType === Node.TEXT_NODE) {
                    const words = lastChild.textContent.split(/(\s+)/);
                    const movedText = [];
                    while (words.length > 0 && page.scrollHeight > page.clientHeight) {
                        movedText.unshift(words.pop());
                        lastChild.textContent = words.join('');
                    }
                    if (movedText.length > 0) {
                        const newTextNode = document.createTextNode(movedText.join(''));
                        next.insertBefore(newTextNode, next.firstChild);
                    }
                    if (lastChild.textContent === '') lastChild.remove();
                    continue;
                }

                if (lastChild.nodeType === Node.ELEMENT_NODE) {
                    // Do not split unbreakable elements
                    if (['IMG', 'BR', 'HR', 'TABLE'].includes(lastChild.tagName)) {
                        next.insertBefore(lastChild, next.firstChild);
                        continue;
                    }

                    let targetNode = next.firstChild;
                    // Only reuse targetNode if it's specifically marked as a split continuation
                    if (!targetNode || targetNode.tagName !== lastChild.tagName || !targetNode.hasAttribute('data-split')) {
                        targetNode = lastChild.cloneNode(false);
                        targetNode.setAttribute('data-split', 'true');
                        next.insertBefore(targetNode, next.firstChild);
                    }

                    let splitHappened = false;
                    while (lastChild.childNodes.length > 0 && page.scrollHeight > page.clientHeight) {
                        const innerLast = lastChild.lastChild;

                        if (innerLast.nodeType === Node.TEXT_NODE) {
                            const words = innerLast.textContent.split(/(\s+)/);
                            const movedText = [];

                            while (words.length > 0 && page.scrollHeight > page.clientHeight) {
                                movedText.unshift(words.pop());
                                innerLast.textContent = words.join('');
                            }

                            if (movedText.length > 0) {
                                const newTextNode = document.createTextNode(movedText.join(''));
                                targetNode.insertBefore(newTextNode, targetNode.firstChild);
                                splitHappened = true;
                            }
                            if (innerLast.textContent === '') innerLast.remove();
                        } else {
                            targetNode.insertBefore(innerLast, targetNode.firstChild);
                            splitHappened = true;
                        }
                    }

                    if (lastChild.childNodes.length === 0) {
                        lastChild.remove();
                    } else if (!splitHappened) {
                        // Could not split further (e.g. single giant word)
                        next.insertBefore(lastChild, next.firstChild);
                        // If we moved the whole thing, remove the empty targetNode we created
                        if (targetNode.childNodes.length === 0) {
                            targetNode.remove();
                        }
                    }
                } else {
                    next.insertBefore(lastChild, next.firstChild);
                }
            }
        }
        // Clean up empty trailing pages (keep at least one)
        const updated = getPages();
        for (let i = updated.length - 1; i > 0; i--) {
            if (updated[i].innerHTML.trim() === '') {
                updated[i].remove();
            } else {
                break;
            }
        }
    }

    // --- Pull content back up when deleting ---
    function checkUnderflow() {
        const pages = getPages();
        for (let i = 0; i < pages.length - 1; i++) {
            const page = pages[i];
            const next = pages[i + 1];
            // Try pulling content from the next page into this page
            while (next.firstChild && page.scrollHeight <= page.clientHeight) {
                const child = next.firstChild;

                // Check if we can merge it with page.lastChild
                const lastChild = page.lastChild;
                if (lastChild && lastChild.nodeType === Node.ELEMENT_NODE &&
                    child.nodeType === Node.ELEMENT_NODE &&
                    lastChild.tagName === child.tagName) {

                    // Merge children
                    while (child.firstChild) {
                        lastChild.appendChild(child.firstChild);
                    }
                    child.remove();

                    // Normalize to combine adjacent text nodes
                    lastChild.normalize();
                } else {
                    page.appendChild(child);
                }

                if (page.scrollHeight > page.clientHeight) {
                    break;
                }
            }
        }
        // Clean up empty trailing pages
        const updated = getPages();
        for (let i = updated.length - 1; i > 0; i--) {
            if (updated[i].innerHTML.trim() === '') {
                updated[i].remove();
            } else {
                break;
            }
        }
    }

    // --- Bind events on each page ---
    function saveCursor() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return null;
        const range = sel.getRangeAt(0);
        const marker = document.createElement('span');
        marker.id = '_scriben_cursor';
        marker.style.display = 'none';
        range.insertNode(marker);
        return marker;
    }

    function restoreCursor(marker) {
        if (!marker || !marker.parentNode) return;
        const sel = window.getSelection();
        const range = document.createRange();
        range.setStartAfter(marker);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        marker.remove();
    }

    function bindPageEvents(page) {
        page.addEventListener('input', () => {
            const marker = saveCursor();
            checkOverflow();
            checkUnderflow();
            restoreCursor(marker);
            saveContent();
            updateActiveStates();
        });
        page.addEventListener('keyup', updateActiveStates);
        page.addEventListener('mouseup', updateActiveStates);

        // Navigate between pages with arrow keys
        page.addEventListener('keydown', (e) => {
            const pages = getPages();
            const idx = pages.indexOf(page);

            if (e.key === 'Backspace') {
                // If at start of a non-first page and it's empty, move to previous
                const sel = window.getSelection();
                if (idx > 0 && sel.anchorOffset === 0 && page.textContent === '') {
                    e.preventDefault();
                    page.remove();
                    const prev = pages[idx - 1];
                    placeCursorAtEnd(prev);
                    saveContent();
                }
            }
        });
    }

    function placeCursorAtEnd(el) {
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    // --- Persistence & Sync ---
    const STORAGE_KEY = 'scriben-wysiwyg-content';
    
    // --- Document ID routing ---
    function getActiveDocumentId() {
        const params = new URLSearchParams(window.location.search);
        let id = params.get('id');
        if (!id) {
            id = localStorage.getItem('scriben-active-doc-id');
        }
        if (!id) {
            id = 'doc_' + crypto.randomUUID();
            params.set('id', id);
            window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
        }
        localStorage.setItem('scriben-active-doc-id', id);
        return id;
    }
    
    const docId = getActiveDocumentId();
    setActiveDocId(docId);

    let currentDoc = {
        title: 'Untitled document',
        content: [],
        offlineUse: true,
        updatedAt: Date.now()
    };

    async function saveContent() {
        const pages = getPages();
        const data = pages.map(p => p.innerHTML);
        const titleInput = document.getElementById('document-title');
        const title = titleInput ? titleInput.value.trim() : 'Untitled document';

        currentDoc.title = title || 'Untitled document';
        currentDoc.content = data;
        currentDoc.updatedAt = Date.now();

        try {
            await saveDocument(docId, currentDoc);
        } catch (err) {
            console.error("Failed to save content to PouchDB:", err);
        }
    }

    async function loadContent() {
        try {
            let doc;
            try {
                doc = await getDocument(docId);
            } catch (err) {
                if (err.status === 404) {
                    doc = null;
                } else {
                    throw err;
                }
            }

            if (!doc) {
                const legacyRaw = localStorage.getItem(STORAGE_KEY);
                let contentData = [];
                if (legacyRaw) {
                    try {
                        const parsed = JSON.parse(legacyRaw);
                        if (Array.isArray(parsed)) contentData = parsed;
                    } catch {
                        contentData = [legacyRaw];
                    }
                    localStorage.removeItem(STORAGE_KEY);
                }

                doc = {
                    title: 'Untitled document',
                    content: contentData,
                    offlineUse: true,
                    updatedAt: Date.now()
                };
                await saveDocument(docId, doc);
            }

            currentDoc = doc;
            renderDocument(doc);
        } catch (err) {
            console.error("Failed to load content from PouchDB:", err);
        }
    }

    function renderDocument(doc) {
        const titleInput = document.getElementById('document-title');
        if (titleInput) {
            titleInput.value = doc.title || 'Untitled document';
        }

        if (doc.content && Array.isArray(doc.content) && doc.content.length > 0) {
            container.innerHTML = '';
            doc.content.forEach(html => {
                const page = createPage();
                page.innerHTML = html;
            });
        } else {
            container.innerHTML = '';
            createPage();
        }

        updateOfflineMenuCheckmark(doc.offlineUse !== false);
    }

    // --- Toolbar Command Execution ---
    const exec = (command, value = null) => {
        const sel = window.getSelection();
        const pages = getPages();

        // Check if the selection spans multiple pages
        let multiPage = false;
        if (sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const startPage = findParentPage(range.startContainer);
            const endPage = findParentPage(range.endContainer);

            if (startPage && endPage && startPage !== endPage) {
                multiPage = true;
                const startIdx = pages.indexOf(startPage);
                const endIdx = pages.indexOf(endPage);
                // Save boundary info before we manipulate selections
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

                // Restore cross-page selection so it stays visible
                // and subsequent commands continue to work across all pages
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
        // Re-check pagination after formatting changes
        requestAnimationFrame(() => {
            checkOverflow();
            checkUnderflow();
            saveContent();
        });
    };

    toolbarButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const cmd = btn.dataset.command;
            if (cmd === 'formatBlock') {
                exec(cmd, btn.dataset.value);
            } else if (cmd === 'createLink') {
                const url = prompt('Enter URL', 'https://');
                if (url) exec(cmd, url);
            } else if (cmd === 'foreColor' || cmd === 'backColor') {
                const color = prompt('Enter hex color (e.g., #ff0000)', '#');
                if (color) exec(cmd, color);
            } else {
                exec(cmd);
            }
        });
    });

    // --- Font Family & Size ---
    fontSelect.addEventListener('change', () => {
        exec('fontName', fontSelect.value);
    });
    fontSizeSelect.addEventListener('change', () => {
        exec('fontSize', fontSizeSelect.value);
    });

    // --- Image Insertion ---
    imageBtn.addEventListener('click', () => {
        imageInput.click();
    });
    imageInput.addEventListener('change', () => {
        const file = imageInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            exec('insertImage', e.target.result);
        };
        reader.readAsDataURL(file);
        imageInput.value = '';
    });

    // --- PDF Export ---
    // Dynamically load a script and return a promise
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) {
                resolve();
                return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(s);
        });
    }

    async function ensurePdfLibs() {
        const libs = [
            'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
            'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js'
        ];
        for (const src of libs) {
            await loadScript(src);
        }
    }

    exportPdfBtn.addEventListener('click', async () => {
        // Disable button & show feedback
        exportPdfBtn.disabled = true;
        const icon = exportPdfBtn.querySelector('.material-symbols-outlined');
        const origIcon = icon.textContent;
        icon.textContent = 'hourglass_empty';

        try {
            await ensurePdfLibs();
            await generatePdf();
        } catch (err) {
            console.error('PDF export failed:', err);
            alert('PDF export failed. Check the console for details.');
        } finally {
            exportPdfBtn.disabled = false;
            icon.textContent = origIcon;
        }
    });

    async function generatePdf() {
        const { jsPDF } = window.jspdf;
        // A4 dimensions in mm
        const pageWidthMM = 210;
        const pageHeightMM = 297;

        const pdf = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4',
            compress: true
        });

        const pages = getPages();

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];

            // Render each page element to a high-resolution canvas
            const canvas = await html2canvas(page, {
                scale: 2,                  // 2× resolution for crisp text
                useCORS: true,             // allow cross-origin images
                allowTaint: true,
                backgroundColor: '#ffffff',
                logging: false,
                // Capture the full A4 page including padding
                width: page.offsetWidth,
                height: page.offsetHeight,
                windowWidth: page.offsetWidth,
                windowHeight: page.offsetHeight
            });

            const imgData = canvas.toDataURL('image/png');

            // Scale the canvas image to fill the A4 page exactly
            if (i > 0) {
                pdf.addPage('a4', 'portrait');
            }

            pdf.addImage(imgData, 'PNG', 0, 0, pageWidthMM, pageHeightMM);
        }

        // Use the document title input value as the filename
        const titleInput = document.querySelector('header input[type="text"]');
        const docName = (titleInput && titleInput.value.trim())
            ? titleInput.value.trim().replace(/[^a-zA-Z0-9_\- ]/g, '')
            : 'ScribenDocument';
        pdf.save(`${docName}.pdf`);
    }

    // --- Active State UI ---
    function updateActiveStates() {
        toolbarButtons.forEach(btn => btn.classList.remove('active'));
        if (document.queryCommandState('bold')) document.querySelector('[data-command="bold"]')?.classList.add('active');
        if (document.queryCommandState('italic')) document.querySelector('[data-command="italic"]')?.classList.add('active');
        if (document.queryCommandState('underline')) document.querySelector('[data-command="underline"]')?.classList.add('active');
    }

    // --- Select All across pages ---
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            const pages = getPages();
            if (pages.length <= 1) return; // let native behaviour handle single page
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

    // --- File Dropdown Menu ---
    const fileTrigger = document.getElementById('menu-file-trigger');
    const fileDropdown = document.getElementById('file-dropdown');

    if (fileTrigger && fileDropdown) {
        fileTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = fileDropdown.style.display === 'block';
            fileDropdown.style.display = isVisible ? 'none' : 'block';
        });

        document.addEventListener('click', () => {
            fileDropdown.style.display = 'none';
        });
    }

    function updateOfflineMenuCheckmark(isOffline) {
        const check = document.getElementById('offline-check');
        if (check) {
            check.style.display = isOffline ? 'block' : 'none';
        }
    }

    const newDocBtn = document.getElementById('menu-new-doc');
    if (newDocBtn) {
        newDocBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const newId = 'doc_' + crypto.randomUUID();
            window.location.href = `${window.location.pathname}?id=${newId}`;
        });
    }

    const toggleOfflineBtn = document.getElementById('menu-toggle-offline');
    if (toggleOfflineBtn) {
        toggleOfflineBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentDoc.offlineUse = (currentDoc.offlineUse !== false) ? false : true;
            await saveDocument(docId, currentDoc);
            updateOfflineMenuCheckmark(currentDoc.offlineUse);
            fileDropdown.style.display = 'none';
        });
    }

    const exportPdfBtnMenu = document.getElementById('menu-export-pdf');
    if (exportPdfBtnMenu) {
        exportPdfBtnMenu.addEventListener('click', (e) => {
            e.preventDefault();
            exportPdfBtn.click();
            fileDropdown.style.display = 'none';
        });
    }

    // --- Document Title Change Auto-Save ---
    const documentTitleInput = document.getElementById('document-title');
    if (documentTitleInput) {
        documentTitleInput.addEventListener('input', () => {
            saveContent();
        });
    }

    // --- Settings & Sync UI Modal ---
    const btnSyncLogin = document.getElementById('btn-sync-login');
    const btnSyncProfile = document.getElementById('btn-sync-profile');
    const settingsModal = document.getElementById('settings-modal');
    const btnSaveSyncCancel = document.getElementById('btn-save-sync-cancel');

    const inputEmail = document.getElementById('sync-email');
    const inputPassword = document.getElementById('sync-password');
    const input2FA = document.getElementById('sync-twofactor');
    const statusText = document.getElementById('sync-settings-status');
    const btnSaveSync = document.getElementById('btn-save-sync');

    // Google-style Dropdown Popover Elements
    const accountDropdown = document.getElementById('account-dropdown');
    const dropdownEmail = document.getElementById('account-dropdown-email');
    const dropdownAvatarContainer = document.getElementById('dropdown-profile-avatar-container');
    const dropdownAvatar = document.getElementById('dropdown-profile-avatar');
    const dropdownLetter = document.getElementById('dropdown-profile-letter');
    const dropdownIcon = document.getElementById('dropdown-profile-icon');
    const dropdownUsername = document.getElementById('dropdown-profile-username');
    const btnDropdownSignout = document.getElementById('btn-dropdown-signout');
    const btnDropdownPurge = document.getElementById('btn-dropdown-purge');

    // Header letter fallback element
    const headerProfileLetter = document.getElementById('header-profile-letter');

    // Google color palette for avatar initials fallback
    const googleColors = ['#1a73e8', '#d93025', '#f9ab00', '#188038', '#ab47bc', '#00acc1'];
    function getAvatarColor(str) {
        if (!str) return googleColors[0];
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        const index = Math.abs(hash) % googleColors.length;
        return googleColors[index];
    }

    if (btnSyncLogin && settingsModal) {
        btnSyncLogin.addEventListener('click', async () => {
            settingsModal.style.display = 'flex';
            await loadSyncModalState();
        });
    }

    // Toggle dropdown popover on profile click
    if (btnSyncProfile && accountDropdown) {
        btnSyncProfile.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = accountDropdown.style.display === 'flex' || accountDropdown.style.display === 'block';
            accountDropdown.style.display = isVisible ? 'none' : 'flex';
        });
    }

    // Close dropdown on click outside
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

    async function loadSyncModalState() {
        const settings = await getSyncSettings();
        
        // Populate sync modal email field if stored
        inputEmail.value = settings.email || '';
        inputPassword.value = '';
        input2FA.value = '';
        statusText.textContent = '';
        statusText.className = '';

        const isSyncActive = settings.enabled && settings.apiKey;

        // Update header controls
        const btnLogin = document.getElementById('btn-sync-login');
        const btnProfile = document.getElementById('btn-sync-profile');
        const imgAvatar = document.getElementById('header-profile-avatar');
        const iconAvatar = document.getElementById('header-profile-icon');

        if (btnLogin && btnProfile) {
            if (isSyncActive) {
                btnLogin.style.display = 'none';
                btnProfile.style.display = 'flex';
                
                const profileIdentity = settings.username || settings.email || '';
                const initialLetter = profileIdentity.trim().charAt(0).toUpperCase();

                if (settings.avatarURL) {
                    imgAvatar.src = settings.avatarURL;
                    imgAvatar.style.display = 'block';
                    if (headerProfileLetter) headerProfileLetter.style.display = 'none';
                    if (iconAvatar) iconAvatar.style.display = 'none';
                    
                    imgAvatar.onerror = () => {
                        imgAvatar.style.display = 'none';
                        if (headerProfileLetter && initialLetter) {
                            headerProfileLetter.textContent = initialLetter;
                            headerProfileLetter.style.backgroundColor = getAvatarColor(profileIdentity);
                            headerProfileLetter.style.display = 'flex';
                        } else if (iconAvatar) {
                            iconAvatar.style.display = 'block';
                        }
                    };
                } else if (initialLetter) {
                    imgAvatar.style.display = 'none';
                    if (headerProfileLetter) {
                        headerProfileLetter.textContent = initialLetter;
                        headerProfileLetter.style.backgroundColor = getAvatarColor(profileIdentity);
                        headerProfileLetter.style.display = 'flex';
                    }
                    if (iconAvatar) iconAvatar.style.display = 'none';
                } else {
                    imgAvatar.style.display = 'none';
                    if (headerProfileLetter) headerProfileLetter.style.display = 'none';
                    if (iconAvatar) iconAvatar.style.display = 'block';
                }
            } else {
                btnLogin.style.display = 'block';
                btnProfile.style.display = 'none';
                if (accountDropdown) {
                    accountDropdown.style.display = 'none';
                }
            }
        }

        // Update floating Google Account Dropdown contents
        if (isSyncActive) {
            const profileIdentity = settings.username || settings.email || '';
            const initialLetter = profileIdentity.trim().charAt(0).toUpperCase();

            if (dropdownEmail) {
                dropdownEmail.textContent = settings.email || '';
            }
            if (dropdownUsername) {
                dropdownUsername.textContent = settings.username || 'Connected';
            }

            if (settings.avatarURL) {
                if (dropdownAvatar) {
                    dropdownAvatar.src = settings.avatarURL;
                    dropdownAvatar.style.display = 'block';
                }
                if (dropdownLetter) dropdownLetter.style.display = 'none';
                if (dropdownIcon) dropdownIcon.style.display = 'none';
                if (dropdownAvatarContainer) {
                    dropdownAvatarContainer.style.backgroundColor = '#f1f3f4';
                }

                if (dropdownAvatar) {
                    dropdownAvatar.onerror = () => {
                        dropdownAvatar.style.display = 'none';
                        if (dropdownLetter && initialLetter) {
                            dropdownLetter.textContent = initialLetter;
                            dropdownLetter.style.display = 'flex';
                            if (dropdownAvatarContainer) {
                                dropdownAvatarContainer.style.backgroundColor = getAvatarColor(profileIdentity);
                            }
                        } else if (dropdownIcon) {
                            dropdownIcon.style.display = 'block';
                        }
                    };
                }
            } else if (initialLetter) {
                if (dropdownAvatar) dropdownAvatar.style.display = 'none';
                if (dropdownLetter) {
                    dropdownLetter.textContent = initialLetter;
                    dropdownLetter.style.display = 'flex';
                }
                if (dropdownIcon) dropdownIcon.style.display = 'none';
                if (dropdownAvatarContainer) {
                    dropdownAvatarContainer.style.backgroundColor = getAvatarColor(profileIdentity);
                }
            } else {
                if (dropdownAvatar) dropdownAvatar.style.display = 'none';
                if (dropdownLetter) dropdownLetter.style.display = 'none';
                if (dropdownIcon) dropdownIcon.style.display = 'block';
                if (dropdownAvatarContainer) {
                    dropdownAvatarContainer.style.backgroundColor = '#f1f3f4';
                }
            }
        }
    }

    if (btnSaveSync) {
        btnSaveSync.addEventListener('click', async () => {
            const email = inputEmail.value.trim();
            const password = inputPassword.value.trim();
            const twoFactorCode = input2FA.value.trim();

            if (!email || !password) {
                statusText.textContent = 'Email and password are required.';
                statusText.style.color = '#b3261e';
                return;
            }

            statusText.textContent = 'Connecting and authenticating...';
            statusText.style.color = '#d97706';

            try {
                startSync({
                    email,
                    password,
                    twoFactorCode,
                    enabled: true
                });
                
                statusText.textContent = 'Sync enabled successfully!';
                statusText.style.color = '#15803d';
                
                setTimeout(() => {
                    settingsModal.style.display = 'none';
                }, 1000);
            } catch (err) {
                console.error("Login failed:", err);
                statusText.textContent = 'Sync connection failed. Check credentials.';
                statusText.style.color = '#b3261e';
            }
        });
    }

    if (btnDropdownSignout) {
        btnDropdownSignout.addEventListener('click', async () => {
            const settings = await getSyncSettings();
            settings.enabled = false;
            
            delete settings.username;
            delete settings.avatarURL;
            delete settings.apiKey;
            delete settings.masterKeys;
            delete settings.publicKey;
            delete settings.privateKey;
            delete settings.baseFolderUUID;
            delete settings.userId;
            delete settings.authVersion;
            delete settings.email;
            delete settings.password;
            delete settings.twoFactorCode;

            await saveSyncSettings(settings);
            stopSync();
            
            if (accountDropdown) {
                accountDropdown.style.display = 'none';
            }
            
            await loadSyncModalState();
        });
    }

    if (btnDropdownPurge) {
        btnDropdownPurge.addEventListener('click', async () => {
            if (confirm("Are you sure you want to delete all local document cache and sign out? This cannot be undone.")) {
                try {
                    if (accountDropdown) {
                        accountDropdown.style.display = 'none';
                    }
                    await destroyDatabase();
                } catch (err) {
                    console.error("Purging database failed:", err);
                    alert("Purging database failed. Try again.");
                }
            }
        });
    }

    // --- Sync Callback Handler ---
    function handleDBChange(change) {
        if (change.id === docId) {
            if (change.deleted) {
                alert("This document was deleted remotely. Redirecting...");
                window.location.href = window.location.pathname;
            } else {
                const doc = change.doc;
                if (doc.updatedAt > (currentDoc.updatedAt || 0)) {
                    currentDoc = doc;
                    renderDocument(doc);
                }
            }
        }
    }

    function handleSyncStatusChange(status) {
        const badge = document.getElementById('sync-status');
        if (!badge) return;
        const text = badge.querySelector('.sync-text');
        const icon = badge.querySelector('.material-symbols-outlined');

        if (!badge || !text || !icon) return;

        badge.className = `sync-badge ${status}`;
        
        if (status === 'online') {
            text.textContent = 'Online';
            icon.textContent = 'cloud_done';
            badge.title = 'Secure cloud sync is online';
        } else if (status === 'syncing') {
            text.textContent = 'Syncing...';
            icon.textContent = 'sync';
            badge.title = 'Reconciling changes with Filen';
        } else if (status === 'error') {
            text.textContent = 'Sync Error';
            icon.textContent = 'error';
            badge.title = 'Synchronization encountered an error';
        } else {
            text.textContent = 'Offline';
            icon.textContent = 'cloud_off';
            badge.title = 'Sync offline';
        }
    }

    registerCallbacks(handleDBChange, handleSyncStatusChange);

    // Load active document content
    loadContent();

    // Start sync immediately if enabled in settings
    (async () => {
        const syncSettings = await getSyncSettings();
        // Update header buttons on startup
        await loadSyncModalState();
        if (syncSettings && syncSettings.enabled) {
            startSync(syncSettings);
        }
    })();
});

