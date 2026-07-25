import {
  bumpSyncAttempt,
  clearSyncEntry,
  getPendingSync,
  getProjectLocal,
  listProjectsLocal,
  markSynced,
  saveProjectLocal,
  type SyncQueueEntry,
} from "./db";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const MAX_ATTEMPTS = 6;

/** Anonymous per-device identity, used to scope projects server-side
 * without requiring accounts yet. Swap for a real user id once auth
 * exists — the backend already treats client_id opaquely. */
function getClientId(): string {
  const key = "neuronblk_client_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
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
  if (entry.type === "delete") {
    const res = await fetch(`${API_BASE}/api/projects/${entry.projectId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`delete failed: ${res.status}`);
    return;
  }

  const project = await getProjectLocal(entry.projectId);
  if (!project) return; // was deleted locally before this upsert got pushed — nothing to do

  const res = await fetch(`${API_BASE}/api/projects/${project.id}`, {
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
  await markSynced(project.id, new Date(server.updated_at).getTime());
}

/** Pull server projects that are newer than the local copy — covers the
 * "edited on another device" case. Simple one-directional resolution by
 * timestamp; no merge UI needed since each project is single-writer in
 * practice. */
export async function pullFromServer(): Promise<void> {
  if (!navigator.onLine) return;
  try {
    const res = await fetch(`${API_BASE}/api/projects?client_id=${getClientId()}`);
    if (!res.ok) return;
    const serverProjects: Array<{
      id: string;
      name: string;
      blocks: unknown[];
      connections: unknown[];
      updated_at: string;
    }> = await res.json();

    const local = await listProjectsLocal();
    const localById = new Map(local.map((p) => [p.id, p]));

    for (const sp of serverProjects) {
      const l = localById.get(sp.id);
      const serverTime = new Date(sp.updated_at).getTime();
      if (!l || serverTime > l.updatedAt) {
        await saveProjectLocal({ id: sp.id, name: sp.name, blocks: sp.blocks, connections: sp.connections });
        await markSynced(sp.id, serverTime);
      }
    }
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