import {
  deleteEntityLocal,
  getEntityLocal,
  listEntitiesLocal,
  saveEntityLocal,
  type StoredProject,
} from "./db";
import { flushSyncQueue } from "./sync";

export type Project = {
  id: string;
  name: string;
  blocks: unknown[];
  connections: unknown[];
  updatedAt: number;
};

function toProject(s: StoredProject): Project {
  return { id: s.id, name: s.name, blocks: s.blocks, connections: s.connections, updatedAt: s.updatedAt };
}

export const projectStore = {
  async list(): Promise<Project[]> {
    const all = await listEntitiesLocal<StoredProject>("project");
    return all.map(toProject);
  },

  async get(id: string): Promise<Project | undefined> {
    const s = await getEntityLocal<StoredProject>("project", id);
    return s ? toProject(s) : undefined;
  },

  async create(name: string): Promise<Project> {
    const id = crypto.randomUUID();
    const stored = await saveEntityLocal<StoredProject>("project", { id, name, blocks: [], connections: [] });
    void flushSyncQueue();
    return toProject(stored);
  },

  async rename(id: string, name: string): Promise<void> {
    const existing = await getEntityLocal<StoredProject>("project", id);
    await saveEntityLocal<StoredProject>("project", {
      id,
      name,
      blocks: existing?.blocks ?? [],
      connections: existing?.connections ?? [],
    });
    void flushSyncQueue();
  },

  /** Persist the full canvas state — call from handleSave and/or a
   * debounced autosave effect watching [placed, connections]. */
  async saveState(id: string, name: string, blocks: unknown[], connections: unknown[]): Promise<void> {
    await saveEntityLocal<StoredProject>("project", { id, name, blocks, connections });
    void flushSyncQueue();
  },

  async remove(id: string): Promise<void> {
    await deleteEntityLocal("project", id);
    void flushSyncQueue();
  },
};