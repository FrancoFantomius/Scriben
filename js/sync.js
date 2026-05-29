/**
 * Scriben - Database and Sync Module (PouchDB wrapper with Filen replication)
 */

import { FilenSDK } from "@filen/sdk";
import { Buffer } from "buffer";
import { Readable } from "stream";

// Polyfill Readable.from in the browser stream polyfill
if (Readable) {
  Readable.from = function (iterable, options) {
    const opt = Object.assign({ objectMode: true }, options);
    const readable = new Readable({
      ...opt,
      read() {}
    });
    
    (async () => {
      try {
        for await (const chunk of iterable) {
          readable.push(chunk);
        }
        readable.push(null);
      } catch (err) {
        readable.destroy(err);
      }
    })();
    
    return readable;
  };
}

// Initialize PouchDB local database
const db = new PouchDB('scriben_db');

// State variables for Filen Sync
let filenClient = null;
let activeDocId = null;
let onChangeCallback = null;
let onSyncStatusCallback = null;
let syncPromise = Promise.resolve();
let syncInterval = null;

/**
 * Register active document ID to prevent purging its content when offlineUse is false
 */
export function setActiveDocId(id) {
  activeDocId = id;
}

/**
 * Register callbacks for external event changes
 */
export function registerCallbacks(onChange, onSyncStatus) {
  onChangeCallback = onChange;
  onSyncStatusCallback = onSyncStatus;
}

// Watch local database changes for live updates (sync, edits)
db.changes({
  since: 'now',
  live: true,
  include_docs: true
}).on('change', (change) => {
  // Ignore local configuration/sync documents
  if (change.id.startsWith('_local/')) {
    return;
  }
  if (onChangeCallback) {
    onChangeCallback(change);
  }
});

/**
 * Get local-only sync settings (not synchronized to remote server).
 */
export async function getSyncSettings() {
  try {
    return await db.get('_local/sync_settings');
  } catch (err) {
    if (err.status === 404) {
      return { email: '', password: '', twoFactorCode: '', username: '', avatarURL: '', enabled: false };
    }
    throw err;
  }
}

/**
 * Save sync settings locally.
 */
export async function saveSyncSettings(settings) {
  try {
    let existing;
    try {
      existing = await db.get('_local/sync_settings');
    } catch (e) {
      existing = null;
    }
    
    const doc = {
      _id: '_local/sync_settings',
      ...settings
    };
    if (existing) {
      doc._rev = existing._rev;
    }
    await db.put(doc);
  } catch (err) {
    console.error("[DB] Failed to save sync settings:", err);
    throw err;
  }
}

/**
 * Save a document locally.
 * @param {string} id - Unique document ID (e.g. doc_uuid)
 * @param {Object} docObj - Document fields (title, content pages array, etc.)
 */
export async function saveDocument(id, docObj) {
  try {
    let existingDoc = null;
    try {
      existingDoc = await db.get(id);
    } catch (err) {
      // Document is new
    }
    
    const doc = {
      _id: id,
      type: 'document',
      updatedAt: docObj.updatedAt || Date.now(),
      title: docObj.title || 'Untitled document',
      content: docObj.content || [],
      offlineUse: docObj.offlineUse !== undefined ? docObj.offlineUse : true,
      createdAt: docObj.createdAt || Date.now()
    };
    
    if (existingDoc) {
      doc._rev = existingDoc._rev;
      // Preserve sync-related metadata
      if (existingDoc.lastSynced) doc.lastSynced = existingDoc.lastSynced;
      if (existingDoc.remoteLastModified) doc.remoteLastModified = existingDoc.remoteLastModified;
      if (existingDoc.synced) doc.synced = existingDoc.synced;
    }
    
    const response = await db.put(doc);
    
    // Trigger sync replication
    triggerSyncReconciliation();
    
    return response;
  } catch (err) {
    console.error("[DB] Failed to save document:", err);
    throw err;
  }
}

/**
 * Get a single document by ID.
 * @param {string} id
 * @returns {Promise<Object>} - Document PouchDB record
 */
export async function getDocument(id) {
  return await db.get(id);
}

/**
 * Load headers of all documents (useful for document listing).
 * If a document has offlineUse: false and is not current, its content may be cleared/pruned.
 */
export async function loadAllDocumentHeaders() {
  try {
    const result = await db.allDocs({
      include_docs: true,
      startkey: 'doc_',
      endkey: 'doc_\ufff0'
    });
    
    return result.rows.map(row => {
      const doc = row.doc;
      return {
        id: doc._id,
        _rev: doc._rev,
        title: doc.title || 'Untitled document',
        offlineUse: doc.offlineUse !== undefined ? doc.offlineUse : true,
        createdAt: doc.createdAt || Date.now(),
        updatedAt: doc.updatedAt || Date.now(),
        synced: doc.synced || false,
        lastSynced: doc.lastSynced
      };
    });
  } catch (err) {
    console.error("[DB] Failed to load document headers:", err);
    return [];
  }
}

/**
 * Permanently delete a document from local and remote.
 * @param {string} id
 */
export async function deleteDocumentFromDB(id) {
  try {
    const doc = await db.get(id);
    await db.remove(doc);
    
    // Add to deleted queue to sync deletion to remote
    const settings = await getSyncSettings();
    if (settings && settings.enabled) {
      await addToDeletedDocsQueue(id);
      triggerSyncReconciliation();
    }
  } catch (err) {
    console.error("[DB] Failed to delete document:", err);
    throw err;
  }
}

/**
 * Configure and start subscription and synchronization with Filen.
 * @param {Object} settings - Sync settings ({email, password, enabled, etc.})
 */
export function startSync(settings) {
  stopSync();

  const hasCredentials = settings.email && settings.password;
  const hasSession = settings.apiKey && settings.masterKeys;

  if (!settings.enabled || (!hasCredentials && !hasSession)) {
    if (onSyncStatusCallback) onSyncStatusCallback('offline');
    return;
  }

  if (onSyncStatusCallback) onSyncStatusCallback('syncing');

  initFilenAndSync(settings);
}

/**
 * Stop active synchronization.
 */
export function stopSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  filenClient = null;
  if (onSyncStatusCallback) onSyncStatusCallback('offline');
}

/**
 * Clear all local data and reload page.
 */
export async function destroyDatabase() {
  stopSync();
  await db.destroy();
  window.location.reload();
}

// --- Deletion Queue Logic ---

async function getDeletedDocsQueue() {
  try {
    const doc = await db.get('_local/deleted_documents');
    return doc.ids || [];
  } catch (err) {
    if (err.status === 404) {
      return [];
    }
    throw err;
  }
}

async function addToDeletedDocsQueue(id) {
  try {
    let doc;
    try {
      doc = await db.get('_local/deleted_documents');
    } catch (err) {
      if (err.status === 404) {
        doc = { _id: '_local/deleted_documents', ids: [] };
      } else {
        throw err;
      }
    }
    if (!doc.ids.includes(id)) {
      doc.ids.push(id);
      await db.put(doc);
    }
  } catch (err) {
    console.error("[Sync] Failed to add to deleted docs queue:", err);
  }
}

async function removeFromDeletedDocsQueue(id) {
  try {
    const doc = await db.get('_local/deleted_documents');
    doc.ids = doc.ids.filter(item => item !== id);
    await db.put(doc);
  } catch (err) {
    if (err.status !== 404) {
      console.error("[Sync] Failed to remove from deleted docs queue:", err);
    }
  }
}

export function triggerSyncReconciliation() {
  if (!filenClient) return;
  queueSync();
}

function queueSync() {
  syncPromise = syncPromise.then(() => runSync()).catch(err => {
    console.error("[Sync] Error in sync queue:", err);
  });
}

// --- Filen SDK Login & Directory Preparation ---

async function initFilenAndSync(settings) {
  try {
    filenClient = new FilenSDK({
      metadataCache: true
    });
    
    if (settings.apiKey && settings.masterKeys) {
      filenClient.init({
        apiKey: settings.apiKey,
        masterKeys: settings.masterKeys,
        publicKey: settings.publicKey,
        privateKey: settings.privateKey,
        baseFolderUUID: settings.baseFolderUUID,
        userId: settings.userId,
        authVersion: settings.authVersion,
        metadataCache: true
      });

      // Update profile info in background
      try {
        const accountInfo = await filenClient.user().account();
        if (accountInfo) {
          const nickname = accountInfo.nickName || accountInfo.displayName;
          const avatarURL = accountInfo.avatarURL || '';
          let changed = false;
          if (nickname && nickname !== settings.username) {
            settings.username = nickname;
            changed = true;
          }
          if (avatarURL !== settings.avatarURL) {
            settings.avatarURL = avatarURL;
            changed = true;
          }
          if (changed) {
            await saveSyncSettings(settings);
          }
        }
      } catch (e) {
        console.warn("[Sync] Profile update failed (non-critical):", e);
      }
    } else if (settings.email && settings.password) {
      await filenClient.login({
        email: settings.email,
        password: settings.password,
        twoFactorCode: settings.twoFactorCode || undefined
      });
      
      let nickname = settings.email.split('@')[0];
      let avatarURL = '';
      try {
        const accountInfo = await filenClient.user().account();
        if (accountInfo) {
          if (accountInfo.nickName) nickname = accountInfo.nickName;
          else if (accountInfo.displayName) nickname = accountInfo.displayName;
          if (accountInfo.avatarURL) avatarURL = accountInfo.avatarURL;
        }
      } catch (e) {
        console.warn("[Sync] Profile fetch failed:", e);
      }

      const sessionSettings = {
        enabled: true,
        email: settings.email,
        username: nickname,
        avatarURL: avatarURL,
        apiKey: filenClient.config.apiKey,
        masterKeys: filenClient.config.masterKeys,
        publicKey: filenClient.config.publicKey,
        privateKey: filenClient.config.privateKey,
        baseFolderUUID: filenClient.config.baseFolderUUID,
        userId: filenClient.config.userId,
        authVersion: filenClient.config.authVersion
      };
      
      await saveSyncSettings(sessionSettings);
    } else {
      throw new Error("Missing credentials or session keys");
    }
    
    // Ensure cloud folder hierarchy
    try {
      await filenClient.fs().mkdir({ path: '/Scriben' });
    } catch (e) {}
    try {
      await filenClient.fs().mkdir({ path: '/Scriben/documents' });
    } catch (e) {}

    // Run initial sync
    queueSync();

    // Setup recurring sync timer
    syncInterval = setInterval(() => {
      queueSync();
    }, 20000);

  } catch (err) {
    console.error("[Sync] Initialization failed:", err);
    if (onSyncStatusCallback) onSyncStatusCallback('error');
  }
}

// --- Sync Reconciliation Execution ---

async function runSync() {
  if (!filenClient) return;
  const settings = await getSyncSettings();
  if (!settings.enabled || !filenClient.isLoggedIn()) return;
  
  if (onSyncStatusCallback) onSyncStatusCallback('syncing');

  try {
    // 1. Process deletions
    const deletedQueue = await getDeletedDocsQueue();
    for (const docId of deletedQueue) {
      try {
        const filePath = `/Scriben/documents/${docId}.json`;
        await filenClient.fs().rm({ path: filePath, permanent: true });
        await removeFromDeletedDocsQueue(docId);
      } catch (err) {
        console.error(`[Sync] Failed to remote delete document ${docId}:`, err);
        throw err; // Pause current sync replication cycle
      }
    }

    // 2. Load all local documents
    const localResult = await db.allDocs({
      include_docs: true,
      startkey: 'doc_',
      endkey: 'doc_\ufff0'
    });
    const localDocs = localResult.rows.map(row => row.doc);

    // 3. Read remote files
    let remoteFiles = [];
    try {
      remoteFiles = await filenClient.fs().readdir({ path: '/Scriben/documents' });
    } catch (err) {
      if (err.message && err.message.includes('not found')) {
        remoteFiles = [];
      } else {
        throw err;
      }
    }

    // Build remote mapping
    const remoteMap = new Map();
    for (const filename of remoteFiles) {
      if (!filename.endsWith('.json')) continue;
      const docId = filename.substring(0, filename.length - 5);
      const filePath = `/Scriben/documents/${filename}`;
      try {
        const stats = await filenClient.fs().stat({ path: filePath });
        remoteMap.set(docId, { filename, filePath, stats });
      } catch (err) {
        console.error(`[Sync] Stat failed on remote file ${filePath}:`, err);
      }
    }

    const localMap = new Map(localDocs.map(doc => [doc._id, doc]));

    // Reusable Upload Helper
    const uploadDocToFilen = async (localDoc) => {
      // Re-fetch local doc in case it has been changed while we were reading directory
      const refreshedDoc = await db.get(localDoc._id);

      const payload = {
        _id: refreshedDoc._id,
        type: refreshedDoc.type,
        updatedAt: refreshedDoc.updatedAt,
        title: refreshedDoc.title,
        content: refreshedDoc.content || [],
        offlineUse: refreshedDoc.offlineUse !== undefined ? refreshedDoc.offlineUse : true,
        createdAt: refreshedDoc.createdAt
      };

      const parentUUID = await filenClient.fs().pathToItemUUID({
        path: '/Scriben/documents',
        type: 'directory'
      });

      if (!parentUUID) {
        throw new Error("Could not find /Scriben/documents directory UUID");
      }

      const jsonStr = JSON.stringify(payload);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const file = new File([blob], `${refreshedDoc._id}.json`, { 
        type: 'application/json',
        lastModified: refreshedDoc.updatedAt 
      });

      const item = await filenClient.cloud().uploadWebFile({
        file,
        parent: parentUUID,
        name: `${refreshedDoc._id}.json`
      });

      // Update sync markers in PouchDB
      const docToUpdate = await db.get(refreshedDoc._id);
      docToUpdate.lastSynced = Date.now();
      docToUpdate.remoteLastModified = item.lastModified;
      docToUpdate.synced = true;
      await db.put(docToUpdate);
    };

    // Reusable Download Helper
    const downloadDocFromFilen = async (filePath, mtimeMs) => {
      const content = await filenClient.fs().readFile({ path: filePath });
      const payload = JSON.parse(content.toString('utf-8'));
      
      const docId = payload._id;
      let existingDoc = null;
      try {
        existingDoc = await db.get(docId);
      } catch (err) {
        // Doc is new locally
      }

      // Check if this document is NOT active and has offlineUse: false
      const shouldKeepContent = (docId === activeDocId) || (payload.offlineUse !== false);
      
      const doc = {
        _id: docId,
        type: 'document',
        updatedAt: payload.updatedAt,
        title: payload.title || 'Untitled document',
        content: shouldKeepContent ? (payload.content || []) : [],
        offlineUse: payload.offlineUse !== undefined ? payload.offlineUse : true,
        createdAt: payload.createdAt || Date.now(),
        synced: true,
        lastSynced: Date.now(),
        remoteLastModified: mtimeMs
      };
      
      if (existingDoc) {
        doc._rev = existingDoc._rev;
      }
      
      await db.put(doc);
      
      if (onChangeCallback) {
        onChangeCallback({ id: docId, doc });
      }
    };

    // 4. Resolve local changes
    for (const localDoc of localDocs) {
      const remoteItem = remoteMap.get(localDoc._id);
      
      if (localDoc.remoteLastModified && !remoteItem) {
        // Synced before but deleted remotely
        await db.remove(localDoc);
      } else if (!remoteItem) {
        // Not on remote yet. Upload it!
        await uploadDocToFilen(localDoc);
      } else {
        // Compare modified dates
        if (localDoc.updatedAt > (localDoc.lastSynced || 0)) {
          // Local is newer
          await uploadDocToFilen(localDoc);
        } else if (remoteItem.stats.mtimeMs > (localDoc.remoteLastModified || 0)) {
          // Remote is newer
          await downloadDocFromFilen(remoteItem.filePath, remoteItem.stats.mtimeMs);
        } else {
          // Both are equal
          // If offlineUse has been disabled, clear content from local DB to save space (if not active)
          if (localDoc.offlineUse === false && localDoc._id !== activeDocId && localDoc.content && localDoc.content.length > 0) {
            localDoc.content = [];
            localDoc.synced = true;
            await db.put(localDoc);
          } else if (!localDoc.synced) {
            localDoc.synced = true;
            await db.put(localDoc);
          }
        }
      }
    }

    // 5. Check remote-only files
    for (const [docId, remoteItem] of remoteMap.entries()) {
      if (!localMap.has(docId)) {
        // Did we delete this document local-offline?
        const deletedDocsUpdated = await getDeletedDocsQueue();
        if (deletedDocsUpdated.includes(docId)) {
          try {
            await filenClient.fs().rm({ path: remoteItem.filePath, permanent: true });
            await removeFromDeletedDocsQueue(docId);
          } catch (err) {
            console.error(`[Sync] Clean up remote delete failed for ${docId}:`, err);
          }
        } else {
          // Download the document
          await downloadDocFromFilen(remoteItem.filePath, remoteItem.stats.mtimeMs);
        }
      }
    }

    if (onSyncStatusCallback) onSyncStatusCallback('online');
  } catch (err) {
    console.error("[Sync] Error in sync loop:", err);
    if (onSyncStatusCallback) onSyncStatusCallback('error');
  }
}
