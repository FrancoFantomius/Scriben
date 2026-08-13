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
let initPromise = null;

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
  let attempts = 3;
  while (attempts > 0) {
    try {
      let existingDoc = null;
      try {
        existingDoc = await db.get(id);
      } catch (err) {
        // Document is new
      }

      let author = docObj.author;
      if (!author) {
        if (existingDoc && existingDoc.author) {
          author = existingDoc.author;
        } else {
          try {
            const settings = await getSyncSettings();
            author = settings.userId || settings.username || settings.email || 'Anonymous';
          } catch (e) {
            author = 'Anonymous';
          }
        }
      }

      const doc = {
        _id: id,
        type: 'document',
        updatedAt: docObj.updatedAt || Date.now(),
        title: docObj.title || 'Untitled document',
        author: author,
        content: docObj.content || [],
        offlineUse: docObj.offlineUse !== undefined ? docObj.offlineUse : true,
        pageFormat: docObj.pageFormat || 'a4',
        createdAt: docObj.createdAt || Date.now()
      };

      if (docObj.fontFamily) {
        doc.fontFamily = docObj.fontFamily;
      }

      if (docObj.model) {
        doc.model = docObj.model;
      }
      
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
      if ((err.name === 'conflict' || err.status === 409) && attempts > 1) {
        attempts--;
        // Wait a tiny bit and retry with the new revision
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      console.error("[DB] Failed to save document:", err);
      throw err;
    }
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
 * Fetch a document's content from Filen cloud when the local copy has been
 * pruned (offlineUse: false with empty content array).
 * Returns the updated local document with content restored, or null if
 * the document could not be fetched from the cloud.
 * @param {string} id - Document ID
 * @returns {Promise<Object|null>}
 */
export async function fetchDocumentContentFromCloud(id) {
  if (initPromise) {
    try {
      await initPromise;
    } catch (err) {
      console.warn("[Sync] Error waiting for sync initialization:", err);
    }
  }

  if (!filenClient || !filenClient.isLoggedIn()) {
    return null;
  }

  let filePath = `/Apps/Scriben/documents/${id}.json`;
  try {
    let content;
    try {
      content = await filenClient.fs().readFile({ path: filePath });
    } catch (err) {
      // Fallback to legacy path if not found in /Apps/Scriben/documents
      filePath = `/Scriben/documents/${id}.json`;
      content = await filenClient.fs().readFile({ path: filePath });
    }

    const payload = JSON.parse(content.toString('utf-8'));

    // Merge remote content into the local PouchDB record
    let localDoc;
    try {
      localDoc = await db.get(id);
    } catch (err) {
      return null;
    }

    localDoc.content = payload.content || [];
    localDoc.title = payload.title || localDoc.title;
    if (payload.author) localDoc.author = payload.author;
    if (payload.model) localDoc.model = payload.model;
    localDoc.updatedAt = payload.updatedAt || localDoc.updatedAt;
    await db.put(localDoc);

    // Re-fetch to get the updated _rev
    return await db.get(id);
  } catch (err) {
    console.warn(`[Sync] Could not fetch document ${id} from cloud:`, err);
    return null;
  }
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
        author: doc.author || 'Anonymous',
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
    initPromise = null;
    return;
  }

  if (onSyncStatusCallback) onSyncStatusCallback('syncing');

  initPromise = initFilenAndSync(settings);
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
  initPromise = null;
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
      await filenClient.fs().mkdir({ path: '/Apps' });
    } catch (e) {}
    try {
      await filenClient.fs().mkdir({ path: '/Apps/Scriben' });
    } catch (e) {}
    try {
      await filenClient.fs().mkdir({ path: '/Apps/Scriben/documents' });
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

    // Helper: Upload single doc file to /Apps/Scriben/documents
    const uploadDocToFilen = async (localDoc) => {
      const refreshedDoc = await db.get(localDoc._id);
      const authorId = refreshedDoc.author || settings.userId || settings.username || settings.email || 'Anonymous';

      const payload = {
        _id: refreshedDoc._id,
        type: refreshedDoc.type,
        updatedAt: refreshedDoc.updatedAt,
        title: refreshedDoc.title,
        author: authorId,
        content: refreshedDoc.content || [],
        offlineUse: refreshedDoc.offlineUse !== undefined ? refreshedDoc.offlineUse : true,
        pageFormat: refreshedDoc.pageFormat || 'a4',
        createdAt: refreshedDoc.createdAt || Date.now()
      };

      if (refreshedDoc.fontFamily) {
        payload.fontFamily = refreshedDoc.fontFamily;
      }

      if (refreshedDoc.model) {
        payload.model = refreshedDoc.model;
      }

      const parentUUID = await filenClient.fs().pathToItemUUID({
        path: '/Apps/Scriben/documents',
        type: 'directory'
      });

      if (!parentUUID) {
        throw new Error("Could not find /Apps/Scriben/documents directory UUID");
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

      const docToUpdate = await db.get(refreshedDoc._id);
      docToUpdate.author = authorId;
      docToUpdate.lastSynced = Date.now();
      docToUpdate.remoteLastModified = item.lastModified;
      docToUpdate.synced = true;
      await db.put(docToUpdate);
    };

    // Helper: Save index file /Apps/Scriben/index.json
    const uploadIndexToFilen = async (indexDocsArray) => {
      const parentUUID = await filenClient.fs().pathToItemUUID({
        path: '/Apps/Scriben',
        type: 'directory'
      });
      if (!parentUUID) return;

      const payload = {
        updatedAt: Date.now(),
        documents: indexDocsArray
      };

      const jsonStr = JSON.stringify(payload);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const file = new File([blob], 'index.json', {
        type: 'application/json',
        lastModified: Date.now()
      });

      await filenClient.cloud().uploadWebFile({
        file,
        parent: parentUUID,
        name: 'index.json'
      });
    };

    // 1. Read remote index file (/Apps/Scriben/index.json)
    let remoteIndexData = null;
    try {
      const indexContent = await filenClient.fs().readFile({ path: '/Apps/Scriben/index.json' });
      remoteIndexData = JSON.parse(indexContent.toString('utf-8'));
    } catch (e) {
      remoteIndexData = null;
    }

    // 2. Load all local documents
    const localResult = await db.allDocs({
      include_docs: true,
      startkey: 'doc_',
      endkey: 'doc_\ufff0'
    });
    const localDocs = localResult.rows.map(row => row.doc);
    const localMap = new Map(localDocs.map(doc => [doc._id, doc]));

    // Remote index docs map (key: doc id)
    const remoteIndexMap = new Map();
    let indexDirty = false;

    if (remoteIndexData && Array.isArray(remoteIndexData.documents)) {
      for (const entry of remoteIndexData.documents) {
        if (entry && entry.id) {
          remoteIndexMap.set(entry.id, entry);
        }
      }
    } else {
      // If index file doesn't exist yet, scan remote documents directory to build initial index
      let remoteFiles = [];
      try {
        remoteFiles = await filenClient.fs().readdir({ path: '/Apps/Scriben/documents' });
      } catch (err) {
        try {
          remoteFiles = await filenClient.fs().readdir({ path: '/Scriben/documents' });
        } catch (e) {
          remoteFiles = [];
        }
      }

      for (const filename of remoteFiles) {
        if (!filename.endsWith('.json')) continue;
        const docId = filename.substring(0, filename.length - 5);
        const filePath = filename.startsWith('/Apps') ? filename : `/Apps/Scriben/documents/${filename}`;
        try {
          const stats = await filenClient.fs().stat({ path: filePath }).catch(async () => {
            return await filenClient.fs().stat({ path: `/Scriben/documents/${filename}` });
          });
          remoteIndexMap.set(docId, {
            id: docId,
            title: localMap.get(docId)?.title || 'Untitled document',
            updatedAt: stats.mtimeMs || Date.now(),
            author: localMap.get(docId)?.author || settings.userId || 'Anonymous'
          });
        } catch (e) {}
      }
      indexDirty = true;
    }

    // 3. Process deletions against the remote index
    const deletedQueue = await getDeletedDocsQueue();
    for (const docId of deletedQueue) {
      try {
        await filenClient.fs().rm({ path: `/Apps/Scriben/documents/${docId}.json`, permanent: true }).catch(() => {});
        await filenClient.fs().rm({ path: `/Scriben/documents/${docId}.json`, permanent: true }).catch(() => {});
        if (remoteIndexMap.has(docId)) {
          remoteIndexMap.delete(docId);
          indexDirty = true;
        }
        try {
          const localDoc = await db.get(docId);
          await db.remove(localDoc);
        } catch (e) {}
        await removeFromDeletedDocsQueue(docId);
      } catch (err) {
        console.error(`[Sync] Failed to remote delete document ${docId}:`, err);
      }
    }

    // A) Process Remote Index Items
    for (const [docId, remoteDoc] of remoteIndexMap.entries()) {
      const localDoc = localMap.get(docId);

      if (!localDoc) {
        // Document exists in cloud index, but not in local PouchDB!
        // Create local document header record WITHOUT downloading full content file
        const newLocalDoc = {
          _id: docId,
          type: 'document',
          updatedAt: remoteDoc.updatedAt || Date.now(),
          title: remoteDoc.title || 'Untitled document',
          author: remoteDoc.author || settings.userId || 'Anonymous',
          content: [], // Content remains empty until fetched on demand
          offlineUse: false, // Default to online header until opened/synced
          createdAt: remoteDoc.updatedAt || Date.now(),
          synced: true,
          lastSynced: Date.now(),
          remoteLastModified: remoteDoc.updatedAt
        };
        await db.put(newLocalDoc);
        if (onChangeCallback) onChangeCallback({ id: docId, doc: newLocalDoc });
      } else {
        // Local doc exists
        if (localDoc.updatedAt > (localDoc.lastSynced || 0) && localDoc.updatedAt > (remoteDoc.updatedAt || 0)) {
          // Local is newer: upload local doc file to cloud & update remote index entry
          await uploadDocToFilen(localDoc);
          remoteIndexMap.set(docId, {
            id: localDoc._id,
            title: localDoc.title,
            updatedAt: localDoc.updatedAt,
            author: localDoc.author || settings.userId || 'Anonymous'
          });
          indexDirty = true;
        } else if ((remoteDoc.updatedAt || 0) > (localDoc.updatedAt || 0)) {
          // Remote index entry is newer
          localDoc.title = remoteDoc.title || localDoc.title;
          if (remoteDoc.author) localDoc.author = remoteDoc.author;
          localDoc.updatedAt = remoteDoc.updatedAt;
          localDoc.synced = true;
          localDoc.remoteLastModified = remoteDoc.updatedAt;
          await db.put(localDoc);
          if (onChangeCallback) onChangeCallback({ id: docId, doc: localDoc });
        } else {
          // Synced & equal
          if (!localDoc.synced || localDoc.author !== remoteDoc.author || localDoc.title !== remoteDoc.title) {
            localDoc.synced = true;
            localDoc.author = remoteDoc.author || localDoc.author;
            await db.put(localDoc);
          }
        }
      }
    }

    // B) Process Local-only Documents (not in remote index)
    for (const localDoc of localDocs) {
      if (!remoteIndexMap.has(localDoc._id)) {
        // Upload local document to cloud
        await uploadDocToFilen(localDoc);
        const refreshed = await db.get(localDoc._id);
        remoteIndexMap.set(localDoc._id, {
          id: refreshed._id,
          title: refreshed.title,
          updatedAt: refreshed.updatedAt,
          author: refreshed.author || settings.userId || 'Anonymous'
        });
        indexDirty = true;
      }
    }

    // 4. Save index file to Filen if index was changed
    if (indexDirty || !remoteIndexData) {
      const updatedDocsArray = Array.from(remoteIndexMap.values());
      await uploadIndexToFilen(updatedDocsArray);
    }

    if (onSyncStatusCallback) onSyncStatusCallback('online');
  } catch (err) {
    console.error("[Sync] Error in sync loop:", err);
    if (onSyncStatusCallback) onSyncStatusCallback('error');
  }
}
