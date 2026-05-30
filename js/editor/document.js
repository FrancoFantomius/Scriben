import { state, getPages } from './state.js';
import { applyPageFormat, applyFontFamily } from './ui.js';
import { createPage, paginate } from './pagination.js';
import { applyAppTheme } from './theme.js';
import {
    saveDocument,
    getDocument,
    fetchDocumentContentFromCloud,
    getSyncSettings,
    startSync,
    stopSync,
    destroyDatabase
} from '../sync.js';

const STORAGE_KEY = 'scriben-wysiwyg-content';

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

/**
 * Parses and returns the active document ID from URL query parameters
 * or from localStorage. Sets a random UUID if none exists.
 * @returns {string}
 */
export function getActiveDocumentId() {
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

/**
 * Saves current page content to local PouchDB.
 */
export async function saveContent() {
    const pages = getPages();
    const data = pages.map(p => p.innerHTML);
    const titleInput = document.getElementById('document-title');
    const title = titleInput ? titleInput.value.trim() : 'Untitled document';

    state.currentDoc.title = title || 'Untitled document';
    state.currentDoc.content = data;
    state.currentDoc.updatedAt = Date.now();

    try {
        await saveDocument(state.docId, state.currentDoc);
    } catch (err) {
        console.error("Failed to save content to PouchDB:", err);
    }
}

export const debouncedSaveContent = debounce(saveContent, 1000);

/**
 * Loads document content from local PouchDB or falls back to legacy localStorage.
 */
export async function loadContent() {
    try {
        let doc;
        try {
            doc = await getDocument(state.docId);
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
                pageFormat: 'a4',
                fontFamily: "'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari', 'Noto Sans CJK TC', 'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', 'Noto Color Emoji', sans-serif",
                updatedAt: Date.now()
            };
            await saveDocument(state.docId, doc);
        }

        const contentIsEmpty = !doc.content || !Array.isArray(doc.content) || doc.content.length === 0;
        if (contentIsEmpty && doc.synced) {
            const cloudDoc = await fetchDocumentContentFromCloud(state.docId);
            if (cloudDoc) {
                doc = cloudDoc;
            }
        }

        state.currentDoc = doc;
        renderDocument(doc);
    } catch (err) {
        console.error("Failed to load content from PouchDB:", err);
    }
}

/**
 * Renders the document model in the pages container workspace.
 * @param {object} doc 
 */
export function renderDocument(doc) {
    const titleInput = document.getElementById('document-title');
    if (titleInput) {
        titleInput.value = doc.title || 'Untitled document';
    }

    applyPageFormat(doc.pageFormat || 'a4');
    applyFontFamily(doc.fontFamily || "'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari', 'Noto Sans CJK TC', 'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', 'Noto Color Emoji', sans-serif");

    let contentArray = [];
    if (doc.content) {
        if (Array.isArray(doc.content)) {
            contentArray = doc.content;
        } else if (typeof doc.content === 'string') {
            contentArray = [doc.content];
        }
    }

    if (contentArray.length > 0) {
        state.container.innerHTML = '';
        contentArray.forEach(html => {
            const page = createPage();
            page.innerHTML = html;
        });
    } else {
        state.container.innerHTML = '';
        createPage();
    }

    updateOfflineMenuCheckmark(doc.offlineUse !== false);

    requestAnimationFrame(() => {
        paginate();
    });
}

/**
 * Updates checkbox next to 'Save for offline use' menu item.
 * @param {boolean} isOffline 
 */
export function updateOfflineMenuCheckmark(isOffline) {
    const check = document.getElementById('offline-check');
    if (check) {
        check.style.display = isOffline ? 'block' : 'none';
    }
}

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

/**
 * Updates UI of top bar profile credentials card dynamically from stored settings.
 */
export async function loadSyncModalState() {
    const settings = await getSyncSettings();
    const inputEmail = document.getElementById('sync-email');
    const inputPassword = document.getElementById('sync-password');
    const input2FA = document.getElementById('sync-twofactor');
    const statusText = document.getElementById('sync-settings-status');

    if (inputEmail) inputEmail.value = settings.email || '';
    if (inputPassword) inputPassword.value = '';
    if (input2FA) input2FA.value = '';
    if (statusText) {
        statusText.textContent = '';
        statusText.className = '';
    }

    const isSyncActive = settings.enabled && settings.apiKey;

    const btnLogin = document.getElementById('btn-sync-login');
    const btnProfile = document.getElementById('btn-sync-profile');
    const imgAvatar = document.getElementById('header-profile-avatar');
    const iconAvatar = document.getElementById('header-profile-icon');
    const headerProfileLetter = document.getElementById('header-profile-letter');

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
            const accountDropdown = document.getElementById('account-dropdown');
            if (accountDropdown) {
                accountDropdown.style.display = 'none';
            }
        }
    }

    // Update floating Google Account Dropdown contents
    const accountDropdown = document.getElementById('account-dropdown');
    if (accountDropdown && isSyncActive) {
        const dropdownEmail = document.getElementById('account-dropdown-email');
        const dropdownAvatarContainer = document.getElementById('dropdown-profile-avatar-container');
        const dropdownAvatar = document.getElementById('dropdown-profile-avatar');
        const dropdownLetter = document.getElementById('dropdown-profile-letter');
        const dropdownIcon = document.getElementById('dropdown-profile-icon');
        const dropdownUsername = document.getElementById('dropdown-profile-username');

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

/**
 * Handles PouchDB changes from cloud sync.
 * @param {object} change 
 */
export function handleDBChange(change) {
    if (change.id === state.docId) {
        if (change.deleted) {
            alert("This document was deleted remotely. Redirecting...");
            window.location.href = window.location.pathname;
        } else {
            const doc = change.doc;
            if (doc.updatedAt > (state.currentDoc.updatedAt || 0)) {
                state.currentDoc = doc;
                renderDocument(doc);
            }
        }
    }
}

/**
 * Sync callback. Handles cloud connection state changes.
 * @param {string} status 
 */
export function handleSyncStatusChange(status) {
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
