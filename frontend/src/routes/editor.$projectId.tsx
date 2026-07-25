import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Maximize,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { BLOCK_CATEGORIES, getBlockDef, type BlockDef, type BlockField } from "@/lib/blocks";
import { projectStore, type Project } from "@/lib/projectStore";
import { pullFromServer } from "@/lib/sync";
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
  const connectionsRef = useRef<Connection[]>(connections);
  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);
  // Guards the autosave effect below against firing on the initial load
  // itself — without this, hydrating state from storage looks identical
  // to a real edit, which would immediately re-save (and re-timestamp)
  // whatever was just read, clobbering any newer server data with stale
  // local data on every single page load.
  const skipNextAutosaveRef = useRef(true);

  // ---- Undo / redo ----
  // Snapshots are taken at the START of a discrete action (drag begins,
  // field gains focus, connection starts, block added/removed) rather
  // than on every intermediate change — so dragging a block doesn't
  // create dozens of undo steps, only one per drag gesture.
  const HISTORY_LIMIT = 50;
  const pastRef = useRef<{ placed: PlacedBlock[]; connections: Connection[] }[]>([]);
  const futureRef = useRef<{ placed: PlacedBlock[]; connections: Connection[] }[]>([]);
  const [historyTick, setHistoryTick] = useState(0); // bumped to force re-render for button disabled state
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

  /** Converts a viewport-relative mouse position (clientX/Y) into world
   * (canvas content) coordinates, accounting for the current pan/zoom. */
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
      setCamera({
        scale: newScale,
        panX: cursorX - worldX * newScale,
        panY: cursorY - worldY * newScale,
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** Middle-mouse drag, or left-click drag while Space is held, pans the
   * canvas. A left-click on empty canvas (no block/port under it) clears
   * the current selection instead. */
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
    // Step the clipboard's reference position so repeated pastes cascade
    // diagonally instead of stacking exactly on top of each other.
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
        e.preventDefault(); // avoid page scroll
        spaceDownRef.current = true;
        setSpaceDown(true);
        return;
      }

      if (isEditableTarget(e.target)) return; // let native behavior work inside text fields

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
        e.preventDefault(); // otherwise the browser bookmarks the page
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
    skipNextAutosaveRef.current = true; // reset per project load — see autosave effect below
    pastRef.current = [];
    futureRef.current = [];
    (async () => {
      // Pull first: without this, a newer server copy (e.g. edited
      // directly in Postgres, or from another device) would never be
      // seen — the editor would just hydrate from whatever's already in
      // local IndexedDB, which could be stale.
      await pullFromServer();
      const p = await projectStore.get(projectId);
      if (cancelled) return;
      if (!p) {
        navigate({ to: "/" });
        return;
      }
      setProject(p);
      setNameDraft(p.name);
      setPlaced((p.blocks as PlacedBlock[] | undefined) ?? []);
      setConnections((p.connections as Connection[] | undefined) ?? []);
    })();
    return () => {
      cancelled = true;
    };
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

  async function commitName() {
    setEditingName(false);
    if (!project) return;
    const name = nameDraft.trim() || project.name;
    await projectStore.rename(project.id, name);
    setProject({ ...project, name });
  }

  async function handleSave() {
    if (!project) return;
    await projectStore.saveState(project.id, project.name, placed, connections);
    toast.success("Project saved", { description: "Stored locally and queued to sync." });
  }

  // Debounced autosave: persist canvas edits ~800ms after the user stops
  // dragging/typing, so work survives a refresh without needing a manual
  // Save click. The skipNextAutosaveRef guard (reset per project load,
  // above) prevents this from firing on the initial hydration itself —
  // only genuine subsequent edits trigger a save.
  useEffect(() => {
    if (!project) return;
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      void projectStore.saveState(project.id, project.name, placed, connections);
    }, 800);
    return () => clearTimeout(timer);
  }, [project, placed, connections]);

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
          <button
            onClick={undo}
            disabled={!canUndo}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="h-4 w-4" />
          </button>
          <div className="mr-1 h-5 w-px bg-border" />
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
              {/* Connection lines */}
              <svg className="pointer-events-none absolute left-0 top-0 overflow-visible">
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
                  connecting={!!pending && pending.from !== b.instanceId}
                />
              ))}
            </div>

            {placed.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  Drag a block here to get started
                </p>
              </div>
            )}

            {/* Zoom / pan toolbar */}
            <div className="absolute bottom-4 right-4 z-30 flex items-center gap-0.5 rounded-lg border border-border bg-surface/95 px-1.5 py-1 shadow-lift backdrop-blur">
              <button
                onClick={zoomOut}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Zoom out"
                aria-label="Zoom out"
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
                aria-label="Zoom in"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
              <div className="mx-1 h-4 w-px bg-border" />
              <button
                onClick={resetZoom}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Reset zoom"
                aria-label="Reset zoom"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={fitToScreen}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Fit to screen"
                aria-label="Fit to screen"
              >
                <Maximize className="h-3.5 w-3.5" />
              </button>
            </div>
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
  onBeforeChange,
  selected,
  onSelect,
  panModeActive,
  screenToWorld,
  connecting,
}: {
  block: PlacedBlock;
  onRemove: () => void;
  onMove: (x: number, y: number) => void;
  onFieldChange: (field: string, value: string) => void;
  onStartConnect: (portId: PortId, clientX: number, clientY: number) => void;
  onPortEnter: (portId: PortId) => void;
  onPortLeave: () => void;
  /** Called once, right before a drag or field edit begins, to commit an
   * undo/redo snapshot of the pre-change state. */
  onBeforeChange: () => void;
  selected: boolean;
  onSelect: (shiftKey: boolean) => void;
  /** True while Space is held — drag should pan the canvas instead of
   * moving this block. */
  panModeActive: boolean;
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number };
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
            onFocus={onBeforeChange}
          />
        ),
      )}
    </div>
  ) : (
    <div className="text-[13px] font-semibold text-white truncate">{def.label}</div>
  );

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // left-click only — let middle-click bubble to canvas panning
    if (panModeActive) return; // Space held — let it bubble to canvas panning instead
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
      data-block
      className="group absolute select-none"
      style={{
        left: block.x,
        top: block.y,
        width: BLOCK_W,
        outline: selected ? "2px solid var(--color-primary)" : "none",
        outlineOffset: 4,
        borderRadius: 12,
      }}
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