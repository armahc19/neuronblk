import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  Play,
  Save,
  Settings,
  Search,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Code2,
  TerminalSquare,
  ScrollText,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { BLOCK_CATEGORIES, getBlockDef, type BlockDef, type BlockField } from "@/lib/blocks";
import { projectStore, type Project } from "@/lib/projects";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/editor/$projectId")({
  component: Editor,
});

type PlacedBlock = {
  instanceId: string;
  defId: string;
  x: number;
  y: number;
  values: Record<string, string>;
};

type Connection = { id: string; from: string; to: string };

const BLOCK_W = 260;
// Approximate anchor height used only for connector-line math; actual
// rendered block height can vary slightly (auto), which is fine visually.
const BLOCK_H = 100;

function portOut(b: PlacedBlock) {
  return { x: b.x + BLOCK_W / 2, y: b.y + BLOCK_H };
}
function portIn(b: PlacedBlock) {
  return { x: b.x + BLOCK_W / 2, y: b.y };
}

function Editor() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [query, setQuery] = useState("");
  const [placed, setPlaced] = useState<PlacedBlock[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [pending, setPending] = useState<{ from: string; x: number; y: number } | null>(null);
  const hoveredInputRef = useRef<string | null>(null);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [terminal, setTerminal] = useState<string[]>([]);
  const [ranOnce, setRanOnce] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const p = projectStore.get(projectId);
    if (!p) {
      navigate({ to: "/" });
      return;
    }
    setProject(p);
    setNameDraft(p.name);
  }, [projectId, navigate]);

  const filteredCategories = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return BLOCK_CATEGORIES;
    return BLOCK_CATEGORIES.map((c) => ({
      ...c,
      blocks: c.blocks.filter(
        (b) =>
          b.label.toLowerCase().includes(q) ||
          b.description.toLowerCase().includes(q),
      ),
    })).filter((c) => c.blocks.length > 0);
  }, [query]);

  const orderedBlocks = useMemo(() => orderByConnections(placed, connections), [placed, connections]);
  const generatedPython = useMemo(() => generatePython(project?.name, orderedBlocks), [project?.name, orderedBlocks]);

  function commitName() {
    setEditingName(false);
    if (!project) return;
    const name = nameDraft.trim() || project.name;
    projectStore.rename(project.id, name);
    setProject({ ...project, name });
  }

  function handleSave() {
    if (!project) return;
    projectStore.rename(project.id, project.name);
    toast.success("Project saved", { description: "All changes are stored locally." });
  }

  function handleRun() {
    setRunning(true);
    setBottomOpen(true);
    setTerminal([]);
    setLogs([`[${new Date().toLocaleTimeString()}] Starting run…`]);
    setTimeout(() => {
      if (placed.length === 0) {
        setLogs((l) => [...l, `[${new Date().toLocaleTimeString()}] No blocks on the canvas. Nothing to run.`]);
      } else {
        setTerminal([
          "> python main.py",
          ...orderedBlocks.map((b) => `→ ${getBlockDef(b.defId)?.label ?? b.defId}`),
          "Done in 0.42s",
        ]);
        setLogs((l) => [...l, `[${new Date().toLocaleTimeString()}] Run finished successfully.`]);
      }
      setRunning(false);
      setRanOnce(true);
    }, 800);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-neuronblk-block");
    if (!raw) return;
    const def = JSON.parse(raw) as BlockDef;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scrollLeft = canvasRef.current?.scrollLeft ?? 0;
    const scrollTop = canvasRef.current?.scrollTop ?? 0;
    const x = e.clientX - rect.left + scrollLeft - BLOCK_W / 2;
    const y = e.clientY - rect.top + scrollTop - 24;
    const values: Record<string, string> = {};
    def.fields?.forEach((f) => {
      values[f.name] = f.default ?? "";
    });
    setPlaced((prev) => [
      ...prev,
      { instanceId: crypto.randomUUID(), defId: def.id, x: Math.max(16, x), y: Math.max(16, y), values },
    ]);
  }

  function updateBlock(id: string, patch: Partial<PlacedBlock>) {
    setPlaced((prev) => prev.map((b) => (b.instanceId === id ? { ...b, ...patch } : b)));
  }

  function updateValue(id: string, field: string, value: string) {
    setPlaced((prev) =>
      prev.map((b) => (b.instanceId === id ? { ...b, values: { ...b.values, [field]: value } } : b)),
    );
  }

  function removeBlock(id: string) {
    setPlaced((prev) => prev.filter((b) => b.instanceId !== id));
    setConnections((prev) => prev.filter((c) => c.from !== id && c.to !== id));
  }

  function startConnect(fromId: string, clientX: number, clientY: number) {
    const rect = canvasRef.current!.getBoundingClientRect();
    const scrollLeft = canvasRef.current!.scrollLeft;
    const scrollTop = canvasRef.current!.scrollTop;
    setPending({ from: fromId, x: clientX - rect.left + scrollLeft, y: clientY - rect.top + scrollTop });
    const move = (ev: MouseEvent) => {
      const r = canvasRef.current!.getBoundingClientRect();
      setPending({
        from: fromId,
        x: ev.clientX - r.left + canvasRef.current!.scrollLeft,
        y: ev.clientY - r.top + canvasRef.current!.scrollTop,
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const target = hoveredInputRef.current;
      if (target && target !== fromId) {
        setConnections((prev) => [
          ...prev.filter((c) => !(c.to === target) && !(c.from === fromId)),
          { id: crypto.randomUUID(), from: fromId, to: target },
        ]);
      }
      hoveredInputRef.current = null;
      setPending(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  if (!project) return null;

  const blockById = new Map(placed.map((b) => [b.instanceId, b]));

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Back to home"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-soft">
              <Boxes className="h-4 w-4" strokeWidth={2.25} />
            </div>
            <span className="text-sm font-semibold tracking-tight">NeuronBLK</span>
          </div>
          <div className="mx-2 h-5 w-px bg-border" />
          {editingName ? (
            <Input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName();
                if (e.key === "Escape") {
                  setNameDraft(project.name);
                  setEditingName(false);
                }
              }}
              className="h-8 w-64 rounded-lg text-sm"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="rounded-lg px-2 py-1 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              {project.name}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={handleRun} disabled={running} size="sm" className="h-9 rounded-lg px-3.5 shadow-soft">
            <Play className="mr-1.5 h-3.5 w-3.5" fill="currentColor" />
            {running ? "Running…" : "Run"}
          </Button>
          <Button onClick={handleSave} variant="outline" size="sm" className="h-9 rounded-lg px-3.5">
            <Save className="mr-1.5 h-3.5 w-3.5" />
            Save
          </Button>
          <div className="ml-1 h-5 w-px bg-border" />
          <button
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Settings"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-primary text-xs font-semibold hover:bg-primary/15 transition-colors"
            aria-label="Profile"
          >
            NB
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-surface">
          <div className="p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search blocks"
                className="h-9 rounded-lg bg-background pl-8 text-sm"
              />
            </div>
          </div>
          <div className="scrollbar-thin flex-1 overflow-y-auto px-3 pb-4">
            {filteredCategories.map((cat) => (
              <div key={cat.id} className="mb-4">
                <div className="mb-1.5 flex items-center gap-2 px-1">
                  <cat.icon className={cn("h-3.5 w-3.5")} style={{ color: `var(--color-block-${cat.color})` }} />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {cat.name}
                  </span>
                </div>
                <div className="space-y-1">
                  {cat.blocks.map((b) => (
                    <DraggableBlock key={b.id} block={b} color={cat.color} />
                  ))}
                </div>
              </div>
            ))}
            {filteredCategories.length === 0 && (
              <div className="mt-8 text-center text-xs text-muted-foreground">
                No blocks match "{query}"
              </div>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={canvasRef}
            className="relative min-h-0 flex-1 overflow-auto bg-background bg-[radial-gradient(circle,_var(--color-border)_1px,_transparent_1px)] [background-size:20px_20px]"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {/* Connection lines */}
            <svg className="pointer-events-none absolute left-0 top-0 h-full w-full overflow-visible">
              {connections.map((c) => {
                const from = blockById.get(c.from);
                const to = blockById.get(c.to);
                if (!from || !to) return null;
                return (
                  <path
                    key={c.id}
                    d={bezier(portOut(from), portIn(to))}
                    fill="none"
                    stroke="var(--color-primary)"
                    strokeWidth={2}
                  />
                );
              })}
              {pending &&
                (() => {
                  const from = blockById.get(pending.from);
                  if (!from) return null;
                  return (
                    <path
                      d={bezier(portOut(from), { x: pending.x, y: pending.y })}
                      fill="none"
                      stroke="var(--color-primary)"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                    />
                  );
                })()}
            </svg>

            {/* Placed blocks */}
            {placed.map((b) => (
              <CanvasBlock
                key={b.instanceId}
                block={b}
                onRemove={() => removeBlock(b.instanceId)}
                onMove={(x, y) => updateBlock(b.instanceId, { x, y })}
                onFieldChange={(field, value) => updateValue(b.instanceId, field, value)}
                onStartConnect={(x, y) => startConnect(b.instanceId, x, y)}
                onInputPortEnter={() => (hoveredInputRef.current = b.instanceId)}
                onInputPortLeave={() => (hoveredInputRef.current = null)}
                connecting={!!pending && pending.from !== b.instanceId}
              />
            ))}

            {placed.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  Drag a block here to get started
                </p>
              </div>
            )}
          </div>

          <BottomPanel
            open={bottomOpen}
            onToggle={() => setBottomOpen((o) => !o)}
            python={generatedPython}
            terminal={terminal}
            logs={logs}
          />
        </div>

        <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex h-11 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm font-semibold">Preview</span>
            </div>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Live
            </span>
          </div>
          <div className="scrollbar-thin flex-1 overflow-y-auto p-4">
            {!ranOnce ? (
              <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-background/60 p-8 text-center">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-primary-soft text-primary">
                  <Play className="h-4 w-4" fill="currentColor" />
                </div>
                <div className="text-sm font-semibold">Run your project to see preview.</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Output, AI predictions, images and charts appear here.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-xl border border-border bg-background p-3 text-xs">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Program output</div>
                  <div className="font-mono text-foreground">
                    {terminal.length ? terminal[terminal.length - 2] ?? "—" : "No output yet"}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-background p-3 text-xs">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Blocks executed</div>
                  <div className="text-foreground">{placed.length} block{placed.length === 1 ? "" : "s"}</div>
                </div>
                <div className="rounded-xl border border-border bg-background p-3 text-xs">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Connections</div>
                  <div className="text-foreground">{connections.length}</div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
      <Toaster />
    </div>
  );
}

function DraggableBlock({ block, color }: { block: BlockDef; color: string }) {
  const isInput = block.category === "input";

  let content = null;

  if (block.category === "start") {
    content = (
      <div className="mx-auto flex h-9 w-[80%] items-center justify-center rounded-[50px] border-2 bg-emerald-500 border-emerald-700 px-3 text-white shadow-sm">
        <div className="text-[10px] font-bold truncate">{block.label}</div>
      </div>
    );
  } else if (block.category === "input" || block.category === "output") {
    content = (
      <div
        className="mx-auto relative flex h-10 w-[85%] items-center justify-center border-2 text-white shadow-sm"
        style={{
          transform: "skewX(-15deg)",
          borderRadius: "6px",
          backgroundColor: isInput ? "#f59e0b" : "#ec4899",
          borderColor: isInput ? "#b45309" : "#be185d",
        }}
      >
        <div className="flex flex-col items-center px-3" style={{ transform: "skewX(15deg)" }}>
          <div className="mb-0 text-[7px] font-bold uppercase tracking-wider opacity-80">{isInput ? "Input" : "Output"}</div>
          <div className="text-[10px] font-medium truncate">{block.label}</div>
        </div>
      </div>
    );
  } else if (block.category === "conditions" || block.category === "loops") {
    content = (
      <div className="relative flex h-14 w-full items-center justify-center py-1">
        <div className="absolute h-11 w-11 rounded-sm border-[1.5px] bg-orange-500 border-orange-700 shadow-sm" style={{ transform: "rotate(45deg)" }} />
        <div className="relative z-10 flex flex-col items-center text-center text-white px-2">
          <div className="mb-0 text-[7px] font-bold uppercase tracking-wider opacity-80">Decision</div>
          <div className="text-[9px] font-medium leading-tight max-w-[50px] truncate">{block.label}</div>
        </div>
      </div>
    );
  } else {
    const segments = block.template ? renderTemplate(block.template, block.fields ?? []) : null;
    let innerContent;

    if (segments && block.fields && block.fields.length > 0) {
      innerContent = (
        <div className="flex flex-wrap items-center justify-center gap-1 mt-0.5 pointer-events-none">
          {segments.map((seg, i) =>
            seg.type === "text" ? (
              <span key={i} className="text-[9px] font-medium whitespace-nowrap">{seg.value}</span>
            ) : (
              <input
                key={i}
                disabled
                placeholder={seg.field.placeholder}
                className="h-[22px] rounded-[3px] border-0 bg-white/95 px-1.5 text-[9px] font-medium text-black shadow-soft outline-none placeholder:text-muted-foreground/70"
                style={{ width: Math.max(50, (seg.field.width ?? 60) * 0.9) }}
              />
            ),
          )}
        </div>
      );
    } else {
      innerContent = <div className="text-[10px] font-medium text-center truncate w-full">{block.label}</div>;
    }

    content = (
      <div className="mx-auto flex h-auto min-h-[46px] w-[95%] flex-col items-center justify-center rounded-md border-2 bg-blue-500 border-blue-700 p-1.5 text-white shadow-sm">
        <div className="mb-0 text-[7px] font-bold uppercase tracking-wider opacity-80">Process</div>
        {innerContent}
      </div>
    );
  }

  return (
    <div
      draggable={true}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        const payload = JSON.stringify(block);
        e.dataTransfer.setData("application/x-neuronblk-block", payload);
        e.dataTransfer.setData("text/plain", payload);
      }}
      className="group flex cursor-grab select-none flex-col justify-center mb-2 transition-transform hover:scale-[1.02] active:scale-[0.98]"
      title={block.description}
    >
      {content}
    </div>
  );
}

/**
 * Renders a block on the canvas in the same shape/color as its sidebar
 * counterpart: oval (start), skewed parallelogram (input/output),
 * diamond (conditions/loops), or rounded rectangle (everything else).
 */
function CanvasBlock({
  block,
  onRemove,
  onMove,
  onFieldChange,
  onStartConnect,
  onInputPortEnter,
  onInputPortLeave,
  connecting,
}: {
  block: PlacedBlock;
  onRemove: () => void;
  onMove: (x: number, y: number) => void;
  onFieldChange: (field: string, value: string) => void;
  onStartConnect: (clientX: number, clientY: number) => void;
  onInputPortEnter: () => void;
  onInputPortLeave: () => void;
  connecting: boolean;
}) {
  const def = getBlockDef(block.defId);
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);

  if (!def) return null;

  const category = def.category;
  const segments = renderTemplate(def.template ?? def.label, def.fields ?? []);
  const hasFields = segments.length > 0 && def.fields && def.fields.length > 0;

  const fieldsContent = hasFields ? (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      {segments.map((seg, i) =>
        seg.type === "text" ? (
          <span key={i} className="whitespace-nowrap text-[12px] font-medium text-white">
            {seg.value}
          </span>
        ) : (
          <InlineField
            key={i}
            field={seg.field}
            value={block.values[seg.field.name] ?? ""}
            onChange={(v) => onFieldChange(seg.field.name, v)}
          />
        ),
      )}
    </div>
  ) : (
    <div className="text-[13px] font-semibold text-white truncate">{def.label}</div>
  );

  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    dragging.current = true;
    dragOffset.current = { x: e.clientX - block.x, y: e.clientY - block.y };
    const move = (ev: MouseEvent) => {
      if (!dragging.current) return;
      onMove(Math.max(0, ev.clientX - dragOffset.current.x), Math.max(0, ev.clientY - dragOffset.current.y));
    };
    const up = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  let shape: React.ReactNode;

  if (category === "start") {
    shape = (
      <div className="flex h-16 w-full items-center justify-center rounded-[50px] border-2 bg-emerald-500 border-emerald-700 px-6 text-white shadow-lift">
        {fieldsContent}
      </div>
    );
  } else if (category === "input" || category === "output") {
    const isInput = category === "input";
    shape = (
      <div
        className="flex h-24 w-full items-center justify-center border-2 shadow-lift"
        style={{
          transform: "skewX(-15deg)",
          borderRadius: "10px",
          backgroundColor: isInput ? "#f59e0b" : "#ec4899",
          borderColor: isInput ? "#b45309" : "#be185d",
        }}
      >
        <div className="flex flex-col items-center gap-1 px-5" style={{ transform: "skewX(15deg)" }}>
          <div className="text-[9px] font-bold uppercase tracking-wider text-white/80">
            {isInput ? "Input" : "Output"}
          </div>
          {fieldsContent}
        </div>
      </div>
    );
  } else if (category === "conditions" || category === "loops") {
    shape = (
      <div className="relative flex h-[120px] w-full items-center justify-center">
        <div
          className="absolute left-1/2 top-1/2 h-20 w-20 rounded-sm border-2 bg-orange-500 border-orange-700 shadow-lift"
          style={{ transform: "translate(-50%, -50%) rotate(45deg)" }}
        />
        <div className="relative z-10 flex flex-col items-center gap-1 px-6 text-center">
          <div className="text-[9px] font-bold uppercase tracking-wider text-white/80">Decision</div>
          {fieldsContent}
        </div>
      </div>
    );
  } else {
    shape = (
      <div className="flex min-h-[96px] w-full flex-col items-center justify-center gap-1.5 rounded-2xl border-2 bg-blue-500 border-blue-700 px-4 py-3 shadow-lift">
        <div className="text-[10px] font-bold uppercase tracking-wider text-white/80">Process</div>
        {fieldsContent}
      </div>
    );
  }

  return (
    <div
      className="group absolute select-none"
      style={{ left: block.x, top: block.y, width: BLOCK_W }}
      onMouseDown={startDrag}
    >
      {/* Input port (top) */}
      <div
        data-no-drag
        onMouseEnter={onInputPortEnter}
        onMouseLeave={onInputPortLeave}
        className={cn(
          "absolute left-1/2 top-0 z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-muted transition-all",
          connecting && "scale-125 bg-primary shadow-lift",
        )}
        title="Input"
      />

      {shape}

      <button
        data-no-drag
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute -right-2 -top-2 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition-opacity hover:bg-red-500 group-hover:opacity-100 shadow-sm"
        aria-label="Remove block"
      >
        <X className="h-3 w-3" />
      </button>

      {/* Output port (bottom) */}
      <div
        data-no-drag
        onMouseDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onStartConnect(e.clientX, e.clientY);
        }}
        className="absolute left-1/2 bottom-0 z-10 h-4 w-4 -translate-x-1/2 translate-y-1/2 cursor-crosshair rounded-full border-2 border-background bg-primary shadow-soft transition-transform hover:scale-125"
        title="Drag to connect"
      />
    </div>
  );
}

function InlineField({
  field,
  value,
  onChange,
}: {
  field: BlockField;
  value: string;
  onChange: (v: string) => void;
}) {
  if (field.kind === "select") {
    return (
      <select
        data-no-drag
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        className="h-7 rounded-full border-0 bg-white/95 px-2 text-[12.5px] font-medium text-foreground shadow-soft outline-none focus:ring-2 focus:ring-white"
        style={{ width: field.width ?? 70 }}
      >
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      data-no-drag
      type={field.kind === "number" ? "number" : "text"}
      value={value}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      className="h-7 rounded-full border-0 bg-white/95 px-2.5 text-[12.5px] font-medium text-foreground shadow-soft outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-white"
      style={{ width: field.width ?? 90 }}
    />
  );
}

type Seg = { type: "text"; value: string } | { type: "field"; field: BlockField };

function renderTemplate(template: string, fields: BlockField[]): Seg[] {
  const map = new Map(fields.map((f) => [f.name, f]));
  const out: Seg[] = [];
  const re = /\{([a-zA-Z0-9_]+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) out.push({ type: "text", value: template.slice(last, m.index).trim() });
    const f = map.get(m[1]);
    if (f) out.push({ type: "field", field: f });
    else out.push({ type: "text", value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < template.length) {
    const tail = template.slice(last).trim();
    if (tail) out.push({ type: "text", value: tail });
  }
  return out.filter((s) => (s.type === "text" ? s.value.length > 0 : true));
}

function bezier(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dy = Math.max(40, Math.abs(b.y - a.y) * 0.5);
  const c1x = a.x;
  const c1y = a.y + dy;
  const c2x = b.x;
  const c2y = b.y - dy;
  return `M ${a.x} ${a.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${b.x} ${b.y}`;
}

function orderByConnections(blocks: PlacedBlock[], connections: Connection[]): PlacedBlock[] {
  if (blocks.length === 0) return blocks;
  const byId = new Map(blocks.map((b) => [b.instanceId, b]));
  const next = new Map<string, string>();
  const hasIncoming = new Set<string>();
  for (const c of connections) {
    next.set(c.from, c.to);
    hasIncoming.add(c.to);
  }
  const roots = blocks.filter((b) => !hasIncoming.has(b.instanceId));
  const visited = new Set<string>();
  const result: PlacedBlock[] = [];
  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const b = byId.get(id);
    if (!b) return;
    result.push(b);
    const n = next.get(id);
    if (n) walk(n);
  };
  roots.sort((a, b) => a.y - b.y || a.x - b.x).forEach((r) => walk(r.instanceId));
  blocks.forEach((b) => walk(b.instanceId));
  return result;
}

function BottomPanel({
  open,
  onToggle,
  python,
  terminal,
  logs,
}: {
  open: boolean;
  onToggle: () => void;
  python: string;
  terminal: string[];
  logs: string[];
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col border-t border-border bg-surface transition-all",
        open ? "h-64" : "h-10",
      )}
    >
      <Tabs defaultValue="python" className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 items-center justify-between border-b border-border px-2">
          <TabsList className="h-8 bg-transparent p-0">
            <TabsTrigger value="python" className="h-8 rounded-lg data-[state=active]:bg-muted data-[state=active]:shadow-none">
              <Code2 className="mr-1.5 h-3.5 w-3.5" />
              Generated Python
            </TabsTrigger>
            <TabsTrigger value="terminal" className="h-8 rounded-lg data-[state=active]:bg-muted data-[state=active]:shadow-none">
              <TerminalSquare className="mr-1.5 h-3.5 w-3.5" />
              Terminal
            </TabsTrigger>
            <TabsTrigger value="logs" className="h-8 rounded-lg data-[state=active]:bg-muted data-[state=active]:shadow-none">
              <ScrollText className="mr-1.5 h-3.5 w-3.5" />
              Logs
            </TabsTrigger>
          </TabsList>
          <button
            onClick={onToggle}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={open ? "Collapse panel" : "Expand panel"}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </button>
        </div>
        {open && (
          <div className="min-h-0 flex-1 overflow-hidden">
            <TabsContent value="python" className="scrollbar-thin m-0 h-full overflow-auto p-4">
              <pre className="font-mono text-[12.5px] leading-relaxed text-foreground">
                <code>{python}</code>
              </pre>
            </TabsContent>
            <TabsContent value="terminal" className="scrollbar-thin m-0 h-full overflow-auto p-4">
              {terminal.length === 0 ? (
                <div className="text-xs text-muted-foreground">Terminal is empty. Press Run to execute.</div>
              ) : (
                <pre className="font-mono text-[12.5px] leading-relaxed text-foreground">{terminal.join("\n")}</pre>
              )}
            </TabsContent>
            <TabsContent value="logs" className="scrollbar-thin m-0 h-full overflow-auto p-4">
              {logs.length === 0 ? (
                <div className="text-xs text-muted-foreground">No logs yet.</div>
              ) : (
                <ul className="space-y-1 font-mono text-[12px] text-muted-foreground">
                  {logs.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              )}
            </TabsContent>
          </div>
        )}
      </Tabs>
    </div>
  );
}

function generatePython(projectName: string | undefined, blocks: PlacedBlock[]) {
  const header = `# ${projectName ?? "Untitled"} — generated by NeuronBLK\n\ndef main():\n`;
  if (blocks.length === 0) {
    return header + "    # Drag blocks onto the canvas to generate code.\n    pass\n\nif __name__ == \"__main__\":\n    main()\n";
  }
  const body = blocks
    .map((b) => {
      const v = b.values;
      switch (b.defId) {
        case "start.main":
          return "    # Program entry";
        case "start.stop":
          return "    return";
        case "out.print":
          return `    print(${py(v.text)})`;
        case "out.format":
          return `    ${v.var || "msg"} = f${py(v.template)}`;
        case "input.text":
          return `    ${v.var || "name"} = input(${py(v.prompt)} + ": ")`;
        case "input.number":
          return `    ${v.var || "value"} = float(input(${py(v.prompt)} + ": "))`;
        case "var.set":
          return `    ${v.name || "x"} = ${v.value || "0"}`;
        case "var.get":
          return `    _ = ${v.name || "x"}`;
        case "var.math": {
          const opMap: Record<string, string> = { "×": "*", "÷": "/", "%": "%" };
          const op = opMap[v.op] ?? v.op ?? "+";
          return `    result = ${v.a || "a"} ${op} ${v.b || "b"}`;
        }
        case "if.then":
          return `    if ${v.cond || "True"}:\n        pass`;
        case "if.compare":
          return `    _ = (${v.a || "a"} ${v.op || "=="} ${v.b || "b"})`;
        case "loop.for":
          return `    for ${v.item || "item"} in ${v.list || "items"}:\n        pass`;
        case "loop.while":
          return `    while ${v.cond || "True"}:\n        pass`;
        case "fn.define":
          return `    def ${v.name || "my_func"}(${v.args || ""}):\n        pass`;
        case "fn.call":
          return `    ${v.name || "my_func"}(${v.args || ""})`;
        case "file.read":
          return `    ${v.var || "data"} = open(${py(v.path)}).read()`;
        case "file.write":
          return `    open(${py(v.path)}, "w").write(str(${v.var || "data"}))`;
        case "api.get":
          return `    ${v.var || "response"} = requests.get(${py(v.url)})`;
        case "api.post":
          return `    response = requests.post(${py(v.url)}, json=${v.body || "{}"})`;
        case "ai.chat":
          return `    ${v.var || "reply"} = ai.chat(${py(v.prompt)})`;
        case "ai.classify":
          return `    ${v.var || "label"} = ai.classify(${py(v.text)})`;
        case "ai.image":
          return `    ${v.var || "image"} = ai.image(${py(v.prompt)})`;
        case "data.list":
          return `    ${v.name || "items"} = [${v.items || ""}]`;
        case "data.dict":
          return `    ${v.name || "config"} = {${v.pairs || ""}}`;
        case "data.transform":
          return `    ${v.list || "items"} = list(${v.op || "map"}(lambda x: x, ${v.list || "items"}))`;
        default:
          return `    # ${getBlockDef(b.defId)?.label ?? b.defId}`;
      }
    })
    .join("\n");
  return header + body + '\n\nif __name__ == "__main__":\n    main()\n';
}

function py(s: string | undefined) {
  const v = (s ?? "").replace(/"/g, '\\"');
  return `"${v}"`;
}