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

/**
 * Port model:
 * - "in"       top,    target — every block
 * - "out"      bottom, source — start/input/output/process blocks
 * - "true"     right,  source — conditions (diamond) only
 * - "false"    bottom, source — conditions (diamond) only
 * - "loopback" left,   target — loops (diamond) only; a body block's "out"
 *              connects here to represent "repeat".
 */
type PortId = "in" | "out" | "true" | "false" | "loopback";

type Connection = {
  id: string;
  from: string;
  fromPort: PortId;
  to: string;
  toPort: PortId;
};

const BLOCK_W = 260;

// Approximate rendered height per shape category, used only for connector
// anchor math. Actual DOM height can vary slightly (auto), which is fine
// visually — these just need to be close.
const SHAPE_H: Record<string, number> = {
  start: 64, // h-16 oval
  input: 96, // h-24 parallelogram
  output: 96,
  conditions: 120, // diamond
  loops: 120, // diamond
  connector: 40, // small circle
};
const DEFAULT_H = 96; // process rectangle min-height

function shapeHeight(category: string) {
  return SHAPE_H[category] ?? DEFAULT_H;
}

function getPortPos(block: PlacedBlock, category: string, portId: PortId) {
  const h = shapeHeight(category);
  const cx = block.x + BLOCK_W / 2;
  switch (portId) {
    case "in":
      return { x: cx, y: block.y };
    case "out":
      return { x: cx, y: block.y + h };
    case "true":
      return { x: block.x + BLOCK_W, y: block.y + h / 2 };
    case "false":
    case "loopback":
      return { x: block.x, y: block.y + h / 2 };
  }
}

function blockPortPos(b: PlacedBlock, portId: PortId) {
  const def = getBlockDef(b.defId);
  return getPortPos(b, def?.category ?? "process", portId);
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
  const [pending, setPending] = useState<{ from: string; fromPort: PortId; x: number; y: number } | null>(null);
  const hoveredPortRef = useRef<{ blockId: string; portId: PortId } | null>(null);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [terminal, setTerminal] = useState<string[]>([]);
  const [ranOnce, setRanOnce] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const placedRef = useRef<PlacedBlock[]>(placed);
  useEffect(() => {
    placedRef.current = placed;
  }, [placed]);

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
  const generatedPython = useMemo(
    () => generatePython(project?.name, placed, connections),
    [project?.name, placed, connections],
  );

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

  function startConnect(fromId: string, fromPort: PortId, clientX: number, clientY: number) {
    const rect = canvasRef.current!.getBoundingClientRect();
    const scrollLeft = canvasRef.current!.scrollLeft;
    const scrollTop = canvasRef.current!.scrollTop;
    setPending({ from: fromId, fromPort, x: clientX - rect.left + scrollLeft, y: clientY - rect.top + scrollTop });
    const move = (ev: MouseEvent) => {
      const r = canvasRef.current!.getBoundingClientRect();
      setPending({
        from: fromId,
        fromPort,
        x: ev.clientX - r.left + canvasRef.current!.scrollLeft,
        y: ev.clientY - r.top + canvasRef.current!.scrollTop,
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const target = hoveredPortRef.current;
      if (target && target.blockId !== fromId) {
        const targetBlock = placedRef.current.find((b) => b.instanceId === target.blockId);
        const targetIsConnector = getBlockDef(targetBlock?.defId ?? "")?.category === "connector";
        setConnections((prev) => [
          ...prev.filter((c) => {
            const targetsSamePort = c.to === target.blockId && c.toPort === target.portId;
            // Connectors are merge points — keep prior connections into
            // their "in" port instead of replacing them.
            if (targetsSamePort) return targetIsConnector;
            if (c.from === fromId && c.fromPort === fromPort) return false;
            return true;
          }),
          { id: crypto.randomUUID(), from: fromId, fromPort, to: target.blockId, toPort: target.portId },
        ]);
      }
      hoveredPortRef.current = null;
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
              <defs>
                <marker
                  id="loopback-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="#8b5cf6" />
                </marker>
              </defs>
              {connections.map((c) => {
                const from = blockById.get(c.from);
                const to = blockById.get(c.to);
                if (!from || !to) return null;
                const a = blockPortPos(from, c.fromPort);
                const b = blockPortPos(to, c.toPort);

                if (c.toPort === "loopback") {
                  return (
                    <path
                      key={c.id}
                      d={elbowPath(a, b)}
                      fill="none"
                      stroke="#8b5cf6"
                      strokeWidth={2}
                      strokeDasharray="5 4"
                      markerEnd="url(#loopback-arrow)"
                    />
                  );
                }

                const stroke =
                  c.fromPort === "true" ? "#10b981" : c.fromPort === "false" ? "#f43f5e" : "var(--color-primary)";
                return <path key={c.id} d={bezier(a, b)} fill="none" stroke={stroke} strokeWidth={2} />;
              })}
              {pending &&
                (() => {
                  const from = blockById.get(pending.from);
                  if (!from) return null;
                  const a = blockPortPos(from, pending.fromPort);
                  const stroke =
                    pending.fromPort === "true"
                      ? "#10b981"
                      : pending.fromPort === "false"
                        ? "#f43f5e"
                        : "var(--color-primary)";
                  return (
                    <path
                      d={bezier(a, { x: pending.x, y: pending.y })}
                      fill="none"
                      stroke={stroke}
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
                onStartConnect={(portId, x, y) => startConnect(b.instanceId, portId, x, y)}
                onPortEnter={(portId) => (hoveredPortRef.current = { blockId: b.instanceId, portId })}
                onPortLeave={() => (hoveredPortRef.current = null)}
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
  } else if (block.category === "connector") {
    content = (
      <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-full border-2 bg-slate-400 border-slate-600 text-white shadow-sm">
        <span className="text-[10px] font-bold">•</span>
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
 * counterpart, with ports matching its role in the flowchart:
 * - start/input/output/process: in (top), out (bottom)
 * - conditions (diamond): in (top), true (right), false (bottom)
 * - loops (diamond): in (top), out (bottom, loop body), loopback (left)
 */
function CanvasBlock({
  block,
  onRemove,
  onMove,
  onFieldChange,
  onStartConnect,
  onPortEnter,
  onPortLeave,
  connecting,
}: {
  block: PlacedBlock;
  onRemove: () => void;
  onMove: (x: number, y: number) => void;
  onFieldChange: (field: string, value: string) => void;
  onStartConnect: (portId: PortId, clientX: number, clientY: number) => void;
  onPortEnter: (portId: PortId) => void;
  onPortLeave: () => void;
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
          <div className="text-[9px] font-bold uppercase tracking-wider text-white/80">
            {category === "loops" ? "Loop" : "Decision"}
          </div>
          {fieldsContent}
        </div>
      </div>
    );
  } else if (category === "connector") {
    shape = (
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border-2 bg-slate-400 border-slate-600 text-white shadow-lift">
        <span className="text-[10px] font-bold">•</span>
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

  const showOut = category !== "conditions" && block.defId !== "start.stop";

  return (
    <div
      className="group absolute select-none"
      style={{ left: block.x, top: block.y, width: BLOCK_W }}
      onMouseDown={startDrag}
    >
      {/* Input port (top) — every block */}
      <div
        data-no-drag
        onMouseEnter={() => onPortEnter("in")}
        onMouseLeave={onPortLeave}
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

      {category === "conditions" ? (
        <>
          {/* True port (right side) */}
          <div
            data-no-drag
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onStartConnect("true", e.clientX, e.clientY);
            }}
            className="absolute right-0 top-1/2 z-10 h-4 w-4 translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-background bg-emerald-500 shadow-soft transition-transform hover:scale-125"
            title="True"
          />
          <span className="pointer-events-none absolute right-[-18px] top-[calc(50%+10px)] text-[9px] font-bold text-emerald-600">
            T
          </span>

          {/* False port (left side) */}
          <div
            data-no-drag
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onStartConnect("false", e.clientX, e.clientY);
            }}
            className="absolute left-0 top-1/2 z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-background bg-rose-500 shadow-soft transition-transform hover:scale-125"
            title="False"
          />
          <span className="pointer-events-none absolute left-[-18px] top-[calc(50%+10px)] text-[9px] font-bold text-rose-600">
            F
          </span>
        </>
      ) : (
        <>
          {category === "loops" && (
            <>
              {/* Loop-back port (left side) — connect a body block's output here */}
              <div
                data-no-drag
                onMouseEnter={() => onPortEnter("loopback")}
                onMouseLeave={onPortLeave}
                className={cn(
                  "absolute left-0 top-1/2 z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-violet-400 transition-all",
                  connecting && "scale-125 bg-violet-500 shadow-lift",
                )}
                title="Loop back"
              />
              <span className="pointer-events-none absolute -left-4 top-[calc(50%-16px)] text-[11px] text-violet-500">
                ↺
              </span>
            </>
          )}
          {showOut && (
            <div
              data-no-drag
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onStartConnect("out", e.clientX, e.clientY);
              }}
              className="absolute left-1/2 bottom-0 z-10 h-4 w-4 -translate-x-1/2 translate-y-1/2 cursor-crosshair rounded-full border-2 border-background bg-primary shadow-soft transition-transform hover:scale-125"
              title={category === "loops" ? "Loop body" : "Output"}
            />
          )}
        </>
      )}
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

/** Smooth flow connector (true/false branches and normal in→out flow). */
function bezier(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dy = Math.max(40, Math.abs(b.y - a.y) * 0.5);
  const dx = Math.max(20, Math.abs(b.x - a.x) * 0.3);
  const goingSideways = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
  const c1x = goingSideways ? a.x + dx : a.x;
  const c1y = goingSideways ? a.y : a.y + dy;
  const c2x = goingSideways ? b.x - dx : b.x;
  const c2y = goingSideways ? b.y : b.y - dy;
  return `M ${a.x} ${a.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${b.x} ${b.y}`;
}

/** Right-angle "goes around" connector used for loop-back arrows. */
function elbowPath(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dropY = a.y + 28;
  const sideX = Math.min(a.x, b.x) - 40;
  return `M ${a.x} ${a.y} L ${a.x} ${dropY} L ${sideX} ${dropY} L ${sideX} ${b.y} L ${b.x} ${b.y}`;
}

/**
 * Execution order for code gen / Run: DFS from root blocks (no incoming
 * connection), following every outgoing branch (true/false/loop body).
 * The visited guard means loop-back cycles terminate safely instead of
 * looping forever.
 */
function orderByConnections(blocks: PlacedBlock[], connections: Connection[]): PlacedBlock[] {
  if (blocks.length === 0) return blocks;
  const byId = new Map(blocks.map((b) => [b.instanceId, b]));
  const outgoing = new Map<string, Connection[]>();
  const hasIncoming = new Set<string>();
  for (const c of connections) {
    if (!outgoing.has(c.from)) outgoing.set(c.from, []);
    outgoing.get(c.from)!.push(c);
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
    const outs = outgoing.get(id) ?? [];
    for (const c of outs) walk(c.to);
  };
  roots.sort((a, b) => a.y - b.y || a.x - b.x).forEach((r) => walk(r.instanceId));
  // Any leftover (disconnected components) — append in insertion order
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

/** One Python line (or multi-line string) for a single block, at the given indent. */
function emitLine(b: PlacedBlock, indent: string): string {
  const v = b.values;
  switch (b.defId) {
    case "start.main":
      return `${indent}# Program entry`;
    case "start.stop":
      return `${indent}return`;
    case "out.print":
      return `${indent}print(${py(v.text)})`;
    case "out.format":
      return `${indent}${v.var || "msg"} = f${py(v.template)}`;
    case "input.text":
      return `${indent}${v.var || "name"} = input(${py(v.prompt)} + ": ")`;
    case "input.number":
      return `${indent}${v.var || "value"} = float(input(${py(v.prompt)} + ": "))`;
    case "var.set":
      return `${indent}${v.name || "x"} = ${v.value || "0"}`;
    case "var.get":
      return `${indent}_ = ${v.name || "x"}`;
    case "var.math": {
      const opMap: Record<string, string> = { "×": "*", "÷": "/", "%": "%" };
      const op = opMap[v.op] ?? v.op ?? "+";
      return `${indent}result = ${v.a || "a"} ${op} ${v.b || "b"}`;
    }
    case "if.compare":
      return `${indent}_ = (${v.a || "a"} ${v.op || "=="} ${v.b || "b"})`;
    case "fn.define":
      return `${indent}def ${v.name || "my_func"}(${v.args || ""}):\n${indent}    pass`;
    case "fn.call":
      return `${indent}${v.name || "my_func"}(${v.args || ""})`;
    case "file.read":
      return `${indent}${v.var || "data"} = open(${py(v.path)}).read()`;
    case "file.write":
      return `${indent}open(${py(v.path)}, "w").write(str(${v.var || "data"}))`;
    case "api.get":
      return `${indent}${v.var || "response"} = requests.get(${py(v.url)})`;
    case "api.post":
      return `${indent}response = requests.post(${py(v.url)}, json=${v.body || "{}"})`;
    case "ai.chat":
      return `${indent}${v.var || "reply"} = ai.chat(${py(v.prompt)})`;
    case "ai.classify":
      return `${indent}${v.var || "label"} = ai.classify(${py(v.text)})`;
    case "ai.image":
      return `${indent}${v.var || "image"} = ai.image(${py(v.prompt)})`;
    case "data.list":
      return `${indent}${v.name || "items"} = [${v.items || ""}]`;
    case "data.dict":
      return `${indent}${v.name || "config"} = {${v.pairs || ""}}`;
    case "data.transform":
      return `${indent}${v.list || "items"} = list(${v.op || "map"}(lambda x: x, ${v.list || "items"}))`;
    default:
      return `${indent}# ${getBlockDef(b.defId)?.label ?? b.defId}`;
  }
}

/**
 * Walks the actual connection graph to produce properly nested Python:
 * - if.then follows its "true" port for the if-body and "false" port for
 *   the else-body, indented one level deeper.
 * - loop.for/loop.while follow their "out" port for the loop body,
 *   indented one level deeper.
 * - A block's "out" connection normally continues the chain at the same
 *   indent — except when it targets a loop's "loopback" port, which marks
 *   "repeat" rather than "continue on", so the chain stops there instead
 *   of recursing back into the loop header.
 * - A Connector block (small circle) is a merge/jump point: reaching one
 *   from any branch stops that branch there instead of inlining further
 *   code. Whichever if/else or loop produced that branch then continues
 *   the OUTER chain — at its own original indent — from the connector's
 *   "out" port. This is how branches "rejoin": in real structured code,
 *   code after an if/else naturally runs regardless of which branch was
 *   taken, so the merge only needs to be generated once, not duplicated
 *   per branch. Connectors are reachable from multiple incoming
 *   connections (a real merge point), and are exempt from the normal
 *   one-visit dedup so every branch that reaches the same connector
 *   correctly reports it.
 */
type ChainResult = { lines: string[]; mergeConnectorId?: string };

function generatePython(projectName: string | undefined, blocks: PlacedBlock[], connections: Connection[]) {
  const header = `# ${projectName ?? "Untitled"} — generated by NeuronBLK\n\ndef main():\n`;
  if (blocks.length === 0) {
    return header + "    # Drag blocks onto the canvas to generate code.\n    pass\n\nif __name__ == \"__main__\":\n    main()\n";
  }

  const byId = new Map(blocks.map((b) => [b.instanceId, b]));
  const outByPort = new Map<string, Connection>();
  const hasIncomingIn = new Set<string>();
  for (const c of connections) {
    outByPort.set(`${c.from}:${c.fromPort}`, c);
    if (c.toPort === "in") hasIncomingIn.add(c.to);
  }

  const visited = new Set<string>();

  function continueFromMerge(mergeId: string | undefined, indent: string): ChainResult {
    if (!mergeId) return { lines: [] };
    const afterConn = outByPort.get(`${mergeId}:out`);
    if (!afterConn) return { lines: [] };
    return genChain(afterConn.to, indent);
  }

  function genChain(blockId: string, indent: string): ChainResult {
    const block = byId.get(blockId);
    if (!block) return { lines: [] };
    const def = getBlockDef(block.defId);
    if (!def) return { lines: [] };

    // Connectors never emit code themselves and can be reached from
    // multiple branches, so they bypass the normal visited-dedup.
    if (def.category === "connector") {
      return { lines: [], mergeConnectorId: blockId };
    }

    if (visited.has(blockId)) return { lines: [] };
    visited.add(blockId);
    const v = block.values;

    if (block.defId === "if.then") {
      const lines = [`${indent}if ${v.cond || "True"}:`];
      const trueConn = outByPort.get(`${blockId}:true`);
      const trueResult = trueConn ? genChain(trueConn.to, indent + "    ") : { lines: [] };
      lines.push(...(trueResult.lines.length ? trueResult.lines : [`${indent}    pass`]));

      let falseResult: ChainResult = { lines: [] };
      const falseConn = outByPort.get(`${blockId}:false`);
      if (falseConn) {
        lines.push(`${indent}else:`);
        falseResult = genChain(falseConn.to, indent + "    ");
        lines.push(...(falseResult.lines.length ? falseResult.lines : [`${indent}    pass`]));
      }

      const mergeId = trueResult.mergeConnectorId ?? falseResult.mergeConnectorId;
      const after = continueFromMerge(mergeId, indent);
      lines.push(...after.lines);
      return { lines, mergeConnectorId: after.mergeConnectorId };
    }

    if (block.defId === "loop.for" || block.defId === "loop.while") {
      const heading =
        block.defId === "loop.for"
          ? `for ${v.item || "item"} in ${v.list || "items"}:`
          : `while ${v.cond || "True"}:`;
      const lines = [`${indent}${heading}`];
      const bodyConn = outByPort.get(`${blockId}:out`);
      const bodyResult = bodyConn ? genChain(bodyConn.to, indent + "    ") : { lines: [] };
      lines.push(...(bodyResult.lines.length ? bodyResult.lines : [`${indent}    pass`]));

      const after = continueFromMerge(bodyResult.mergeConnectorId, indent);
      lines.push(...after.lines);
      return { lines, mergeConnectorId: after.mergeConnectorId };
    }

    const lines = [emitLine(block, indent)];
    const next = outByPort.get(`${blockId}:out`);
    // A connection into a loop's "loopback" port marks "repeat", not
    // "continue on" — stop the chain here instead of recursing into it.
    if (next && next.toPort !== "loopback") {
      const nextResult = genChain(next.to, indent);
      lines.push(...nextResult.lines);
      return { lines, mergeConnectorId: nextResult.mergeConnectorId };
    }
    return { lines };
  }

  const roots = blocks.filter((b) => !hasIncomingIn.has(b.instanceId));
  roots.sort((a, b) => a.y - b.y || a.x - b.x);

  const bodyLines: string[] = [];
  const runChainToEnd = (startId: string) => {
    let result = genChain(startId, "    ");
    bodyLines.push(...result.lines);
    while (result.mergeConnectorId) {
      result = continueFromMerge(result.mergeConnectorId, "    ");
      bodyLines.push(...result.lines);
    }
  };
  for (const r of roots) {
    runChainToEnd(r.instanceId);
  }
  // Anything never reached (disconnected islands) is still emitted so
  // nothing dropped on the canvas silently disappears from the code.
  for (const b of blocks) {
    if (!visited.has(b.instanceId) && getBlockDef(b.defId)?.category !== "connector") {
      runChainToEnd(b.instanceId);
    }
  }

  const body = bodyLines.length ? bodyLines.join("\n") : "    pass";
  return header + body + '\n\nif __name__ == "__main__":\n    main()\n';
}

function py(s: string | undefined) {
  const v = (s ?? "").replace(/"/g, '\\"');
  return `"${v}"`;
}