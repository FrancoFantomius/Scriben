/**
 * Scriben - Templates and Documents Dashboard Module
 */

import {
    startSync,
    stopSync,
    getSyncSettings,
    saveSyncSettings,
    saveDocument,
    getDocument,
    loadAllDocumentHeaders,
    deleteDocumentFromDB,
    destroyDatabase,
    registerCallbacks
} from "./sync.js";

import blankHtml from "../templates/blank.html?raw";
import proposalHtml from "../templates/proposal.html?raw";
import meetingHtml from "../templates/meeting.html?raw";
import resumeHtml from "../templates/resume.html?raw";
import coverLetterHtml from "../templates/cover_letter.html?raw";

document.addEventListener('DOMContentLoaded', () => {
    localStorage.setItem('scriben-has-used', 'true');
    // --- State variables ---
    let allDocs = [];

    // --- Selectors ---
    const searchInput = document.getElementById('search-input');
    const searchClearBtn = document.getElementById('search-clear-btn');
    const documentsList = document.getElementById('documents-list');
    const syncBannerNotice = document.getElementById('sync-banner-notice');
    
    // Auth selectors
    const btnSyncLogin = document.getElementById('btn-sync-login');
    const btnSyncProfile = document.getElementById('btn-sync-profile');
    const settingsModal = document.getElementById('settings-modal');
    const btnSaveSyncCancel = document.getElementById('btn-save-sync-cancel');
    const inputEmail = document.getElementById('sync-email');
    const inputPassword = document.getElementById('sync-password');
    const input2FA = document.getElementById('sync-twofactor');
    const statusText = document.getElementById('sync-settings-status');
    const btnSaveSync = document.getElementById('btn-save-sync');

    // Profile card dropdown
    const accountDropdown = document.getElementById('account-dropdown');
    const dropdownEmail = document.getElementById('account-dropdown-email');
    const dropdownAvatarContainer = document.getElementById('dropdown-profile-avatar-container');
    const dropdownAvatar = document.getElementById('dropdown-profile-avatar');
    const dropdownLetter = document.getElementById('dropdown-profile-letter');
    const dropdownIcon = document.getElementById('dropdown-profile-icon');
    const dropdownUsername = document.getElementById('dropdown-profile-username');
    const btnDropdownSignout = document.getElementById('btn-dropdown-signout');
    const btnDropdownPurge = document.getElementById('btn-dropdown-purge');

    // Header initials fallback avatar
    const headerProfileLetter = document.getElementById('header-profile-letter');

    // --- HTML Escaping Helper ---
    function escapeHTML(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // --- Google Profile Colors ---
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

    // --- Date Formatting Helper ---
    function formatDate(timestamp) {
        if (!timestamp) return 'Unknown';
        const date = new Date(timestamp);
        return date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    // --- Theme Control ---
    function updateThemeToggleUI() {
        const theme = localStorage.getItem('scriben-theme') || 'auto';
        const isDark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        const themeBtn = document.getElementById('btn-theme-toggle');
        if (themeBtn) {
            const icon = themeBtn.querySelector('.material-symbols-outlined');
            if (icon) {
                icon.textContent = isDark ? 'dark_mode' : 'light_mode';
            }
        }
    }

    const themeBtn = document.getElementById('btn-theme-toggle');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            const currentTheme = localStorage.getItem('scriben-theme') || 'auto';
            let newTheme = 'light';
            if (currentTheme === 'light') {
                newTheme = 'dark';
            } else if (currentTheme === 'dark') {
                newTheme = 'light';
            } else {
                const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                newTheme = systemDark ? 'light' : 'dark';
            }
            localStorage.setItem('scriben-theme', newTheme);
            document.documentElement.setAttribute('data-theme', newTheme);
            updateThemeToggleUI();
            
            // Re-emit so other tabs receive it
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'scriben-theme',
                newValue: newTheme
            }));
        });
    }
    updateThemeToggleUI();

    // --- Templates Definitions ---
    const TEMPLATES = {
        blank: {
            title: 'Untitled document',
            content: [blankHtml]
        },
        proposal: {
            title: 'Project Proposal',
            content: [proposalHtml]
        },
        meeting: {
            title: 'Meeting Notes',
            content: [meetingHtml]
        },
        resume: {
            title: 'Resume',
            content: [resumeHtml]
        },
        cover_letter: {
            title: 'Cover Letter',
            content: [coverLetterHtml]
        }
    };

    // --- Document Templates Creation Handler ---
    const templateCards = document.querySelectorAll('.template-card');
    templateCards.forEach(card => {
        card.addEventListener('click', async () => {
            const templateKey = card.dataset.template;
            const template = TEMPLATES[templateKey];
            if (!template) return;

            const newId = 'doc_' + crypto.randomUUID();
            const now = Date.now();
            const docObj = {
                title: template.title,
                content: template.content,
                offlineUse: true,
                createdAt: now,
                updatedAt: now
            };

            try {
                // Show screen spinner
                documentsList.innerHTML = `
                    <div class="list-placeholder-state">
                        <span class="material-symbols-outlined spinner">sync</span>
                        <p>Creating document from template...</p>
                    </div>
                `;
                await saveDocument(newId, docObj);
                window.location.href = `./editor?id=${newId}`;
            } catch (err) {
                console.error("Failed to create document from template:", err);
                alert("Could not create document. Please try again.");
                loadAndRenderDocuments();
            }
        });
    });

    // --- Load and Render Document List ---
    async function loadAndRenderDocuments() {
        try {
            allDocs = await loadAllDocumentHeaders();
            
            // Sort by updatedAt descending
            allDocs.sort((a, b) => b.updatedAt - a.updatedAt);
            
            renderDocumentsList();
        } catch (err) {
            console.error("Failed to load documents:", err);
            documentsList.innerHTML = `
                <div class="list-placeholder-state">
                    <span class="material-symbols-outlined" style="color: var(--color-danger);">error</span>
                    <p>Failed to load documents. Refresh or check console.</p>
                </div>
            `;
        }
    }

    function renderDocumentsList() {
        const query = searchInput.value.toLowerCase().trim();
        const filtered = allDocs.filter(doc => doc.title.toLowerCase().includes(query));

        // Manage search clear button
        if (query.length > 0) {
            searchClearBtn.style.display = 'block';
        } else {
            searchClearBtn.style.display = 'none';
        }

        // Empty States
        if (filtered.length === 0) {
            if (query.length > 0) {
                documentsList.innerHTML = `
                    <div class="list-placeholder-state">
                        <span class="material-symbols-outlined">search_off</span>
                        <p>No documents match "${escapeHTML(query)}"</p>
                    </div>
                `;
            } else {
                documentsList.innerHTML = `
                    <div class="list-placeholder-state">
                        <span class="material-symbols-outlined">folder_open</span>
                        <p>No documents yet. Select a template above to start!</p>
                    </div>
                `;
            }
            return;
        }

        // Render documents rows
        documentsList.innerHTML = '';
        filtered.forEach(doc => {
            const row = document.createElement('div');
            row.className = 'document-row';
            row.dataset.id = doc.id;

            row.innerHTML = `
                <div class="col-name-wrapper">
                    <span class="material-symbols-outlined doc-icon">description</span>
                    <a class="doc-title" href="./editor?id=${doc.id}">${escapeHTML(doc.title)}</a>
                </div>
                <div class="col-date">${formatDate(doc.updatedAt)}</div>
                <div class="col-offline">
                    <input type="checkbox" class="offline-toggle-checkbox" data-id="${doc.id}" ${doc.offlineUse !== false ? 'checked' : ''} title="Keep offline copy">
                </div>
                <div class="col-actions">
                    <button class="btn-more-actions" data-id="${doc.id}" title="More Actions">
                        <span class="material-symbols-outlined" style="pointer-events: none;">more_vert</span>
                    </button>
                    <div class="row-action-popover" id="popover-${doc.id}">
                        <a class="dropdown-item action-rename" data-id="${doc.id}">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span class="material-symbols-outlined" style="font-size: 18px;">edit</span>
                                Rename
                            </div>
                        </a>
                        <a class="dropdown-item action-delete" data-id="${doc.id}">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-danger);">delete</span>
                                <span style="color: var(--color-danger);">Delete</span>
                            </div>
                        </a>
                    </div>
                </div>
            `;

            // Bind click to open document (excluding checkbox/actions column)
            row.addEventListener('click', (e) => {
                if (e.target.closest('.col-actions') || e.target.closest('.col-offline') || e.target.closest('.doc-title')) {
                    return;
                }
                window.location.href = `./editor?id=${doc.id}`;
            });

            // Bind Offline checkbox toggle
            const checkbox = row.querySelector('.offline-toggle-checkbox');
            checkbox.addEventListener('change', async (e) => {
                const targetId = e.target.dataset.id;
                try {
                    const fullDoc = await getDocument(targetId);
                    fullDoc.offlineUse = e.target.checked;
                    fullDoc.updatedAt = Date.now();
                    await saveDocument(targetId, fullDoc);
                } catch (err) {
                    console.error("Failed to toggle offline settings:", err);
                    alert("Could not update offline status.");
                    e.target.checked = !e.target.checked; // revert UI
                }
            });

            // Bind Action: Rename
            const renameBtn = row.querySelector('.action-rename');
            renameBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const targetId = renameBtn.dataset.id;
                
                // Hide popover
                const popover = document.getElementById(`popover-${targetId}`);
                if (popover) popover.classList.remove('show');

                const currentDocObj = allDocs.find(d => d.id === targetId);
                const oldTitle = currentDocObj ? currentDocObj.title : '';
                const newTitle = prompt("Rename document:", oldTitle);
                
                if (newTitle !== null && newTitle.trim() !== '') {
                    try {
                        const fullDoc = await getDocument(targetId);
                        fullDoc.title = newTitle.trim();
                        fullDoc.updatedAt = Date.now();
                        await saveDocument(targetId, fullDoc);
                        await loadAndRenderDocuments();
                    } catch (err) {
                        console.error("Failed to rename document:", err);
                        alert("Could not rename document.");
                    }
                }
            });

            // Bind Action: Delete
            const deleteBtn = row.querySelector('.action-delete');
            deleteBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const targetId = deleteBtn.dataset.id;

                // Hide popover
                const popover = document.getElementById(`popover-${targetId}`);
                if (popover) popover.classList.remove('show');

                const currentDocObj = allDocs.find(d => d.id === targetId);
                const titleStr = currentDocObj ? currentDocObj.title : 'this document';

                if (confirm(`Are you sure you want to permanently delete "${titleStr}"?`)) {
                    try {
                        await deleteDocumentFromDB(targetId);
                        await loadAndRenderDocuments();
                    } catch (err) {
                        console.error("Failed to delete document:", err);
                        alert("Could not delete document.");
                    }
                }
            });

            documentsList.appendChild(row);
        });
    }

    // --- Search Interaction Events ---
    searchInput.addEventListener('input', () => {
        renderDocumentsList();
    });

    searchClearBtn.addEventListener('click', () => {
        searchInput.value = '';
        renderDocumentsList();
        searchInput.focus();
    });

    // Handle Closing/Opening popovers globally
    document.addEventListener('click', (e) => {
        const moreActionsBtn = e.target.closest('.btn-more-actions');
        if (moreActionsBtn) {
            e.stopPropagation();
            const docId = moreActionsBtn.dataset.id;
            const popover = document.getElementById(`popover-${docId}`);
            
            // Close all other popovers
            document.querySelectorAll('.row-action-popover').forEach(p => {
                if (p !== popover) p.classList.remove('show');
            });
            
            if (popover) {
                popover.classList.toggle('show');
            }
            return;
        }
        
        // Click outside closes popover
        if (!e.target.closest('.row-action-popover')) {
            document.querySelectorAll('.row-action-popover').forEach(p => p.classList.remove('show'));
        }
    });

    // --- Authentication & Cloud Sync Modal UI ---
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
        
        inputEmail.value = settings.email || '';
        inputPassword.value = '';
        input2FA.value = '';
        statusText.textContent = '';
        statusText.className = '';

        const isSyncActive = settings.enabled && settings.apiKey;

        // Toggle Sync Banner Notice based on sync settings
        if (syncBannerNotice) {
            syncBannerNotice.style.display = isSyncActive ? 'none' : 'flex';
        }

        // Toggle login & profile buttons in top header
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

        // Update the account card dropdown contents
        if (isSyncActive) {
            const profileIdentity = settings.username || settings.email || '';
            const initialLetter = profileIdentity.trim().charAt(0).toUpperCase();

            if (dropdownEmail) dropdownEmail.textContent = settings.email || '';
            if (dropdownUsername) dropdownUsername.textContent = settings.username || 'Connected';

            if (settings.avatarURL) {
                if (dropdownAvatar) {
                    dropdownAvatar.src = settings.avatarURL;
                    dropdownAvatar.style.display = 'block';
                }
                if (dropdownLetter) dropdownLetter.style.display = 'none';
                if (dropdownIcon) dropdownIcon.style.display = 'none';
                if (dropdownAvatarContainer) dropdownAvatarContainer.style.backgroundColor = '#f1f3f4';

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
                if (dropdownAvatarContainer) dropdownAvatarContainer.style.backgroundColor = '#f1f3f4';
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

                setTimeout(async () => {
                    settingsModal.style.display = 'none';
                    await loadSyncModalState();
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
            await loadAndRenderDocuments();
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

    // --- Sync Replication Handlers ---
    async function handleDBChange(change) {
        // Any non-local document change warrants refreshing list
        await loadAndRenderDocuments();
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
            if (syncBannerNotice) syncBannerNotice.style.display = 'none';
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

    // --- Initial page setups ---
    (async () => {
        await loadAndRenderDocuments();
        const syncSettings = await getSyncSettings();
        await loadSyncModalState();
        if (syncSettings && syncSettings.enabled) {
            startSync(syncSettings);
        }
    })();
});
