export type Project = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

const KEY = "neuronblk.projects";

function read(): Project[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Project[];
  } catch {
    return [];
  }
}

function write(projects: Project[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(projects));
}

export const projectStore = {
  list(): Project[] {
    return read().sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get(id: string): Project | undefined {
    return read().find((p) => p.id === id);
  },
  create(name: string): Project {
    const project: Project = {
      id: crypto.randomUUID(),
      name: name.trim() || "Untitled Project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    write([project, ...read()]);
    return project;
  },
  rename(id: string, name: string) {
    const list = read().map((p) =>
      p.id === id ? { ...p, name, updatedAt: Date.now() } : p,
    );
    write(list);
  },
  remove(id: string) {
    write(read().filter((p) => p.id !== id));
  },
};
