import React, { useCallback, useRef } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  addEdge,
  Connection,
  Edge,
  Node,
  BackgroundVariant,
  ReactFlowProvider,
  useReactFlow,
  type OnNodesChange,
  type OnEdgesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { OvalNode, ParallelogramNode, RectangleNode, DiamondNode } from './FlowNodes';

// IMPORTANT: nodeTypes must be defined at module level (outside components)
// so React Flow gets a stable reference and doesn't fall back to the default node.
const nodeTypes = {
  oval: OvalNode,
  parallelogram: ParallelogramNode,
  rectangle: RectangleNode,
  diamond: DiamondNode,
};

type FlowCanvasProps = {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  onNodeClick?: (node: Node) => void;
};

function FlowCanvasInner({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  setNodes,
  setEdges,
  onNodeClick,
}: FlowCanvasProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const reactFlowInstance = useReactFlow();
  // screenToFlowPosition exists in @xyflow/react v12+; project() is the
  // older reactflow v11 equivalent. Support both so a version mismatch
  // can't silently break drop positioning.
  const toFlowPosition = useCallback(
    (point: { x: number; y: number }) => {
      const inst = reactFlowInstance as any;
      if (typeof inst.screenToFlowPosition === "function") {
        return inst.screenToFlowPosition(point);
      }
      if (typeof inst.project === "function") {
        return inst.project(point);
      }
      // Last-resort fallback: raw screen coordinates minus wrapper offset.
      const rect = reactFlowWrapper.current?.getBoundingClientRect();
      return { x: point.x - (rect?.left ?? 0), y: point.y - (rect?.top ?? 0) };
    },
    [reactFlowInstance],
  );

  const onConnect = useCallback(
    (params: Connection | Edge) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      let raw = event.dataTransfer.getData('application/x-neuronblk-block');
      if (!raw) {
        raw = event.dataTransfer.getData('text/plain');
      }
      if (!raw) return;

      const def = JSON.parse(raw);
      const position = toFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      // Map block categories to flowchart shapes
      let type = 'rectangle';
      let isInput = false;

      if (def.category === 'start') {
        type = 'oval';
      } else if (def.category === 'input') {
        type = 'parallelogram';
        isInput = true;
      } else if (def.category === 'output') {
        type = 'parallelogram';
      } else if (def.category === 'conditions' || def.category === 'loops') {
        type = 'diamond';
      }

      // Seed field values from the block definition's defaults so inputs
      // are controlled from the moment the node is created.
      const values: Record<string, string> = {};
      (def.fields ?? []).forEach((f: { name: string; default?: string }) => {
        values[f.name] = f.default ?? '';
      });

      const newNode: Node = {
        id: crypto.randomUUID(),
        type,
        position,
        data: { label: def.label, isInput, defId: def.id, block: def, values },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [toFlowPosition, setNodes],
  );

  return (
    <div style={{ width: '100%', height: '100%' }} ref={reactFlowWrapper}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => onNodeClick?.(node)}
        onDrop={onDrop}
        onDragOver={onDragOver}
        nodeTypes={nodeTypes}
        fitView
        className="bg-surface"
      >
        <Controls />
        <MiniMap />
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
      </ReactFlow>
    </div>
  );
}

export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}