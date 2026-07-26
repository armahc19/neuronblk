import {
  deleteEntityLocal,
  getEntityLocal,
  listEntitiesLocal,
  saveEntityLocal,
  type StoredFunction,
} from "./db";
import { flushSyncQueue } from "./sync";

export type FunctionParam = { name: string; default?: string };

export type SavedFunction = {
  id: string;
  name: string;
  description: string;
  params: FunctionParam[];
  blocks: unknown[];
  connections: unknown[];
  updatedAt: number;
};

function toSavedFunction(s: StoredFunction): SavedFunction {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    params: s.params,
    blocks: s.blocks,
    connections: s.connections,
    updatedAt: s.updatedAt,
  };
}

export const functionStore = {
  async list(): Promise<SavedFunction[]> {
    const all = await listEntitiesLocal<StoredFunction>("function");
    return all.map(toSavedFunction);
  },

  async get(id: string): Promise<SavedFunction | undefined> {
    const s = await getEntityLocal<StoredFunction>("function", id);
    return s ? toSavedFunction(s) : undefined;
  },

  async create(name: string): Promise<SavedFunction> {
    const id = crypto.randomUUID();
    const stored = await saveEntityLocal<StoredFunction>("function", {
      id,
      name,
      description: "",
      params: [],
      blocks: [],
      connections: [],
    });
    void flushSyncQueue();
    return toSavedFunction(stored);
  },

  async rename(id: string, name: string): Promise<void> {
    const existing = await getEntityLocal<StoredFunction>("function", id);
    await saveEntityLocal<StoredFunction>("function", {
      id,
      name,
      description: existing?.description ?? "",
      params: existing?.params ?? [],
      blocks: existing?.blocks ?? [],
      connections: existing?.connections ?? [],
    });
    void flushSyncQueue();
  },

  async setParams(id: string, params: FunctionParam[]): Promise<void> {
    const existing = await getEntityLocal<StoredFunction>("function", id);
    if (!existing) return;
    await saveEntityLocal<StoredFunction>("function", {
      id,
      name: existing.name,
      description: existing.description,
      params,
      blocks: existing.blocks,
      connections: existing.connections,
    });
    void flushSyncQueue();
  },

  /** Persist the full function state (name, params, and body) — call
   * from a debounced autosave effect in the Function Editor, same
   * pattern as projectStore.saveState. */
  async saveState(
    id: string,
    name: string,
    description: string,
    params: FunctionParam[],
    blocks: unknown[],
    connections: unknown[],
  ): Promise<void> {
    await saveEntityLocal<StoredFunction>("function", { id, name, description, params, blocks, connections });
    void flushSyncQueue();
  },

  async remove(id: string): Promise<void> {
    await deleteEntityLocal("function", id);
    void flushSyncQueue();
  },
};