import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  Save,
  Search,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Code2,
  Sparkles,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Maximize,
  RotateCcw,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { BLOCK_CATEGORIES, getBlockDef, type BlockDef, type BlockField } from "@/lib/blocks";
import { functionStore, type FunctionParam, type SavedFunction } from "@/lib/functionStore";
import { pullFromServer } from "@/lib/sync";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/function-editor/$functionId")({
  component: FunctionEditor,
});

type PlacedBlock = {
  instanceId: string;
  defId: string;
  x: number;
  y: number;
  values: Record<string, string>;
};

type PortId = "in" | "out" | "true" | "false" | "loopback";

type Connection = {
  id: string;
  from: string;
  fromPort: PortId;
  to: string;
  toPort: PortId;
};

const BLOCK_W = 260;

const SHAPE_H: Record<string, number> = {
  start: 64,
  input: 96,
  output: 96,
  conditions: 120,
  loops: 120,
  connector: 40,
};
const DEFAULT_H = 96;

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

function FunctionEditor() {
  const { functionId } = Route.useParams();
  const navigate = useNavigate();
  const [fn, setFn] = useState<SavedFunction | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [params, setParams] = useState<FunctionParam[]>([]);
  const [query, setQuery] = useState("");
  const [placed, setPlaced] = useState<PlacedBlock[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [pending, setPending] = useState<{ from: string; fromPort: PortId; x: number; y: number } | null>(null);
  const hoveredPortRef = useRef<{ blockId: string; portId: PortId } | null>(null);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [functions, setFunctions] = useState<SavedFunction[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const placedRef = useRef<PlacedBlock[]>(placed);
  useEffect(() => {
    placedRef.current = placed;
  }, [placed]);
  const connectionsRef = useRef<Connection[]>(connections);
  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);
  const skipNextAutosaveRef = useRef(true);

  // ---- Undo / redo ----
  const HISTORY_LIMIT = 50;
  const pastRef = useRef<{ placed: PlacedBlock[]; connections: Connection[] }[]>([]);
  const futureRef = useRef<{ placed: PlacedBlock[]; connections: Connection[] }[]>([]);
  const [historyTick, setHistoryTick] = useState(0);
  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  const commitHistory = useCallback((snapshot: { placed: PlacedBlock[]; connections: Connection[] }) => {
    pastRef.current.push(snapshot);
    if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
    futureRef.current = [];
    setHistoryTick((t) => t + 1);
  }, []);

  const undo = useCallback(() => {
    if (pastRef.current.length === 0) return;
    const previous = pastRef.current.pop()!;
    futureRef.current.push({ placed: placedRef.current, connections: connectionsRef.current });
    setPlaced(previous.placed);
    setConnections(previous.connections);
    setHistoryTick((t) => t + 1);
  }, []);

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const next = futureRef.current.pop()!;
    pastRef.current.push({ placed: placedRef.current, connections: connectionsRef.current });
    setPlaced(next.placed);
    setConnections(next.connections);
    setHistoryTick((t) => t + 1);
  }, []);

  // ---- Canvas camera (pan/zoom) ----
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 2.5;
  const [camera, setCamera] = useState({ scale: 1, panX: 0, panY: 0 });
  const cameraRef = useRef(camera);
  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cam = cameraRef.current;
    return {
      x: (clientX - rect.left - cam.panX) / cam.scale,
      y: (clientY - rect.top - cam.panY) / cam.scale,
    };
  }, []);

  const zoomIn = () => setCamera((c) => ({ ...c, scale: clamp(c.scale + 0.15, MIN_SCALE, MAX_SCALE) }));
  const zoomOut = () => setCamera((c) => ({ ...c, scale: clamp(c.scale - 0.15, MIN_SCALE, MAX_SCALE) }));
  const resetZoom = () => setCamera({ scale: 1, panX: 0, panY: 0 });

  function fitToScreen() {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (placed.length === 0) {
      resetZoom();
      return;
    }
    const heights = placed.map((b) => shapeHeight(getBlockDef(b.defId)?.category ?? "process"));
    const minX = Math.min(...placed.map((b) => b.x));
    const minY = Math.min(...placed.map((b) => b.y));
    const maxX = Math.max(...placed.map((b) => b.x + BLOCK_W));
    const maxY = Math.max(...placed.map((b, i) => b.y + heights[i]));
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const rawScale = Math.min(rect.width / contentW, rect.height / contentH) * 0.85;
    const scale = clamp(rawScale, MIN_SCALE, MAX_SCALE);
    const panX = rect.width / 2 - ((minX + maxX) / 2) * scale;
    const panY = rect.height / 2 - ((minY + maxY) / 2) * scale;
    setCamera({ scale, panX, panY });
  }

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const cam = cameraRef.current;
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const worldX = (cursorX - cam.panX) / cam.scale;
      const worldY = (cursorY - cam.panY) / cam.scale;
      const delta = -e.deltaY * 0.0015;
      const newScale = clamp(cam.scale * (1 + delta), MIN_SCALE, MAX_SCALE);
      setCamera({ scale: newScale, panX: cursorX - worldX * newScale, panY: cursorY - worldY * newScale });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function handleCanvasMouseDown(e: React.MouseEvent) {
    const isMiddle = e.button === 1;
    const isSpaceLeftDrag = e.button === 0 && spaceDownRef.current;
    if (isMiddle || isSpaceLeftDrag) {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startCam = cameraRef.current;
      const move = (ev: MouseEvent) => {
        setCamera({ scale: startCam.scale, panX: startCam.panX + (ev.clientX - startX), panY: startCam.panY + (ev.clientY - startY) });
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      return;
    }
    if (e.button === 0 && !(e.target as HTMLElement).closest("[data-block]")) {
      setSelectedIds(new Set());
    }
  }

  // ---- Selection ----
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  function handleSelectBlock(id: string, shiftKey: boolean) {
    setSelectedIds((prev) => {
      if (shiftKey) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }
      return new Set([id]);
    });
  }

  // ---- Space-to-pan ----
  const [spaceDown, setSpaceDown] = useState(false);
  const spaceDownRef = useRef(false);

  // ---- Copy / paste / duplicate clipboard ----
  const clipboardRef = useRef<{ blocks: PlacedBlock[]; connections: Connection[] } | null>(null);

  function getSelectionSnapshot(ids: Set<string>) {
    const blocks = placed.filter((b) => ids.has(b.instanceId));
    const conns = connections.filter((c) => ids.has(c.from) && ids.has(c.to));
    return { blocks, connections: conns };
  }

  function cloneWithNewIds(blocks: PlacedBlock[], conns: Connection[], dx: number, dy: number) {
    const idMap = new Map<string, string>();
    const newBlocks = blocks.map((b) => {
      const newId = crypto.randomUUID();
      idMap.set(b.instanceId, newId);
      return { ...b, instanceId: newId, x: b.x + dx, y: b.y + dy, values: { ...b.values } };
    });
    const newConns = conns.map((c) => ({
      id: crypto.randomUUID(),
      from: idMap.get(c.from)!,
      fromPort: c.fromPort,
      to: idMap.get(c.to)!,
      toPort: c.toPort,
    }));
    return { blocks: newBlocks, connections: newConns };
  }

  function copySelection() {
    if (selectedIds.size === 0) return;
    clipboardRef.current = getSelectionSnapshot(selectedIds);
  }

  function pasteClipboard() {
    const clip = clipboardRef.current;
    if (!clip || clip.blocks.length === 0) return;
    commitHistory({ placed, connections });
    const { blocks: newBlocks, connections: newConns } = cloneWithNewIds(clip.blocks, clip.connections, 32, 32);
    setPlaced((prev) => [...prev, ...newBlocks]);
    setConnections((prev) => [...prev, ...newConns]);
    setSelectedIds(new Set(newBlocks.map((b) => b.instanceId)));
    clipboardRef.current = { blocks: newBlocks, connections: newConns };
  }

  function duplicateSelection() {
    if (selectedIds.size === 0) return;
    const snap = getSelectionSnapshot(selectedIds);
    if (snap.blocks.length === 0) return;
    commitHistory({ placed, connections });
    const { blocks: newBlocks, connections: newConns } = cloneWithNewIds(snap.blocks, snap.connections, 32, 32);
    setPlaced((prev) => [...prev, ...newBlocks]);
    setConnections((prev) => [...prev, ...newConns]);
    setSelectedIds(new Set(newBlocks.map((b) => b.instanceId)));
  }

  function removeBlocks(ids: Set<string>) {
    if (ids.size === 0) return;
    commitHistory({ placed, connections });
    setPlaced((prev) => prev.filter((b) => !ids.has(b.instanceId)));
    setConnections((prev) => prev.filter((c) => !ids.has(c.from) && !ids.has(c.to)));
    setSelectedIds(new Set());
  }

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null) {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.code === "Space" && !isEditableTarget(e.target)) {
        e.preventDefault();
        spaceDownRef.current = true;
        setSpaceDown(true);
        return;
      }
      if (isEditableTarget(e.target)) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIds.size > 0) {
          e.preventDefault();
          removeBlocks(selectedIds);
        }
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      } else if (key === "c") {
        copySelection();
      } else if (key === "v") {
        pasteClipboard();
      } else if (key === "d") {
        e.preventDefault();
        duplicateSelection();
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") {
        spaceDownRef.current = false;
        setSpaceDown(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [undo, redo, selectedIds, placed, connections]);

  useEffect(() => {
    let cancelled = false;
    skipNextAutosaveRef.current = true;
    pastRef.current = [];
    futureRef.current = [];
    (async () => {
      await pullFromServer();
      const f = await functionStore.get(functionId);
      if (cancelled) return;
      if (!f) {
        navigate({ to: "/functions" });
        return;
      }
      setFn(f);
      setNameDraft(f.name);
      setParams(f.params ?? []);
      setPlaced((f.blocks as PlacedBlock[] | undefined) ?? []);
      setConnections((f.connections as Connection[] | undefined) ?? []);
      setFunctions((await functionStore.list()).filter((x) => x.id !== functionId));
    })();
    return () => {
      cancelled = true;
    };
  }, [functionId, navigate]);

  useEffect(() => {
    const onFunctionsUpdated = () =>
      void functionStore.list().then((list) => setFunctions(list.filter((x) => x.id !== functionId)));
    window.addEventListener("neuronblk:functions-updated", onFunctionsUpdated);
    return () => window.removeEventListener("neuronblk:functions-updated", onFunctionsUpdated);
  }, [functionId]);

  async function commitName() {
    setEditingName(false);
    if (!fn) return;
    const name = nameDraft.trim() || fn.name;
    await functionStore.rename(fn.id, name);
    setFn({ ...fn, name });
  }

  async function handleSave() {
    if (!fn) return;
    await functionStore.saveState(fn.id, fn.name, fn.description, params, placed, connections);
    toast.success("Function saved", { description: "Stored locally and queued to sync." });
  }

  useEffect(() => {
    if (!fn) return;
    const timer = setTimeout(() => {
      void functionStore.saveState(fn.id, fn.name, fn.description, params, placed, connections);
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn, params, placed, connections]);

  function addParam() {
    setParams((prev) => [...prev, { name: `param${prev.length + 1}`, default: "" }]);
  }
  function updateParam(index: number, patch: Partial<FunctionParam>) {
    setParams((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }
  function removeParam(index: number) {
    setParams((prev) => prev.filter((_, i) => i !== index));
  }

  const filteredCategories = useMemo(() => {
    const q = query.trim().toLowerCase();
    return BLOCK_CATEGORIES.map((c) => ({
      ...c,
      blocks: c.blocks.filter((b) => {
        if (b.contexts && !b.contexts.includes("function")) return false;
        if (!q) return true;
        return b.label.toLowerCase().includes(q) || b.description.toLowerCase().includes(q);
      }),
    })).filter((c) => c.blocks.length > 0);
  }, [query]);

  const validation = useMemo(
    () => computeFunctionValidation(placed, connections, new Set(functions.map((f) => f.id))),
    [placed, connections, functions],
  );

  const preview = useMemo(
    () => generateFunctionPreview(nameDraft, params, placed, connections, functions),
    [nameDraft, params, placed, connections, functions],
  );

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-neuronblk-block");
    if (!raw) return;
    const def = JSON.parse(raw) as BlockDef;
    const world = screenToWorld(e.clientX, e.clientY);
    const x = world.x - BLOCK_W / 2;
    const y = world.y - 24;
    const values: Record<string, string> = {};
    def.fields?.forEach((f) => {
      values[f.name] = f.default ?? "";
    });
    commitHistory({ placed, connections });
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

  function startConnect(fromId: string, fromPort: PortId, clientX: number, clientY: number) {
    const start = screenToWorld(clientX, clientY);
    setPending({ from: fromId, fromPort, x: start.x, y: start.y });
    const move = (ev: MouseEvent) => {
      const w = screenToWorld(ev.clientX, ev.clientY);
      setPending({ from: fromId, fromPort, x: w.x, y: w.y });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const target = hoveredPortRef.current;
      if (target && target.blockId !== fromId) {
        const targetBlock = placedRef.current.find((b) => b.instanceId === target.blockId);
        const targetIsConnector = getBlockDef(targetBlock?.defId ?? "")?.category === "connector";
        commitHistory({ placed: placedRef.current, connections: connectionsRef.current });
        setConnections((prev) => [
          ...prev.filter((c) => {
            const targetsSamePort = c.to === target.blockId && c.toPort === target.portId;
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

  if (!fn) return null;

  const blockById = new Map(placed.map((b) => [b.instanceId, b]));

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-3">
          <Link
            to="/functions"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Back to functions"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500 text-white shadow-soft">
              <Boxes className="h-4 w-4" strokeWidth={2.25} />
            </div>
            <span className="text-sm font-semibold tracking-tight">Function Editor</span>
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
                  setNameDraft(fn.name);
                  setEditingName(false);
                }
              }}
              className="h-8 w-56 rounded-lg text-sm"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="rounded-lg px-2 py-1 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              {fn.name}
            </button>
          )}

          <div className="mx-2 h-5 w-px bg-border" />
          <div className="flex flex-wrap items-center gap-1.5">
            {params.map((p, i) => (
              <div key={i} className="flex items-center gap-1 rounded-full bg-muted px-2 py-1">
                <input
                  value={p.name}
                  onChange={(e) => updateParam(i, { name: e.target.value })}
                  className="w-16 bg-transparent text-xs font-medium outline-none"
                  placeholder="name"
                />
                <span className="text-[10px] text-muted-foreground">=</span>
                <input
                  value={p.default ?? ""}
                  onChange={(e) => updateParam(i, { default: e.target.value })}
                  className="w-14 bg-transparent text-xs text-muted-foreground outline-none"
                  placeholder="default"
                />
                <button onClick={() => removeParam(i)} className="text-muted-foreground hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button
              onClick={addParam}
              className="flex h-7 items-center gap-1 rounded-full border border-dashed border-border px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
            >
              <Plus className="h-3 w-3" />
              Param
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={undo}
            disabled={!canUndo}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="h-4 w-4" />
          </button>
          <div className="mr-1 h-5 w-px bg-border" />
          <Button onClick={handleSave} variant="outline" size="sm" className="h-9 rounded-lg px-3.5">
            <Save className="mr-1.5 h-3.5 w-3.5" />
            Save
          </Button>
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
              <div className="mt-8 text-center text-xs text-muted-foreground">No blocks match "{query}"</div>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={canvasRef}
            className="relative min-h-0 flex-1 overflow-hidden bg-background"
            style={{
              backgroundImage: "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
              backgroundSize: `${20 * camera.scale}px ${20 * camera.scale}px`,
              backgroundPosition: `${camera.panX}px ${camera.panY}px`,
              cursor: spaceDown ? "grab" : "default",
            }}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onMouseDown={handleCanvasMouseDown}
          >
            <div
              className="absolute left-0 top-0 h-0 w-0"
              style={{
                transform: `translate(${camera.panX}px, ${camera.panY}px) scale(${camera.scale})`,
                transformOrigin: "0 0",
              }}
            >
              <svg className="pointer-events-none absolute left-0 top-0 overflow-visible">
                <defs>
                  <marker
                    id="fn-loopback-arrow"
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
                        markerEnd="url(#fn-loopback-arrow)"
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

              {placed.map((b) => (
                <CanvasBlock
                  key={b.instanceId}
                  block={b}
                  selected={selectedIds.has(b.instanceId)}
                  onSelect={(shiftKey) => handleSelectBlock(b.instanceId, shiftKey)}
                  panModeActive={spaceDown}
                  screenToWorld={screenToWorld}
                  onRemove={() => removeBlocks(new Set([b.instanceId]))}
                  onMove={(x, y) => updateBlock(b.instanceId, { x, y })}
                  onFieldChange={(field, value) => updateValue(b.instanceId, field, value)}
                  onStartConnect={(portId, x, y) => startConnect(b.instanceId, portId, x, y)}
                  onPortEnter={(portId) => (hoveredPortRef.current = { blockId: b.instanceId, portId })}
                  onPortLeave={() => (hoveredPortRef.current = null)}
                  onBeforeChange={() => commitHistory({ placed, connections })}
                  issues={validation.blockIssues.get(b.instanceId) ?? []}
                  unreachable={validation.unreachableIds.has(b.instanceId)}
                  functions={functions}
                  connecting={!!pending && pending.from !== b.instanceId}
                />
              ))}
            </div>

            {placed.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <p className="text-sm text-muted-foreground">Drag a Function Start block here to begin</p>
              </div>
            )}

            {validation.globalMessages.length > 0 && (
              <div className="absolute left-4 top-4 z-30 flex flex-col gap-1.5">
                {validation.globalMessages.map((m, i) => (
                  <div
                    key={i}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-xs font-medium shadow-soft backdrop-blur",
                      m.severity === "error"
                        ? "border-red-300 bg-red-50 text-red-700"
                        : "border-amber-300 bg-amber-50 text-amber-700",
                    )}
                  >
                    {m.severity === "error" ? "❌" : "⚠️"} {m.message}
                  </div>
                ))}
              </div>
            )}

            <div className="absolute bottom-4 right-4 z-30 flex items-center gap-0.5 rounded-lg border border-border bg-surface/95 px-1.5 py-1 shadow-lift backdrop-blur">
              <button
                onClick={zoomOut}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Zoom out"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <span className="w-10 text-center text-[11px] font-medium tabular-nums text-muted-foreground">
                {Math.round(camera.scale * 100)}%
              </span>
              <button
                onClick={zoomIn}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Zoom in"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
              <div className="mx-1 h-4 w-px bg-border" />
              <button
                onClick={resetZoom}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Reset zoom"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={fitToScreen}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Fit to screen"
              >
                <Maximize className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div
            className={cn(
              "flex shrink-0 flex-col border-t border-border bg-surface transition-all",
              bottomOpen ? "h-56" : "h-10",
            )}
          >
            <div className="flex h-10 items-center justify-between border-b border-border px-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Code2 className="h-3.5 w-3.5 text-muted-foreground" />
                Preview
              </div>
              <button
                onClick={() => setBottomOpen((o) => !o)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {bottomOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </button>
            </div>
            {bottomOpen && (
              <div className="scrollbar-thin flex-1 overflow-auto p-4">
                <pre className="font-mono text-[12.5px] leading-relaxed text-foreground">
                  <code>{preview}</code>
                </pre>
              </div>
            )}
          </div>
        </div>

        <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex h-11 items-center gap-2 border-b border-border px-4">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span className="text-sm font-semibold">About this function</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Description
            </label>
            <textarea
              value={fn.description}
              onChange={(e) => setFn({ ...fn, description: e.target.value })}
              placeholder="What does this function do? Shown when picking it from fn.call."
              className="mt-1.5 h-24 w-full resize-none rounded-lg border border-border bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="mt-4 text-xs text-muted-foreground">
              This function is private to you and can be reused from any project, or from another function's body
              (nested calls are supported).
            </p>
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

function CanvasBlock({
  block,
  onRemove,
  onMove,
  onFieldChange,
  onStartConnect,
  onPortEnter,
  onPortLeave,
  onBeforeChange,
  selected,
  onSelect,
  panModeActive,
  screenToWorld,
  issues,
  unreachable,
  functions,
  connecting,
}: {
  block: PlacedBlock;
  onRemove: () => void;
  onMove: (x: number, y: number) => void;
  onFieldChange: (field: string, value: string) => void;
  onStartConnect: (portId: PortId, clientX: number, clientY: number) => void;
  onPortEnter: (portId: PortId) => void;
  onPortLeave: () => void;
  onBeforeChange: () => void;
  selected: boolean;
  onSelect: (shiftKey: boolean) => void;
  panModeActive: boolean;
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number };
  issues: ValidationIssue[];
  unreachable: boolean;
  functions: SavedFunction[];
  connecting: boolean;
}) {
  const def = getBlockDef(block.defId);
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);

  if (!def) return null;

  const category = def.category;
  const isFnCall = block.defId === "fn.call";
  const segments = renderTemplate(def.template ?? def.label, def.fields ?? []);
  const hasFields = segments.length > 0 && def.fields && def.fields.length > 0;

  const fieldsContent = isFnCall ? (
    <FnCallFields block={block} functions={functions} onFieldChange={onFieldChange} onFocus={onBeforeChange} />
  ) : hasFields ? (
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
            onFocus={onBeforeChange}
          />
        ),
      )}
    </div>
  ) : (
    <div className="text-[13px] font-semibold text-white truncate">{def.label}</div>
  );

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (panModeActive) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    onSelect(e.shiftKey);
    onBeforeChange();
    dragging.current = true;
    const startWorld = screenToWorld(e.clientX, e.clientY);
    dragOffset.current = { x: startWorld.x - block.x, y: startWorld.y - block.y };
    const move = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const w = screenToWorld(ev.clientX, ev.clientY);
      onMove(Math.max(0, w.x - dragOffset.current.x), Math.max(0, w.y - dragOffset.current.y));
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
          <div className="text-[9px] font-bold uppercase tracking-wider text-white/80">{isInput ? "Input" : "Output"}</div>
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
        <div className="text-[10px] font-bold uppercase tracking-wider text-white/80">
          {block.defId === "fn.return" ? "Return" : "Process"}
        </div>
        {fieldsContent}
      </div>
    );
  }

  const showOut = category !== "conditions" && block.defId !== "fn.return";
  const hasError = issues.some((i) => i.severity === "error");
  const outlineColor = selected ? "var(--color-primary)" : hasError ? "#ef4444" : unreachable ? "var(--color-border)" : "transparent";
  const outlineStyleKind = selected || hasError ? "solid" : "dashed";

  return (
    <div
      data-block
      className="group absolute select-none"
      style={{
        left: block.x,
        top: block.y,
        width: BLOCK_W,
        outline: outlineColor === "transparent" ? "none" : `2px ${outlineStyleKind} ${outlineColor}`,
        outlineOffset: 4,
        borderRadius: 12,
        opacity: unreachable ? 0.55 : 1,
      }}
      onMouseDown={startDrag}
    >
      {issues.length > 0 && (
        <div
          className="absolute -left-1.5 -top-1.5 z-30 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white shadow-sm"
          title={issues.map((i) => i.message).join("\n")}
        >
          !
        </div>
      )}
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
          <span className="pointer-events-none absolute right-[-18px] top-[calc(50%+10px)] text-[9px] font-bold text-emerald-600">T</span>
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
          <span className="pointer-events-none absolute left-[-18px] top-[calc(50%+10px)] text-[9px] font-bold text-rose-600">F</span>
        </>
      ) : (
        <>
          {category === "loops" && (
            <>
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
              <span className="pointer-events-none absolute -left-4 top-[calc(50%-16px)] text-[11px] text-violet-500">↺</span>
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
  onFocus,
}: {
  field: BlockField;
  value: string;
  onChange: (v: string) => void;
  onFocus?: () => void;
}) {
  if (field.kind === "select") {
    return (
      <select
        data-no-drag
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
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
      onFocus={onFocus}
      onMouseDown={(e) => e.stopPropagation()}
      className="h-7 rounded-full border-0 bg-white/95 px-2.5 text-[12.5px] font-medium text-foreground shadow-soft outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-white"
      style={{ width: field.width ?? 90 }}
    />
  );
}

function FnCallFields({
  block,
  functions,
  onFieldChange,
  onFocus,
}: {
  block: PlacedBlock;
  functions: SavedFunction[];
  onFieldChange: (field: string, value: string) => void;
  onFocus?: () => void;
}) {
  const selectedId = block.values.__functionId ?? "";
  const selected = functions.find((f) => f.id === selectedId);

  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      <select
        data-no-drag
        value={selectedId}
        onChange={(e) => onFieldChange("__functionId", e.target.value)}
        onFocus={onFocus}
        onMouseDown={(e) => e.stopPropagation()}
        className="h-7 rounded-full border-0 bg-white/95 px-2 text-[12.5px] font-medium text-foreground shadow-soft outline-none focus:ring-2 focus:ring-white"
        style={{ maxWidth: 140 }}
      >
        <option value="">Select function…</option>
        {functions.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {selected?.params.map((p) => (
        <input
          key={p.name}
          data-no-drag
          value={block.values[p.name] ?? p.default ?? ""}
          placeholder={p.name}
          onChange={(e) => onFieldChange(p.name, e.target.value)}
          onFocus={onFocus}
          onMouseDown={(e) => e.stopPropagation()}
          className="h-7 rounded-full border-0 bg-white/95 px-2.5 text-[12.5px] font-medium text-foreground shadow-soft outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-white"
          style={{ width: 80 }}
        />
      ))}
    </div>
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
  const dx = Math.max(20, Math.abs(b.x - a.x) * 0.3);
  const goingSideways = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
  const c1x = goingSideways ? a.x + dx : a.x;
  const c1y = goingSideways ? a.y : a.y + dy;
  const c2x = goingSideways ? b.x - dx : b.x;
  const c2y = goingSideways ? b.y : b.y - dy;
  return `M ${a.x} ${a.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${b.x} ${b.y}`;
}

function elbowPath(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dropY = a.y + 28;
  const sideX = Math.min(a.x, b.x) - 40;
  return `M ${a.x} ${a.y} L ${a.x} ${dropY} L ${sideX} ${dropY} L ${sideX} ${b.y} L ${b.x} ${b.y}`;
}

// ---- Validation (function-body flavor: entry is fn.start, not start.main) ----

type ValidationIssue = { severity: "error" | "warning"; message: string };
type ValidationResult = {
  blockIssues: Map<string, ValidationIssue[]>;
  unreachableIds: Set<string>;
  globalMessages: ValidationIssue[];
};

function computeFunctionValidation(
  blocks: PlacedBlock[],
  connections: Connection[],
  functionIds: Set<string>,
): ValidationResult {
  const blockIssues = new Map<string, ValidationIssue[]>();
  const globalMessages: ValidationIssue[] = [];
  function addIssue(id: string, issue: ValidationIssue) {
    const list = blockIssues.get(id) ?? [];
    list.push(issue);
    blockIssues.set(id, list);
  }
  if (blocks.length === 0) return { blockIssues, unreachableIds: new Set(), globalMessages };

  const startBlocks = blocks.filter((b) => b.defId === "fn.start");
  if (startBlocks.length === 0) {
    globalMessages.push({ severity: "warning", message: "No Function Start block — add one to mark where the function begins." });
  } else if (startBlocks.length > 1) {
    globalMessages.push({ severity: "error", message: `${startBlocks.length} Function Start blocks found — only one is allowed.` });
    startBlocks.forEach((b) => addIssue(b.instanceId, { severity: "error", message: "Only one Function Start block is allowed." }));
  }

  const hasReturn = blocks.some((b) => b.defId === "fn.return");
  if (!hasReturn) {
    globalMessages.push({ severity: "warning", message: "Function has no Return block — it will implicitly return None." });
  }

  const hasIncoming = new Set<string>();
  const outgoingPortsByBlock = new Map<string, Set<PortId>>();
  for (const c of connections) {
    hasIncoming.add(c.to);
    if (!outgoingPortsByBlock.has(c.from)) outgoingPortsByBlock.set(c.from, new Set());
    outgoingPortsByBlock.get(c.from)!.add(c.fromPort);
  }

  for (const b of blocks) {
    const def = getBlockDef(b.defId);
    if (!def) continue;
    const isStart = b.defId === "fn.start";
    const outs = outgoingPortsByBlock.get(b.instanceId) ?? new Set<PortId>();

    if (isStart) {
      if (outs.size === 0) addIssue(b.instanceId, { severity: "warning", message: "Function Start isn't connected to anything." });
    } else if (!hasIncoming.has(b.instanceId)) {
      addIssue(b.instanceId, { severity: "error", message: "Not connected — nothing leads into this block." });
    }

    if (def.category === "conditions") {
      const hasTrue = outs.has("true");
      const hasFalse = outs.has("false");
      if (!hasTrue && !hasFalse) {
        addIssue(b.instanceId, { severity: "error", message: 'Decision block needs both "Yes" and "No" connections.' });
      } else if (!hasTrue) {
        addIssue(b.instanceId, { severity: "error", message: 'Missing "Yes" (True) connection.' });
      } else if (!hasFalse) {
        addIssue(b.instanceId, { severity: "error", message: 'Missing "No" (False) connection.' });
      }
    }

    if (def.category === "loops" && outs.size === 0) {
      addIssue(b.instanceId, { severity: "warning", message: "Loop has no body connected." });
    }

    if (b.defId === "fn.call") {
      const fid = b.values.__functionId;
      if (!fid) {
        addIssue(b.instanceId, { severity: "error", message: "No function selected for this call." });
      } else if (!functionIds.has(fid)) {
        addIssue(b.instanceId, { severity: "error", message: "The function this call refers to no longer exists." });
      }
    }
  }

  const forwardAdjacency = new Map<string, string[]>();
  for (const c of connections) {
    if (!forwardAdjacency.has(c.from)) forwardAdjacency.set(c.from, []);
    forwardAdjacency.get(c.from)!.push(c.to);
  }
  const reachable = new Set<string>();
  const queue = startBlocks.map((b) => b.instanceId);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of forwardAdjacency.get(id) ?? []) if (!reachable.has(next)) queue.push(next);
  }
  const unreachableIds = new Set<string>();
  if (startBlocks.length > 0) {
    for (const b of blocks) if (!reachable.has(b.instanceId)) unreachableIds.add(b.instanceId);
  }

  const cycleAdjacency = new Map<string, string[]>();
  for (const c of connections) {
    if (c.toPort === "loopback") continue;
    if (!cycleAdjacency.has(c.from)) cycleAdjacency.set(c.from, []);
    cycleAdjacency.get(c.from)!.push(c.to);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  blocks.forEach((b) => color.set(b.instanceId, WHITE));
  const inCycle = new Set<string>();
  const stack: string[] = [];
  function dfs(id: string) {
    color.set(id, GRAY);
    stack.push(id);
    for (const next of cycleAdjacency.get(id) ?? []) {
      if (color.get(next) === GRAY) {
        const idx = stack.indexOf(next);
        for (let i = idx; i < stack.length; i++) inCycle.add(stack[i]);
      } else if (color.get(next) === WHITE) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  }
  for (const b of blocks) if (color.get(b.instanceId) === WHITE) dfs(b.instanceId);
  for (const id of inCycle) {
    addIssue(id, { severity: "error", message: "Infinite loop detected — this cycle doesn't go through a Loop block's repeat connection." });
  }

  return { blockIssues, unreachableIds, globalMessages };
}

// ---- Live preview: generates this function's own `def name(...):` ----

function pythonIdentifier(name: string): string {
  const cleaned = (name || "function")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^([0-9])/, "_$1")
    .replace(/^_+|_+$/g, "");
  return cleaned || "function";
}

function previewEmitLine(b: PlacedBlock, indent: string, functionsById: Map<string, SavedFunction>): string {
  const v = b.values;
  switch (b.defId) {
    case "fn.start":
      return `${indent}# Entry point`;
    case "out.print":
      return `${indent}print(${previewPy(v.text)})`;
    case "out.format":
      return `${indent}${v.var || "msg"} = f${previewPy(v.template)}`;
    case "input.text":
      return `${indent}${v.var || "name"} = input(${previewPy(v.prompt)} + ": ")`;
    case "input.number":
      return `${indent}${v.var || "value"} = float(input(${previewPy(v.prompt)} + ": "))`;
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
    case "fn.call": {
      const fid: string | undefined = v.__functionId;
      const fn = fid ? functionsById.get(fid) : undefined;
      if (!fn) return `${indent}# Call function: none selected`;
      const identifier = pythonIdentifier(fn.name);
      const args = fn.params.map((p) => v[p.name] || p.default || "None").join(", ");
      return `${indent}${identifier}(${args})`;
    }
    case "file.read":
      return `${indent}${v.var || "data"} = open(${previewPy(v.path)}).read()`;
    case "file.write":
      return `${indent}open(${previewPy(v.path)}, "w").write(str(${v.var || "data"}))`;
    case "api.get":
      return `${indent}${v.var || "response"} = requests.get(${previewPy(v.url)})`;
    case "api.post":
      return `${indent}response = requests.post(${previewPy(v.url)}, json=${v.body || "{}"})`;
    case "ai.chat":
      return `${indent}${v.var || "reply"} = ai.chat(${previewPy(v.prompt)})`;
    case "ai.classify":
      return `${indent}${v.var || "label"} = ai.classify(${previewPy(v.text)})`;
    case "ai.image":
      return `${indent}${v.var || "image"} = ai.image(${previewPy(v.prompt)})`;
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

function previewPy(s: string | undefined) {
  const v = (s ?? "").replace(/"/g, '\\"');
  return `"${v}"`;
}

type PreviewChainResult = { lines: string[]; mergeConnectorId?: string };

function generateFunctionPreview(
  name: string,
  params: FunctionParam[],
  blocks: PlacedBlock[],
  connections: Connection[],
  functions: SavedFunction[],
): string {
  const functionsById = new Map(functions.map((f) => [f.id, f]));
  const identifier = pythonIdentifier(name);
  const paramList = params.map((p) => (p.default ? `${p.name}=${p.default}` : p.name)).join(", ");

  if (blocks.length === 0) {
    return `def ${identifier}(${paramList}):\n    pass\n`;
  }

  const byId = new Map(blocks.map((b) => [b.instanceId, b]));
  const outByPort = new Map<string, Connection>();
  const hasIncomingIn = new Set<string>();
  for (const c of connections) {
    outByPort.set(`${c.from}:${c.fromPort}`, c);
    if (c.toPort === "in") hasIncomingIn.add(c.to);
  }
  const visited = new Set<string>();

  function continueFromMerge(mergeId: string | undefined, indent: string): PreviewChainResult {
    if (!mergeId) return { lines: [] };
    const afterConn = outByPort.get(`${mergeId}:out`);
    if (!afterConn) return { lines: [] };
    return genChain(afterConn.to, indent);
  }

  function genChain(blockId: string, indent: string): PreviewChainResult {
    const block = byId.get(blockId);
    if (!block) return { lines: [] };
    const def = getBlockDef(block.defId);
    if (!def) return { lines: [] };
    if (def.category === "connector") return { lines: [], mergeConnectorId: blockId };
    if (visited.has(blockId)) return { lines: [] };
    visited.add(blockId);
    const v = block.values;

    if (block.defId === "if.then") {
      const lines = [`${indent}if ${v.cond || "True"}:`];
      const trueConn = outByPort.get(`${blockId}:true`);
      const trueResult = trueConn ? genChain(trueConn.to, indent + "    ") : { lines: [] };
      lines.push(...(trueResult.lines.length ? trueResult.lines : [`${indent}    pass`]));
      let falseResult: PreviewChainResult = { lines: [] };
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

    if (block.defId === "fn.return") {
      return { lines: [`${indent}return ${v.value || "None"}`] };
    }

    const lines = [previewEmitLine(block, indent, functionsById)];
    const next = outByPort.get(`${blockId}:out`);
    if (next && next.toPort !== "loopback") {
      const nextResult = genChain(next.to, indent);
      lines.push(...nextResult.lines);
      return { lines, mergeConnectorId: nextResult.mergeConnectorId };
    }
    return { lines };
  }

  const roots = blocks.filter((b) => b.defId === "fn.start");
  const rootIds = roots.length > 0
    ? roots.map((b) => b.instanceId)
    : blocks.filter((b) => !hasIncomingIn.has(b.instanceId)).sort((a, b) => a.y - b.y || a.x - b.x).map((b) => b.instanceId);

  const bodyLines: string[] = [];
  const runChainToEnd = (startId: string) => {
    let result = genChain(startId, "    ");
    bodyLines.push(...result.lines);
    while (result.mergeConnectorId) {
      result = continueFromMerge(result.mergeConnectorId, "    ");
      bodyLines.push(...result.lines);
    }
  };
  for (const r of rootIds) runChainToEnd(r);
  for (const b of blocks) {
    if (!visited.has(b.instanceId) && getBlockDef(b.defId)?.category !== "connector") runChainToEnd(b.instanceId);
  }

  const body = bodyLines.length ? bodyLines.join("\n") : "    pass";
  return `def ${identifier}(${paramList}):\n${body}\n`;
}