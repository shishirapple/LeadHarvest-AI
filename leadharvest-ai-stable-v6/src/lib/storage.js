/**
 * LeadHarvest AI — IndexedDB Storage Layer
 * Provides robust local storage for all captured leads with:
 * - Deduplication by business name + address
 * - Session tracking
 * - Bulk operations
 * - Search and filtering
 * - Export helpers
 */

const DB_NAME = 'LeadHarvestDB';
const DB_VERSION = 2;
const STORE_NAME = 'leads';
const SESSION_STORE = 'sessions';

class LeadStorage {
  constructor() {
    this.db = null;
    this._initPromise = null;
  }

  /** Open (or reuse) the IndexedDB connection */
  async init() {
    if (this.db) return this.db;
    if (this._initPromise) return this._initPromise;

    this._initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Leads store
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('name', 'name', { unique: false });
          store.createIndex('phone', 'phone', { unique: false });
          store.createIndex('website', 'website', { unique: false });
          store.createIndex('source', 'source', { unique: false });
          store.createIndex('capturedAt', 'capturedAt', { unique: false });
          store.createIndex('session_id', 'session_id', { unique: false });
          store.createIndex('synced', 'synced', { unique: false });
          store.createIndex('dedup_key', 'dedup_key', { unique: true });
        }

        // Sessions store
        if (!db.objectStoreNames.contains(SESSION_STORE)) {
          db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('[LeadHarvest] IndexedDB open error:', event.target.error);
        reject(event.target.error);
      };
    });

    return this._initPromise;
  }

  /** Generate a deterministic dedup key */
  static dedupKey(record) {
    const parts = [
      (record.name || '').toLowerCase().trim(),
      (record.phone || '').replace(/[\s\-\(\)]/g, ''),
      (record.address || '').toLowerCase().trim().substring(0, 50),
    ].filter(Boolean);
    return parts.join('||') || crypto.randomUUID();
  }

  /** Add a lead with automatic deduplication */
  async addLead(record) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const dedupKey = LeadStorage.dedupKey(record);

      // Check for existing record with same dedup key
      const getReq = store.index('dedup_key').get(dedupKey);
      getReq.onsuccess = () => {
        if (getReq.result) {
          resolve({ ok: true, duplicate: true, existing: getReq.result });
          return;
        }

        const lead = {
          id: crypto.randomUUID(),
          dedup_key: dedupKey,
          name: record.name || '',
          phone: record.phone || null,
          email: record.email || null,
          website: record.website || null,
          address: record.address || null,
          category: record.category || null,
          niche: record.niche || 'other',
          nicheConfidence: record.nicheConfidence || 0,
          rating: record.rating || null,
          reviews: record.reviews || null,
          googleAds: record.googleAds || false,
          websitePlatform: record.websitePlatform || null,
          leadScore: record.leadScore || null,
          hours: record.hours || null,
          source: record.source || 'maps',
          session_id: record.session_id || null,
          synced: false,
          syncedAt: null,
          capturedAt: new Date().toISOString(),
          rawData: record.rawData || null,
        };

        const addReq = store.add(lead);
        addReq.onsuccess = () => resolve({ ok: true, duplicate: false, lead });
        addReq.onerror = () => reject(addReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /** Bulk add leads */
  async addLeads(records, sessionId) {
    const results = [];
    for (const record of records) {
      const r = await this.addLead({ ...record, session_id: sessionId });
      results.push(r);
    }
    return results;
  }

  /** Get all leads with optional filters */
  async getLeads(filters = {}) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        let leads = request.result;

        if (filters.source) {
          leads = leads.filter(l => l.source === filters.source);
        }
        if (filters.synced !== undefined) {
          leads = leads.filter(l => l.synced === filters.synced);
        }
        if (filters.session_id) {
          leads = leads.filter(l => l.session_id === filters.session_id);
        }
        if (filters.search) {
          const q = filters.search.toLowerCase();
          leads = leads.filter(l =>
            l.name.toLowerCase().includes(q) ||
            (l.phone && l.phone.includes(q)) ||
            (l.address && l.address.toLowerCase().includes(q)) ||
            (l.email && l.email.toLowerCase().includes(q)) ||
            (l.website && l.website.toLowerCase().includes(q))
          );
        }

        // Sort by capture time, newest first
        leads.sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));

        if (filters.limit) {
          leads = leads.slice(0, filters.limit);
        }

        resolve(leads);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /** Mark leads as synced */
  async markSynced(ids, sheetId) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const updated = [];

      for (const id of ids) {
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          if (getReq.result) {
            const lead = getReq.result;
            lead.synced = true;
            lead.syncedAt = new Date().toISOString();
            lead.syncSheetId = sheetId;
            store.put(lead);
            updated.push(lead);
          }
        };
      }

      tx.oncomplete = () => resolve(updated);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Mark a single lead as synced */
  async markOneSynced(id, sheetId) {
    return this.markSynced([id], sheetId);
  }

  /** Delete leads by IDs */
  async deleteLeads(ids) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const id of ids) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve({ deleted: ids.length });
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Clear all leads */
  async clearAll() {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve({ ok: true });
      req.onerror = () => reject(req.error);
    });
  }

  /** Get statistics */
  async getStats() {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();

      req.onsuccess = () => {
        const leads = req.result;
        const now = new Date();
        const today = now.toISOString().slice(0, 10);

        resolve({
          total: leads.length,
          synced: leads.filter(l => l.synced).length,
          unsynced: leads.filter(l => !l.synced).length,
          today: leads.filter(l => l.capturedAt?.startsWith(today)).length,
          ads: leads.filter(l => l.googleAds).length,
          bySource: {
            maps: leads.filter(l => l.source === 'maps').length,
          },
          duplicates: leads.length > 0 ? 0 : 0, // dedup prevents duplicates
        });
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** Create a new session */
  async createSession(query, fields, limit) {
    const db = await this.init();
    const session = {
      id: crypto.randomUUID(),
      query,
      fields,
      limit,
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      capturedCount: 0,
      errorCount: 0,
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      const store = tx.objectStore(SESSION_STORE);
      const req = store.add(session);
      req.onsuccess = () => resolve(session);
      req.onerror = () => reject(req.error);
    });
  }

  /** Update session status */
  async updateSession(sessionId, updates) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      const store = tx.objectStore(SESSION_STORE);
      const req = store.get(sessionId);
      req.onsuccess = () => {
        if (req.result) {
          const session = { ...req.result, ...updates };
          store.put(session);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Get recent sessions */
  async getSessions(limit = 10) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readonly');
      const store = tx.objectStore(SESSION_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const sessions = req.result.sort(
          (a, b) => new Date(b.startedAt) - new Date(a.startedAt)
        ).slice(0, limit);
        resolve(sessions);
      };
      req.onerror = () => reject(req.error);
    });
  }
}

// Export as global for content scripts
window.LeadStorage = LeadStorage;
