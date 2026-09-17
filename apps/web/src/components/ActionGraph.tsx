import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { ActionGraph as ActionGraphDto } from "@mars/contracts";
import { formatDuration } from "./RunTelemetry.tsx";

type ActionGraphNode = ActionGraphDto["nodes"][number];
type ActionNodeData = ActionGraphNode & { outcome: string };
type ActionFlowNode = Node<ActionNodeData, "action">;

const NODE_WIDTH = 224;
const NODE_HEIGHT = 92;
const COLUMN_GAP = 48;
const ROW_GAP = 58;

function displayStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function ActionNode({ data }: NodeProps<ActionFlowNode>) {
  return <div className={`action-node action-node-${data.outcome}`}>
    <Handle className="action-node-handle" type="target" position={Position.Left} />
    <div className="action-node-heading">
      <strong title={data.name}>{data.name}</strong>
      <span className={`action-node-outcome action-node-outcome-${data.outcome}`}>
        <span aria-hidden="true">●</span>
        {displayStatus(data.outcome)}
      </span>
    </div>
    <dl className="action-node-facts">
      <div><dt>Runtime</dt><dd>{formatDuration(data.durationMs)}</dd></div>
      <div><dt>Stage</dt><dd>{displayStatus(data.status)}</dd></div>
    </dl>
    <Handle className="action-node-handle" type="source" position={Position.Right} />
  </div>;
}

const nodeTypes = { action: ActionNode };

export function layoutActionGraph(graph: ActionGraphDto): { nodes: ActionFlowNode[]; edges: Edge[] } {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const graphEdges = graph.edges.length > 0
    ? graph.edges
    : graph.nodes.slice(1).map((node, index) => ({ from: graph.nodes[index]!.id, to: node.id }));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const depth = new Map(graph.nodes.map((node) => [node.id, 0]));

  for (const edge of graphEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const source = queue[cursor]!;
    for (const target of outgoing.get(source) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(source) ?? 0) + 1));
      const nextIndegree = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) queue.push(target);
    }
  }

  const layers = new Map<number, ActionGraphNode[]>();
  for (const node of graph.nodes) {
    const layer = depth.get(node.id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), node]);
  }
  const widestLayer = Math.max(1, ...[...layers.values()].map((layer) => layer.length));

  const nodes = graph.nodes.map((node): ActionFlowNode => {
    const layer = depth.get(node.id) ?? 0;
    const layerNodes = layers.get(layer) ?? [];
    const index = layerNodes.findIndex((candidate) => candidate.id === node.id);
    const layerOffset = (widestLayer - layerNodes.length) * (NODE_HEIGHT + ROW_GAP) / 2;
    const outcome = node.conclusion ?? node.status;
    return {
      id: node.id,
      type: "action",
      position: {
        x: layer * (NODE_WIDTH + COLUMN_GAP),
        y: layerOffset + index * (NODE_HEIGHT + ROW_GAP),
      },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: { ...node, outcome },
      selected: false,
      focusable: true,
      ariaLabel: `${node.name}, ${displayStatus(outcome)}, runtime ${formatDuration(node.durationMs)}`,
    };
  });

  const edges = graphEdges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge): Edge => ({
      id: `${edge.from}-${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      className: "action-flow-edge",
      style: { stroke: "var(--mars)", strokeWidth: 2.25 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--mars)", width: 18, height: 18 },
      zIndex: 1,
    }));
  return { nodes, edges };
}

export function ActionGraph({ graph, selectedNodeId, onNodeSelect }: { graph: ActionGraphDto; selectedNodeId: string | null; onNodeSelect: (nodeId: string) => void }) {
  const flow = layoutActionGraph(graph);
  const nodes = flow.nodes.map((node) => ({ ...node, selected: node.id === selectedNodeId }));
  return <section className="graph-panel" aria-labelledby="graph-title">
    <div className="panel-kicker" id="graph-title">Action dependency graph</div>
    {nodes.length > 0
      ? <div className="action-graph-wrap" role="img" aria-label="Action dependency relationships">
          <ReactFlow
            nodes={nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => onNodeSelect(node.id)}
            nodesConnectable={false}
            nodesDraggable={false}
            elementsSelectable
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.4}
            maxZoom={1.5}
          >
            <Background gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      : <p className="graph-empty">No jobs have been discovered for this run.</p>}
    <details className="graph-fallback"><summary>View dependency table</summary><table><caption className="sr-only">Action dependencies</caption><thead><tr><th>Action</th><th>Outcome</th><th>Runtime</th><th>Depends on</th></tr></thead><tbody>{graph.nodes.map((node) => <tr key={node.id}><th><button type="button" onClick={() => onNodeSelect(node.id)}>{node.name}</button></th><td>{displayStatus(node.conclusion ?? node.status)}</td><td>{formatDuration(node.durationMs)}</td><td>{graph.edges.filter((edge) => edge.to === node.id).map((edge) => graph.nodes.find((candidate) => candidate.id === edge.from)?.name ?? edge.from).join(", ") || "—"}</td></tr>)}</tbody></table></details>
  </section>;
}
