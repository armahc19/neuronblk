import {
  bumpSyncAttempt,
  clearSyncEntry,
  getEntityLocal,
  getPendingSync,
  listEntitiesLocal,
  markEntitySynced,
  saveEntityFromServer,
  type EntityKind,
  type StoredFunction,
  type StoredProject,
  type SyncQueueEntry,
} from "./db";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const MAX_ATTEMPTS = 6;

/** Anonymous per-device identity, used to scope projects/functions
 * server-side without requiring accounts yet. Swap for a real user id
 * once auth exists — the backend already treats client_id opaquely. */
function getClientId(): string {
  const key = "neuronblk_client_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function apiPathFor(kind: EntityKind) {
  return kind === "project" ? "/api/projects" : "/api/functions";
}

let flushing = false;

export async function flushSyncQueue(): Promise<void> {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const pending = await getPendingSync();
    for (const entry of pending) {
      if (entry.attempts >= MAX_ATTEMPTS) continue; // give up, but leave it queued for manual inspection
      try {
        await syncOne(entry);
        await clearSyncEntry(entry.id);
      } catch (err) {
        await bumpSyncAttempt(entry.id, String(err));
      }
    }
  } finally {
    flushing = false;
  }
}

async function syncOne(entry: SyncQueueEntry): Promise<void> {
  const base = apiPathFor(entry.kind);

  if (entry.type === "delete") {
    const res = await fetch(`${API_BASE}${base}/${entry.entityId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`delete failed: ${res.status}`);
    return;
  }

  if (entry.kind === "project") {
    const project = await getEntityLocal<StoredProject>(entry.kind, entry.entityId);
    if (!project) return; // was deleted locally before this upsert got pushed — nothing to do
    const res = await fetch(`${API_BASE}${base}/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: project.id,
        client_id: getClientId(),
        name: project.name,
        blocks: project.blocks,
        connections: project.connections,
        updated_at: new Date(project.updatedAt).toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`sync failed: ${res.status}`);
    const server = await res.json();
    await markEntitySynced(entry.kind, project.id, new Date(server.updated_at).getTime());
    return;
  }

  // kind === "function"
  const fn = await getEntityLocal<StoredFunction>(entry.kind, entry.entityId);
  if (!fn) return;
  const res = await fetch(`${API_BASE}${base}/${fn.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: fn.id,
      client_id: getClientId(),
      name: fn.name,
      params: fn.params,
      blocks: fn.blocks,
      connections: fn.connections,
      updated_at: new Date(fn.updatedAt).toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`sync failed: ${res.status}`);
  const server = await res.json();
  await markEntitySynced(entry.kind, fn.id, new Date(server.updated_at).getTime());
}

async function pullKind(kind: EntityKind): Promise<boolean> {
  const res = await fetch(`${API_BASE}${apiPathFor(kind)}?client_id=${getClientId()}`);
  if (!res.ok) return false;
  const serverItems: Array<Record<string, any>> = await res.json();

  const local = await listEntitiesLocal<StoredProject | StoredFunction>(kind);
  const localById = new Map(local.map((p) => [p.id, p]));

  let changed = false;
  for (const item of serverItems) {
    const l = localById.get(item.id);
    const serverTime = new Date(item.updated_at).getTime();
    if (!l || serverTime > l.updatedAt) {
      if (kind === "project") {
        await saveEntityFromServer<StoredProject>(
          kind,
          { id: item.id, name: item.name, blocks: item.blocks, connections: item.connections },
          serverTime,
        );
      } else {
        await saveEntityFromServer<StoredFunction>(
          kind,
          {
            id: item.id,
            name: item.name,
            description: item.description ?? "",
            params: item.params ?? [],
            blocks: item.blocks,
            connections: item.connections,
          },
          serverTime,
        );
      }
      changed = true;
    }
  }
  return changed;
}

/** Pull server projects and functions that are newer than the local
 * copy — covers the "edited on another device" case. Simple
 * one-directional resolution by timestamp; no merge UI needed since
 * each entity is single-writer in practice. Dispatches
 * "neuronblk:projects-updated" / "neuronblk:functions-updated" if
 * anything actually changed, so mounted UI knows to re-read from
 * IndexedDB instead of showing whatever it already had in memory. */
export async function pullFromServer(): Promise<void> {
  if (!navigator.onLine) return;
  try {
    const [projectsChanged, functionsChanged] = await Promise.all([
      pullKind("project").catch(() => false),
      pullKind("function").catch(() => false),
    ]);
    if (projectsChanged) window.dispatchEvent(new CustomEvent("neuronblk:projects-updated"));
    if (functionsChanged) window.dispatchEvent(new CustomEvent("neuronblk:functions-updated"));
  } catch {
    // Offline or backend unreachable — local-first means this is fine,
    // the app keeps working off IndexedDB and retries later.
  }
}

let syncManagerStarted = false;

/** Wire this up once, e.g. in your root route's useEffect. Safe to call
 * more than once — subsequent calls are no-ops — so React StrictMode's
 * dev-mode double-invocation of effects won't register duplicate
 * listeners or intervals. Returns a cleanup function. */
export function startSyncManager(): () => void {
  if (syncManagerStarted) {
    return () => {};
  }
  syncManagerStarted = true;

  const onOnline = () => flushSyncQueue();
  const onVisible = () => {
    if (document.visibilityState === "visible") flushSyncQueue();
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);

  pullFromServer().then(flushSyncQueue);
  const interval = setInterval(flushSyncQueue, 30_000);

  return () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(interval);
    syncManagerStarted = false;
  };
}