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
  AlertTriangle,
  FileDown,
  FileJson,
  FileUp,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { BLOCK_CATEGORIES, getBlockDef, type BlockDef, type BlockField } from "@/lib/blocks";
import { projectStore, type Project } from "@/lib/projectStore";
import { functionStore, type SavedFunction } from "@/lib/functionStore";
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
  const [functions, setFunctions] = useState<SavedFunction[]>([]);
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
      // local IndexedDB, which could be stale. This also pulls functions
      // (pullFromServer covers both kinds), so the list below is fresh.
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
      setFunctions(await functionStore.list());
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, navigate]);

  useEffect(() => {
    const onFunctionsUpdated = () => void functionStore.list().then(setFunctions);
    window.addEventListener("neuronblk:functions-updated", onFunctionsUpdated);
    return () => window.removeEventListener("neuronblk:functions-updated", onFunctionsUpdated);
  }, []);

  const filteredCategories = useMemo(() => {
    const q = query.trim().toLowerCase();
    return BLOCK_CATEGORIES.map((c) => ({
      ...c,
      blocks: c.blocks.filter((b) => {
        if (b.contexts && !b.contexts.includes("project")) return false;
        if (!q) return true;
        return b.label.toLowerCase().includes(q) || b.description.toLowerCase().includes(q);
      }),
    })).filter((c) => c.blocks.length > 0);
  }, [query]);

  const orderedBlocks = useMemo(() => orderByConnections(placed, connections), [placed, connections]);
  const validation = useMemo(
    () => computeValidation(placed, connections, new Set(functions.map((f) => f.id))),
    [placed, connections, functions],
  );
  const generatedPython = useMemo(
    () => generatePython(project?.name, placed, connections, functions),
    [project?.name, placed, connections, functions],
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

  function downloadBlob(content: string, mimeType: string, filename: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function safeFileName(name: string) {
    return (name || "project").trim().replace(/[^a-z0-9_\-]+/gi, "_") || "project";
  }

  function downloadPython() {
    downloadBlob(generatedPython, "text/x-python", `${safeFileName(project?.name)}.py`);
  }

  function exportFlowchart() {
    const payload = {
      format: "neuronblk-flowchart",
      version: 1,
      name: project?.name ?? "Untitled",
      exportedAt: new Date().toISOString(),
      blocks: placed,
      connections,
    };
    downloadBlob(JSON.stringify(payload, null, 2), "application/json", `${safeFileName(project?.name)}.neuronblk.json`);
  }

  const importInputRef = useRef<HTMLInputElement>(null);

  const VALID_PORT_IDS = new Set<string>(["in", "out", "true", "false", "loopback"]);
  function isPortId(v: unknown): v is PortId {
    return typeof v === "string" && VALID_PORT_IDS.has(v);
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so re-selecting the same file still fires onChange
    if (!file) return;

    let data: any;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast.error("Import failed", { description: "That file isn't valid JSON." });
      return;
    }

    const rawBlocks = Array.isArray(data?.blocks) ? data.blocks : null;
    const rawConns = Array.isArray(data?.connections) ? data.connections : null;
    if (!rawBlocks || !rawConns) {
      toast.error("Invalid file", { description: "This doesn't look like a NeuronBLK flowchart export." });
      return;
    }

    // Validate each block/connection's shape so malformed or hand-edited
    // JSON can't crash the canvas — anything that doesn't fit is dropped
    // rather than rendered.
    const validBlocks: PlacedBlock[] = rawBlocks
      .filter(
        (b: any) =>
          b &&
          typeof b.instanceId === "string" &&
          typeof b.defId === "string" &&
          typeof b.x === "number" &&
          typeof b.y === "number" &&
          !!getBlockDef(b.defId),
      )
      .map((b: any) => ({
        instanceId: b.instanceId,
        defId: b.defId,
        x: b.x,
        y: b.y,
        values: b.values && typeof b.values === "object" ? b.values : {},
      }));
    const validIds = new Set(validBlocks.map((b) => b.instanceId));
    const validConns: Connection[] = rawConns.filter(
      (c: any) =>
        c &&
        typeof c.id === "string" &&
        validIds.has(c.from) &&
        validIds.has(c.to) &&
        isPortId(c.fromPort) &&
        isPortId(c.toPort),
    );

    const droppedBlocks = rawBlocks.length - validBlocks.length;
    const droppedConns = rawConns.length - validConns.length;

    commitHistory({ placed, connections });
    setPlaced(validBlocks);
    setConnections(validConns);
    setSelectedIds(new Set());
    resetZoom();

    if (droppedBlocks > 0 || droppedConns > 0) {
      toast.warning("Imported with some issues", {
        description: `Loaded ${validBlocks.length} block(s). Skipped ${droppedBlocks} invalid block(s) and ${droppedConns} invalid connection(s).`,
      });
    } else {
      toast.success("Flowchart imported", {
        description: `${validBlocks.length} block${validBlocks.length === 1 ? "" : "s"} loaded.`,
      });
    }
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
            onClick={exportFlowchart}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Export flowchart as JSON"
            title="Export flowchart (.json)"
          >
            <FileJson className="h-4 w-4" />
          </button>
          <button
            onClick={() => importInputRef.current?.click()}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Import flowchart from JSON"
            title="Import flowchart (.json)"
          >
            <FileUp className="h-4 w-4" />
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            onChange={handleImportFile}
            className="hidden"
          />
          <Link
            to="/functions"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Manage functions"
            title="Functions library"
          >
            <Boxes className="h-4 w-4" />
          </Link>
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
                  issues={validation.blockIssues.get(b.instanceId) ?? []}
                  unreachable={validation.unreachableIds.has(b.instanceId)}
                  functions={functions}
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

            {/* Program-level validation messages — small banner, not a dialog */}
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
            onDownloadPython={downloadPython}
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
  /** Called once, right before a drag or field edit begins, to commit an
   * undo/redo snapshot of the pre-change state. */
  onBeforeChange: () => void;
  selected: boolean;
  onSelect: (shiftKey: boolean) => void;
  /** True while Space is held — drag should pan the canvas instead of
   * moving this block. */
  panModeActive: boolean;
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number };
  /** Validation problems specific to this block — rendered as a small
   * red badge with the messages in its hover tooltip. */
  issues: ValidationIssue[];
  /** True if this block exists but is never reached from any Start
   * block — dead code, shown dimmed with a dashed outline. */
  unreachable: boolean;
  /** The saved-function library, needed only by fn.call's dynamic
   * picker — every other block ignores this. */
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

/**
 * Custom renderer for fn.call blocks: a dropdown to pick which saved
 * function to invoke, followed by one inline input per parameter that
 * specific function declares — reshaping live as the selection changes.
 * The selected function's id lives in block.values.__functionId; each
 * parameter's value lives under its own name, same as any other field.
 */
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
      {selected && (
        <>
          <span className="text-[11px] font-medium text-white/80">→</span>
          <input
            data-no-drag
            value={block.values.__resultVar ?? ""}
            placeholder="store as (optional)"
            onChange={(e) => onFieldChange("__resultVar", e.target.value)}
            onFocus={onFocus}
            onMouseDown={(e) => e.stopPropagation()}
            className="h-7 rounded-full border-0 bg-white/95 px-2.5 text-[12.5px] font-medium text-foreground shadow-soft outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-white"
            style={{ width: 110 }}
          />
        </>
      )}
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
 * Validation rules for beginner-friendly structural checks — surfaced as
 * per-block markers and a small non-blocking banner, not a popup dialog.
 */
type ValidationIssue = { severity: "error" | "warning"; message: string };

type ValidationResult = {
  /** Per-block problems — rendered as a small red badge + hover tooltip
   * on the specific block, per the "highlight, don't dialog" approach. */
  blockIssues: Map<string, ValidationIssue[]>;
  /** Blocks that exist and may even be internally well-formed, but are
   * never reached from any Start block — dead code. */
  unreachableIds: Set<string>;
  /** Problems that can't be pinned to one block (e.g. "no Start block at
   * all") — shown as a small banner instead of a per-block marker. */
  globalMessages: ValidationIssue[];
};

function computeValidation(
  blocks: PlacedBlock[],
  connections: Connection[],
  functionIds: Set<string> = new Set(),
): ValidationResult {
  const blockIssues = new Map<string, ValidationIssue[]>();
  const globalMessages: ValidationIssue[] = [];

  function addIssue(id: string, issue: ValidationIssue) {
    const list = blockIssues.get(id) ?? [];
    list.push(issue);
    blockIssues.set(id, list);
  }

  if (blocks.length === 0) {
    return { blockIssues, unreachableIds: new Set(), globalMessages };
  }

  // Rule: exactly one Start block.
  const startBlocks = blocks.filter((b) => b.defId === "start.main");
  if (startBlocks.length === 0) {
    globalMessages.push({ severity: "warning", message: "No Start block — add one to define where the program begins." });
  } else if (startBlocks.length > 1) {
    globalMessages.push({ severity: "error", message: `${startBlocks.length} Start blocks found — only one is allowed.` });
    startBlocks.forEach((b) => addIssue(b.instanceId, { severity: "error", message: "Only one Start block is allowed." }));
  }

  // Rule: at least one End block.
  const endBlocks = blocks.filter((b) => b.defId === "start.stop");
  if (endBlocks.length === 0) {
    globalMessages.push({ severity: "warning", message: "Program has no End block." });
  }

  // Rule: every non-Start block should have something feeding into it;
  // a Start block should lead somewhere. Covers both fully isolated
  // blocks and blocks that only look connected because they have an
  // outgoing wire but nothing upstream ever reaches them.
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
    const isStart = b.defId === "start.main";
    const outs = outgoingPortsByBlock.get(b.instanceId) ?? new Set<PortId>();

    if (isStart) {
      if (outs.size === 0) {
        addIssue(b.instanceId, { severity: "warning", message: "Start block isn't connected to anything." });
      }
    } else if (!hasIncoming.has(b.instanceId)) {
      addIssue(b.instanceId, { severity: "error", message: "Not connected — nothing leads into this block." });
    }

    // Rule: decision (diamond) blocks need both Yes and No wired.
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

    // Rule: a Loop block needs something wired to its body (the "out"
    // port) — otherwise there's nothing to actually repeat.
    if (def.category === "loops" && outs.size === 0) {
      addIssue(b.instanceId, { severity: "warning", message: "Loop has no body connected." });
    }

    // Rule: fn.call must reference a function that still exists — the
    // library entry could be missing entirely (nothing picked yet) or
    // have been deleted since this call was placed.
    if (b.defId === "fn.call") {
      const fid = b.values.__functionId;
      if (!fid) {
        addIssue(b.instanceId, { severity: "error", message: "No function selected for this call." });
      } else if (!functionIds.has(fid)) {
        addIssue(b.instanceId, { severity: "error", message: "The function this call refers to no longer exists." });
      }
    }
  }

  // Rule: unreachable blocks — dead code that exists and may even wire
  // together fine internally, but is never reached from any Start block.
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
    for (const next of forwardAdjacency.get(id) ?? []) {
      if (!reachable.has(next)) queue.push(next);
    }
  }
  const unreachableIds = new Set<string>();
  if (startBlocks.length > 0) {
    for (const b of blocks) {
      if (!reachable.has(b.instanceId)) unreachableIds.add(b.instanceId);
    }
  }

  // Rule: infinite cycles — a cycle in the flow that does NOT go through
  // a loop block's dedicated "loopback" port (the one sanctioned way to
  // intentionally repeat) is almost certainly an accidental miswiring.
  const cycleAdjacency = new Map<string, string[]>();
  for (const c of connections) {
    if (c.toPort === "loopback") continue; // legitimate repeat edge, not a bug
    if (!cycleAdjacency.has(c.from)) cycleAdjacency.set(c.from, []);
    cycleAdjacency.get(c.from)!.push(c.to);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
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
  for (const b of blocks) {
    if (color.get(b.instanceId) === WHITE) dfs(b.instanceId);
  }
  for (const id of inCycle) {
    addIssue(id, {
      severity: "error",
      message: "Infinite loop detected — this cycle doesn't go through a Loop block's repeat connection.",
    });
  }

  return { blockIssues, unreachableIds, globalMessages };
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
  onDownloadPython,
}: {
  open: boolean;
  onToggle: () => void;
  python: string;
  terminal: string[];
  logs: string[];
  onDownloadPython: () => void;
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
          <div className="flex items-center gap-1">
            <button
              onClick={onDownloadPython}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Download generated Python (.py)"
            >
              <FileDown className="h-3.5 w-3.5" />
              Download .py
            </button>
            <button
              onClick={onToggle}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={open ? "Collapse panel" : "Expand panel"}
            >
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </button>
          </div>
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
function emitLine(
  b: PlacedBlock,
  indent: string,
  functionsById: Map<string, SavedFunction>,
  identifierById: Map<string, string>,
): string {
  const v = b.values;
  switch (b.defId) {
    case "start.main":
    case "fn.start":
      return `${indent}# Entry point`;
    case "start.stop":
      return `${indent}return`;
    case "out.print":
      return `${indent}print(f${py(v.text)})`;
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
    case "fn.call": {
      const fid: string | undefined = v.__functionId;
      const fn = fid ? functionsById.get(fid) : undefined;
      if (!fn) return `${indent}# Call function: none selected`;
      const identifier = (fid && identifierById.get(fid)) ?? pythonIdentifier(fn.name);
      const args = fn.params.map((p) => v[p.name] || p.default || "None").join(", ");
      const resultVar = v.__resultVar?.trim();
      return resultVar ? `${indent}${resultVar} = ${identifier}(${args})` : `${indent}${identifier}(${args})`;
    }
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

/** Sanitizes a user-provided display name into a valid-ish Python
 * identifier for def/call sites — names come from free text in the
 * Function Editor and can contain spaces, punctuation, etc. */
function pythonIdentifier(name: string): string {
  const cleaned = (name || "function")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^([0-9])/, "_$1")
    .replace(/^_+|_+$/g, "");
  return cleaned || "function";
}

/**
 * Walks the actual connection graph to produce properly nested Python:
 * - if.then follows its "true" port for the if-body and "false" port for
 *   the else-body, indented one level deeper.
 * - loop.for/loop.while follow their "out" port for the loop body,
 *   indented one level deeper.
 * - fn.return ends that path with a `return` line and never continues,
 *   the same way start.stop does for the main program.
 * - A block's "out" connection normally continues the chain at the same
 *   indent — except when it targets a loop's "loopback" port, which marks
 *   "repeat" rather than "continue on", so the chain stops there instead
 *   of recursing back into the loop header.
 * - A Connector block (small circle) is a merge/jump point: reaching one
 *   from any branch stops that branch there instead of inlining further
 *   code. Whichever if/else or loop produced that branch then continues
 *   the OUTER chain — at its own original indent — from the connector's
 *   "out" port.
 *
 * This is shared by both the main program body and every saved
 * function's body — a function's body is just another set of
 * blocks/connections with its own root(s).
 */
type ChainResult = { lines: string[]; mergeConnectorId?: string };

function generateBody(
  blocks: PlacedBlock[],
  connections: Connection[],
  functionsById: Map<string, SavedFunction>,
  identifierById: Map<string, string>,
  rootIds: string[],
): string {
  if (blocks.length === 0) return "    pass";

  const byId = new Map(blocks.map((b) => [b.instanceId, b]));
  const outByPort = new Map<string, Connection>();
  for (const c of connections) outByPort.set(`${c.from}:${c.fromPort}`, c);

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

    if (block.defId === "fn.return") {
      return { lines: [`${indent}return ${v.value || "None"}`] };
    }

    const lines = [emitLine(block, indent, functionsById, identifierById)];
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
  // Anything never reached (disconnected islands) is still emitted so
  // nothing dropped on the canvas silently disappears from the code.
  for (const b of blocks) {
    if (!visited.has(b.instanceId) && getBlockDef(b.defId)?.category !== "connector") {
      runChainToEnd(b.instanceId);
    }
  }

  return bodyLines.length ? bodyLines.join("\n") : "    pass";
}

/** Root blocks for a body with no explicit dedicated entry block: those
 * with nothing feeding their "in" port. Used for the main program (whose
 * roots are just "whatever has no incoming connection") — a function
 * body instead roots specifically from its fn.start block(s). */
function computeDefaultRoots(blocks: PlacedBlock[], connections: Connection[]): string[] {
  const hasIncomingIn = new Set<string>();
  for (const c of connections) if (c.toPort === "in") hasIncomingIn.add(c.to);
  return blocks
    .filter((b) => !hasIncomingIn.has(b.instanceId))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((b) => b.instanceId);
}

/** Walks every fn.call in `blocks`, and recursively into each called
 * function's own body (nested reuse), collecting every function id
 * transitively used. The `collected` guard means self-recursion and
 * mutual recursion between functions terminate safely instead of
 * looping forever — once a function's id is collected, its body is
 * scanned exactly once. */
function collectCalledFunctionIds(
  blocks: PlacedBlock[],
  functionsById: Map<string, SavedFunction>,
  collected: Set<string>,
  depth = 0,
) {
  if (depth > 50) return; // defensive cap against pathological/malformed data
  for (const b of blocks) {
    if (b.defId !== "fn.call") continue;
    const fid: string | undefined = b.values.__functionId;
    if (!fid || collected.has(fid) || !functionsById.has(fid)) continue;
    collected.add(fid);
    const fn = functionsById.get(fid)!;
    collectCalledFunctionIds((fn.blocks as PlacedBlock[]) ?? [], functionsById, collected, depth + 1);
  }
}

function generatePython(
  projectName: string | undefined,
  blocks: PlacedBlock[],
  connections: Connection[],
  functions: SavedFunction[],
) {
  const functionsById = new Map(functions.map((f) => [f.id, f]));
  const header = `# ${projectName ?? "Untitled"} — generated by NeuronBLK\n\n`;

  if (blocks.length === 0) {
    return (
      header +
      "def main():\n    # Drag blocks onto the canvas to generate code.\n    pass\n\nif __name__ == \"__main__\":\n    main()\n"
    );
  }

  // Collect every function transitively reachable via fn.call so nested
  // reuse (a saved function calling another saved function) is included.
  const calledIds = new Set<string>();
  collectCalledFunctionIds(blocks, functionsById, calledIds);

  // Assign each a de-duplicated Python identifier up front — two saved
  // functions can share a display name without colliding in the file.
  const usedNames = new Set<string>();
  const identifierById = new Map<string, string>();
  for (const fid of calledIds) {
    const fn = functionsById.get(fid)!;
    const base = pythonIdentifier(fn.name);
    let candidate = base;
    let n = 2;
    while (usedNames.has(candidate)) candidate = `${base}_${n++}`;
    usedNames.add(candidate);
    identifierById.set(fid, candidate);
  }

  const defSections = [...calledIds].map((fid) => {
    const fn = functionsById.get(fid)!;
    const fnBlocks = (fn.blocks as PlacedBlock[]) ?? [];
    const fnConnections = (fn.connections as Connection[]) ?? [];
    const startBlocks = fnBlocks.filter((b) => b.defId === "fn.start");
    const rootIds =
      startBlocks.length > 0 ? startBlocks.map((b) => b.instanceId) : computeDefaultRoots(fnBlocks, fnConnections);
    const paramList = fn.params.map((p) => (p.default ? `${p.name}=${p.default}` : p.name)).join(", ");
    const body = generateBody(fnBlocks, fnConnections, functionsById, identifierById, rootIds);
    return `def ${identifierById.get(fid)}(${paramList}):\n${body}\n`;
  });

  const mainRootIds = computeDefaultRoots(blocks, connections);
  const mainBody = generateBody(blocks, connections, functionsById, identifierById, mainRootIds);

  const defsBlock = defSections.length > 0 ? defSections.join("\n") + "\n" : "";
  return `${header}${defsBlock}def main():\n${mainBody}\n\nif __name__ == "__main__":\n    main()\n`;
}

function py(s: string | undefined) {
  const v = (s ?? "").replace(/"/g, '\\"');
  return `"${v}"`;
}