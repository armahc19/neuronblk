const DB_NAME = "neuronblk";
const DB_VERSION = 1;
const PROJECTS_STORE = "projects";
const SYNC_QUEUE_STORE = "sync_queue";

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

export type SyncQueueEntry = {
  /** == projectId — only one pending op per project needed, since a
   * later upsert/delete supersedes an earlier one for the same project. */
  id: string;
  projectId: string;
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
      // (e.g. db.createObjectStore for new stores, or copy+transform data
      // for field changes) whenever the shape of StoredProject changes.
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
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

// ---- Projects ----

export async function saveProjectLocal(
  project: Pick<StoredProject, "id" | "name" | "blocks" | "connections">,
): Promise<StoredProject> {
  const db = await openDB();
  const record: StoredProject = { ...project, updatedAt: Date.now(), dirty: true };
  await toPromise(store(db, PROJECTS_STORE, "readwrite").put(record));
  await enqueueSync(project.id);
  return record;
}

/** Writes data pulled from the server. Unlike saveProjectLocal, this does
 * NOT mark the record dirty or enqueue a sync push — the data just came
 * from the server, so pushing it right back would be a pointless
 * round-trip (and, in a race, could shadow the fix in markSynced). */
export async function saveProjectFromServer(
  project: Pick<StoredProject, "id" | "name" | "blocks" | "connections">,
  serverUpdatedAt: number,
): Promise<StoredProject> {
  const db = await openDB();
  const record: StoredProject = { ...project, updatedAt: serverUpdatedAt, dirty: false };
  await toPromise(store(db, PROJECTS_STORE, "readwrite").put(record));
  return record;
}

export async function getProjectLocal(id: string): Promise<StoredProject | undefined> {
  const db = await openDB();
  return toPromise(store(db, PROJECTS_STORE, "readonly").get(id));
}

export async function listProjectsLocal(): Promise<StoredProject[]> {
  const db = await openDB();
  return toPromise(store(db, PROJECTS_STORE, "readonly").getAll());
}

export async function deleteProjectLocal(id: string): Promise<void> {
  const db = await openDB();
  await toPromise(store(db, PROJECTS_STORE, "readwrite").delete(id));
  await enqueueDelete(id);
}

/** Called after a successful push to the server, or after pulling a
 * server-authoritative copy — clears the dirty flag. */
export async function markSynced(id: string, serverUpdatedAt: number): Promise<void> {
  const db = await openDB();
  const s = store(db, PROJECTS_STORE, "readwrite");
  const existing = await toPromise(s.get(id));
  if (existing) {
    existing.dirty = false;
    existing.updatedAt = serverUpdatedAt;
    await toPromise(s.put(existing));
  }
}

// ---- Sync queue (outbox pattern) ----

export async function enqueueSync(projectId: string): Promise<void> {
  const db = await openDB();
  const s = store(db, SYNC_QUEUE_STORE, "readwrite");
  const existing: SyncQueueEntry | undefined = await toPromise(s.get(projectId));
  const entry: SyncQueueEntry = {
    id: projectId,
    projectId,
    type: "upsert",
    createdAt: existing?.createdAt ?? Date.now(),
    attempts: 0,
  };
  await toPromise(s.put(entry));
}

export async function enqueueDelete(projectId: string): Promise<void> {
  const db = await openDB();
  const entry: SyncQueueEntry = {
    id: projectId,
    projectId,
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

export async function clearSyncEntry(id: string): Promise<void> {
  const db = await openDB();
  await toPromise(store(db, SYNC_QUEUE_STORE, "readwrite").delete(id));
}

export async function bumpSyncAttempt(id: string, error: string): Promise<void> {
  const db = await openDB();
  const s = store(db, SYNC_QUEUE_STORE, "readwrite");
  const entry: SyncQueueEntry | undefined = await toPromise(s.get(id));
  if (entry) {
    entry.attempts += 1;
    entry.lastError = error;
    await toPromise(s.put(entry));
  }
}