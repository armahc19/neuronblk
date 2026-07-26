import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Boxes, Plus, Search, Sparkles, Trash2 } from "lucide-react";
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
import { functionStore, type SavedFunction } from "@/lib/functionStore";

export const Route = createFileRoute("/functions")({
  head: () => ({
    meta: [{ title: "Functions — NeuronBLK" }],
  }),
  component: FunctionsLibrary,
});

function FunctionsLibrary() {
  const navigate = useNavigate();
  const [functions, setFunctions] = useState<SavedFunction[]>([]);
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setFunctions(await functionStore.list());
  }

  useEffect(() => {
    void refresh();
    const onUpdated = () => void refresh();
    window.addEventListener("neuronblk:functions-updated", onUpdated);
    return () => window.removeEventListener("neuronblk:functions-updated", onUpdated);
  }, []);

  const filtered = functions.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()));

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    try {
      const fn = await functionStore.create(name || "untitled_function");
      setModalOpen(false);
      setName("");
      navigate({ to: "/function-editor/$functionId", params: { functionId: fn.id } });
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    await functionStore.remove(id);
    await refresh();
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Back to projects"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500 text-white shadow-soft">
              <Boxes className="h-5 w-5" strokeWidth={2.25} />
            </div>
            <span className="text-lg font-semibold tracking-tight">Functions</span>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Your saved functions</h1>
            <p className="text-sm text-muted-foreground">
              Build a function once, then call it from any project — or from another function's body — with a
              single <span className="font-medium text-foreground">Call function</span> block.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search functions"
                className="h-10 rounded-xl bg-surface pl-9"
              />
            </div>
            <Button className="h-10 rounded-xl" onClick={() => setModalOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New Function
            </Button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-surface/50 p-12 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-100 text-violet-600">
              <Sparkles className="h-6 w-6" />
            </div>
            <div className="text-base font-semibold">
              {functions.length > 0 ? "No matching functions" : "No functions yet"}
            </div>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              {functions.length > 0
                ? "Try a different search, or create a new function from scratch."
                : "Create a reusable function once — logging, formatting, an API call — and drop it into any project afterward."}
            </p>
            <Button onClick={() => setModalOpen(true)} className="mt-5 rounded-xl">
              <Plus className="mr-1.5 h-4 w-4" />
              New Function
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((f) => (
              <FunctionCard key={f.id} fn={f} onDelete={() => handleDelete(f.id)} />
            ))}
          </div>
        )}
      </section>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Create a new function</DialogTitle>
            <DialogDescription>
              Give it a name — this becomes its Python identifier, so keep it short and clear. You can rename it
              anytime in the Function Editor.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="function-name">Function name</Label>
              <Input
                id="function-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="log_message"
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

function FunctionCard({ fn, onDelete }: { fn: SavedFunction; onDelete: () => void }) {
  const updated = new Date(fn.updatedAt);
  return (
    <div className="group relative rounded-2xl border border-border bg-surface p-5 shadow-soft transition-all hover:shadow-lift hover:-translate-y-0.5">
      <Link to="/function-editor/$functionId" params={{ functionId: fn.id }} className="block">
        <div className="mb-3 flex h-16 items-center justify-center rounded-xl bg-violet-50">
          <div className="rounded-full bg-violet-500 px-3 py-1 text-xs font-semibold text-white">
            fn.call
          </div>
        </div>
        <div className="text-base font-semibold text-foreground">{fn.name}</div>
        {fn.description && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{fn.description}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {fn.params.length === 0 ? (
            <span className="text-xs text-muted-foreground">No parameters</span>
          ) : (
            fn.params.map((p) => (
              <span
                key={p.name}
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {p.name}
                {p.default ? `=${p.default}` : ""}
              </span>
            ))
          )}
        </div>
        <div className="mt-3 text-xs text-muted-foreground">
          Edited {updated.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </div>
      </Link>
      <button
        onClick={onDelete}
        className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive group-hover:opacity-100"
        aria-label="Delete function"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}