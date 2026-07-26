import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Boxes,
  Plus,
  Search,
  Clock,
  Sparkles,
  ArrowRight,
  Trash2,
  Zap,
  Workflow,
  Braces,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { projectStore, type Project } from "@/lib/projectStore";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NeuronBLK — Build Python & AI visually" },
      {
        name: "description",
        content:
          "NeuronBLK is a next-generation visual IDE for building Python applications and AI workflows with blocks.",
      },
      { property: "og:title", content: "NeuronBLK — Build Python & AI visually" },
      {
        property: "og:description",
        content:
          "Drag blocks, connect logic, and run instantly. Google Colab meets Canva for developers.",
      },
    ],
  }),
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setProjects(await projectStore.list());
  }

  useEffect(() => {
    void refresh();
    // A background pull (from startSyncManager, e.g. on app load or
    // reconnect) can update IndexedDB after this page's initial read —
    // without this, a newer project fetched from the server wouldn't
    // show up until a manual reload.
    const onUpdated = () => void refresh();
    window.addEventListener("neuronblk:projects-updated", onUpdated);
    return () => window.removeEventListener("neuronblk:projects-updated", onUpdated);
  }, []);

  const filtered = projects.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return; // guard against double-submit while awaiting
    setCreating(true);
    try {
      const project = await projectStore.create(name || "Untitled Project");
      setModalOpen(false);
      setName("");
      navigate({ to: "/editor/$projectId", params: { projectId: project.id } });
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    await projectStore.remove(id);
    await refresh();
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-soft">
              <Boxes className="h-5 w-5" strokeWidth={2.25} />
            </div>
            <span className="text-lg font-semibold tracking-tight">NeuronBLK</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link className="hover:text-foreground transition-colors" to="/functions">Functions</Link>
            <span className="text-border">·</span>
            <a className="hover:text-foreground transition-colors" href="#">Docs</a>
            <span className="text-border">·</span>
            <a className="hover:text-foreground transition-colors" href="#">Templates</a>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 pt-16 pb-10">
        <div className="flex flex-col items-start gap-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted-foreground shadow-soft">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Visual programming, built for real developers
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Build Python apps and AI workflows,
            <br />
            <span className="text-primary">block by block.</span>
          </h1>
          <p className="max-w-2xl text-base text-muted-foreground sm:text-lg">
            A modern visual IDE that feels as clean as Colab and as intuitive as Canva.
            Design logic on an infinite canvas, generate production-quality Python, and run it instantly.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button size="lg" className="rounded-xl" onClick={() => setModalOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New Project
            </Button>
            <Button size="lg" variant="outline" className="rounded-xl" asChild>
              <a href="#recent">Browse projects <ArrowRight className="ml-1.5 h-4 w-4" /></a>
            </Button>
          </div>

          <div className="mt-8 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
            <FeatureCard icon={Workflow} title="Infinite canvas" body="Wire blocks together on a spacious node-editor style workspace." />
            <FeatureCard icon={Braces} title="Real Python output" body="Every canvas compiles to clean, readable Python you can inspect and edit." />
            <FeatureCard icon={Zap} title="AI blocks included" body="Add chat, classification, and image generation with a single block." />
          </div>
        </div>
      </section>

      <section id="recent" className="mx-auto max-w-6xl px-6 pb-24">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Recent projects</h2>
            <p className="text-sm text-muted-foreground">Pick up where you left off.</p>
          </div>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects"
              className="h-10 rounded-xl bg-surface pl-9"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState onCreate={() => setModalOpen(true)} hasProjects={projects.length > 0} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((p) => (
              <ProjectCard key={p.id} project={p} onDelete={() => handleDelete(p.id)} />
            ))}
          </div>
        )}
      </section>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Create a new project</DialogTitle>
            <DialogDescription>
              Give your project a name. You can rename it anytime in the editor.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My AI workflow"
                className="h-11 rounded-xl"
              />
            </div>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="ghost" onClick={() => setModalOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className="rounded-xl" disabled={creating}>
                {creating ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Zap;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5 shadow-soft">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-primary-soft text-primary">
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="text-sm font-semibold">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function ProjectCard({ project, onDelete }: { project: Project; onDelete: () => void }) {
  const updated = new Date(project.updatedAt);
  return (
    <div className="group relative rounded-2xl border border-border bg-surface p-5 shadow-soft transition-all hover:shadow-lift hover:-translate-y-0.5">
      <Link
        to="/editor/$projectId"
        params={{ projectId: project.id }}
        className="block"
      >
        <div className="mb-4 flex h-24 items-center justify-center rounded-xl bg-primary-soft/60">
          <div className="flex gap-1.5">
            <div className="h-3 w-10 rounded-full bg-primary/70" />
            <div className="h-3 w-6 rounded-full bg-block-ai/70" />
            <div className="h-3 w-8 rounded-full bg-block-data/70" />
          </div>
        </div>
        <div className="text-base font-semibold text-foreground">{project.name}</div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          Edited {updated.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </div>
      </Link>
      <button
        onClick={onDelete}
        className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive group-hover:opacity-100"
        aria-label="Delete project"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function EmptyState({ onCreate, hasProjects }: { onCreate: () => void; hasProjects: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface/50 p-12 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary">
        <Boxes className="h-6 w-6" />
      </div>
      <div className="text-base font-semibold">
        {hasProjects ? "No matching projects" : "No projects yet"}
      </div>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        {hasProjects
          ? "Try a different search, or start a new project from scratch."
          : "Create your first project to start building visually."}
      </p>
      <Button onClick={onCreate} className="mt-5 rounded-xl">
        <Plus className="mr-1.5 h-4 w-4" />
        New Project
      </Button>
    </div>
  );
}