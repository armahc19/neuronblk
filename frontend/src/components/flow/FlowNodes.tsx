import { Handle, Position, useReactFlow } from "@xyflow/react";
import type { BlockField, BlockDef } from "../../lib/blocks";

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

function NodeDeleteButton({ id }: { id: string }) {
  const { setNodes, setEdges } = useReactFlow();
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setNodes((nds) => nds.filter((n) => n.id !== id));
        setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
      }}
      className="absolute -right-2 -top-2 z-50 flex h-4 w-4 items-center justify-center rounded-full bg-black/40 text-[12px] font-bold text-white opacity-0 transition-opacity hover:bg-red-500 hover:text-white group-hover:opacity-100 shadow-sm"
      title="Delete"
    >
      ×
    </button>
  );
}

export function OvalNode({ id, data }: any) {
  return (
    <div className="group relative flex h-10 min-w-[100px] items-center justify-center rounded-[50px] border-2 bg-emerald-500 border-emerald-700 px-4 text-white shadow-sm">
      <NodeDeleteButton id={id} />
      <Handle type="target" position={Position.Top} />
      <div className="text-[11px] font-bold truncate">{data.label || "Start"}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function ParallelogramNode({ id, data }: any) {
  const isInput = data.isInput;
  return (
    <div className="group relative flex h-12 min-w-[120px] items-center justify-center border-2 text-white shadow-sm"
         style={{ transform: "skewX(-15deg)", borderRadius: "6px", backgroundColor: isInput ? "#f59e0b" : "#ec4899", borderColor: isInput ? "#b45309" : "#be185d" }}>
      <div style={{ transform: "skewX(15deg)" }} className="absolute inset-0 pointer-events-none">
        <NodeDeleteButton id={id} />
      </div>
      <Handle type="target" position={Position.Top} style={{ transform: "skewX(15deg)" }} />
      <div className="flex flex-col items-center px-4" style={{ transform: "skewX(15deg)" }}>
        <div className="mb-0 text-[8px] font-bold uppercase tracking-wider opacity-80">{isInput ? "Input" : "Output"}</div>
        <div className="text-[11px] font-medium truncate">{data.label}</div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ transform: "skewX(15deg)" }} />
    </div>
  );
}

export function DiamondNode({ id, data }: any) {
  return (
    <div className="group relative flex h-[72px] w-[140px] items-center justify-center py-1">
      <div className="absolute h-14 w-14 rounded-sm border-[1.5px] bg-orange-500 border-orange-700 shadow-sm" style={{ transform: "rotate(45deg)" }} />
      <div className="absolute inset-0 pointer-events-none z-50">
        <NodeDeleteButton id={id} />
      </div>
      <Handle type="target" position={Position.Top} />
      <div className="relative z-10 flex flex-col items-center text-center text-white px-2">
        <div className="mb-0 text-[8px] font-bold uppercase tracking-wider opacity-80">Decision</div>
        <div className="text-[10px] font-medium leading-tight max-w-[80px] truncate">{data.label}</div>
      </div>
      <Handle type="source" position={Position.Right} id="true" />
      <Handle type="source" position={Position.Bottom} id="false" />
    </div>
  );
}

function NodeContent({
  id,
  block,
  fallbackLabel,
  values,
}: {
  id: string;
  block?: BlockDef;
  fallbackLabel: string;
  values: Record<string, string>;
}) {
  const { setNodes } = useReactFlow();

  if (!block || !block.template) return <div className="text-[11px] font-medium text-center truncate w-full">{fallbackLabel}</div>;
  const segments = renderTemplate(block.template, block.fields ?? []);
  if (!segments || segments.length === 0 || !block.fields || block.fields.length === 0) {
    return <div className="text-[11px] font-medium text-center truncate w-full">{fallbackLabel}</div>;
  }

  const handleChange = (fieldName: string, value: string) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, values: { ...((n.data as any).values ?? {}), [fieldName]: value } } }
          : n,
      ),
    );
  };

  return (
    <div className="flex flex-wrap items-center justify-center gap-1 mt-0.5">
      {segments.map((seg, i) =>
        seg.type === "text" ? (
          <span key={i} className="text-[10px] font-medium whitespace-nowrap">{seg.value}</span>
        ) : (
          <input
            key={i}
            value={values?.[seg.field.name] ?? ""}
            placeholder={(seg.field as { placeholder?: string }).placeholder}
            onChange={(e) => handleChange(seg.field.name, e.target.value)}
            className="h-[22px] rounded-[3px] border-0 bg-white/95 px-1.5 text-[10px] font-medium text-black shadow-soft outline-none placeholder:text-muted-foreground/70 nodrag"
            style={{ width: Math.max(50, (seg.field.width ?? 60) * 0.9) }}
          />
        )
      )}
    </div>
  );
}

export function RectangleNode({ id, data }: any) {
  return (
    <div className="group relative flex h-auto min-h-[50px] min-w-[140px] flex-col items-center justify-center rounded-md border-2 bg-blue-500 border-blue-700 p-2 text-white shadow-sm">
      <NodeDeleteButton id={id} />
      <Handle type="target" position={Position.Top} />
      <div className="mb-0 text-[8px] font-bold uppercase tracking-wider opacity-80">Process</div>
      <NodeContent id={id} block={data.block} fallbackLabel={data.label} values={data.values ?? {}} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const nodeTypes = {
  oval: OvalNode,
  parallelogram: ParallelogramNode,
  rectangle: RectangleNode,
  diamond: DiamondNode,
};