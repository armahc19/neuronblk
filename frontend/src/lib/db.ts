const DB_NAME = "neuronblk";
const DB_VERSION = 2;
const PROJECTS_STORE = "projects";
const FUNCTIONS_STORE = "functions";
const SYNC_QUEUE_STORE = "sync_queue";

export type EntityKind = "project" | "function";

function storeNameFor(kind: EntityKind) {
  return kind === "project" ? PROJECTS_STORE : FUNCTIONS_STORE;
}

export type StoredProject = {
  id: string;
  name: string;
  blocks: unknown[];
  connections: unknown[];
  /** epoch ms — compared against the server's updated_at for sync */
  updatedAt: number;
  /** true if this record has local changes not yet pushed to the server */
  dirty: boolean;
};

export type StoredFunction = {
  id: string;
  name: string;
  description: string;
  /** Declared parameters — fn.call blocks referencing this function
   * render one inline field per entry, pre-filled with its default. */
  params: { name: string; default?: string }[];
  blocks: unknown[];
  connections: unknown[];
  updatedAt: number;
  dirty: boolean;
};

export type SyncQueueEntry = {
  /** `${kind}:${entityId}` — composite so a project and a function can
   * never collide in the queue even if ids were ever reused. Only one
   * pending op per entity is kept, since a later upsert/delete
   * supersedes an earlier one for the same entity. */
  id: string;
  kind: EntityKind;
  entityId: string;
  type: "upsert" | "delete";
  createdAt: number;
  attempts: number;
  lastError?: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Versioned schema: bump DB_VERSION and add migration logic here
      // whenever the shape of a store changes. v2 adds the "functions"
      // store; existing "projects"/"sync_queue" data from v1 installs is
      // left untouched (IndexedDB upgrades are additive by default).
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(FUNCTIONS_STORE)) {
        db.createObjectStore(FUNCTIONS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SYNC_QUEUE_STORE)) {
        db.createObjectStore(SYNC_QUEUE_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function store(db: IDBDatabase, name: string, mode: IDBTransactionMode) {
  return db.transaction(name, mode).objectStore(name);
}

function toPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- Generic entity storage (projects and functions share this) ----

export async function saveEntityLocal<T extends { id: string; updatedAt: number; dirty: boolean }>(
  kind: EntityKind,
  entity: Omit<T, "updatedAt" | "dirty">,
): Promise<T> {
  const db = await openDB();
  const record = { ...entity, updatedAt: Date.now(), dirty: true } as T;
  await toPromise(store(db, storeNameFor(kind), "readwrite").put(record));
  await enqueueSync(kind, entity.id);
  return record;
}

/** Writes data pulled from the server — does NOT mark dirty or enqueue a
 * push, since it just came from the server and pushing it right back
 * would be a pointless round-trip. */
export async function saveEntityFromServer<T extends { id: string; updatedAt: number; dirty: boolean }>(
  kind: EntityKind,
  entity: Omit<T, "updatedAt" | "dirty">,
  serverUpdatedAt: number,
): Promise<T> {
  const db = await openDB();
  const record = { ...entity, updatedAt: serverUpdatedAt, dirty: false } as T;
  await toPromise(store(db, storeNameFor(kind), "readwrite").put(record));
  return record;
}

export async function getEntityLocal<T>(kind: EntityKind, id: string): Promise<T | undefined> {
  const db = await openDB();
  return toPromise(store(db, storeNameFor(kind), "readonly").get(id));
}

export async function listEntitiesLocal<T>(kind: EntityKind): Promise<T[]> {
  const db = await openDB();
  return toPromise(store(db, storeNameFor(kind), "readonly").getAll());
}

export async function deleteEntityLocal(kind: EntityKind, id: string): Promise<void> {
  const db = await openDB();
  await toPromise(store(db, storeNameFor(kind), "readwrite").delete(id));
  await enqueueDelete(kind, id);
}

export async function markEntitySynced(kind: EntityKind, id: string, serverUpdatedAt: number): Promise<void> {
  const db = await openDB();
  const s = store(db, storeNameFor(kind), "readwrite");
  const existing = await toPromise(s.get(id));
  if (existing) {
    existing.dirty = false;
    existing.updatedAt = serverUpdatedAt;
    await toPromise(s.put(existing));
  }
}

// ---- Sync queue (outbox pattern), shared across entity kinds ----

export async function enqueueSync(kind: EntityKind, entityId: string): Promise<void> {
  const db = await openDB();
  const s = store(db, SYNC_QUEUE_STORE, "readwrite");
  const queueId = `${kind}:${entityId}`;
  const existing: SyncQueueEntry | undefined = await toPromise(s.get(queueId));
  const entry: SyncQueueEntry = {
    id: queueId,
    kind,
    entityId,
    type: "upsert",
    createdAt: existing?.createdAt ?? Date.now(),
    attempts: 0,
  };
  await toPromise(s.put(entry));
}

export async function enqueueDelete(kind: EntityKind, entityId: string): Promise<void> {
  const db = await openDB();
  const entry: SyncQueueEntry = {
    id: `${kind}:${entityId}`,
    kind,
    entityId,
    type: "delete",
    createdAt: Date.now(),
    attempts: 0,
  };
  await toPromise(store(db, SYNC_QUEUE_STORE, "readwrite").put(entry));
}

export async function getPendingSync(): Promise<SyncQueueEntry[]> {
  const db = await openDB();
  return toPromise(store(db, SYNC_QUEUE_STORE, "readonly").getAll());
}

export async function clearSyncEntry(queueId: string): Promise<void> {
  const db = await openDB();
  await toPromise(store(db, SYNC_QUEUE_STORE, "readwrite").delete(queueId));
}

export async function bumpSyncAttempt(queueId: string, error: string): Promise<void> {
  const db = await openDB();
  const s = store(db, SYNC_QUEUE_STORE, "readwrite");
  const entry: SyncQueueEntry | undefined = await toPromise(s.get(queueId));
  if (entry) {
    entry.attempts += 1;
    entry.lastError = error;
    await toPromise(s.put(entry));
  }
}