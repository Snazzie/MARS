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
  type NodeTypes,
} from "@xyflow/react";
import type { ActionGraph as ActionGraphDto } from "@mars/contracts";
import { formatDuration } from "./RunTelemetry.tsx";

type ActionGraphNode = ActionGraphDto["nodes"][number];
type ActionMember = ActionGraphNode & { outcome: string };
type ActionNodeData = ActionMember & { onSelect?: (nodeId: string) => void };
type MatrixNodeData = { label: string; members: ActionMember[]; onSelect?: (nodeId: string) => void; selectedNodeId?: string | null };
type ActionFlowNode = Node<ActionNodeData, "action"> | Node<MatrixNodeData, "matrix">;

const NODE_WIDTH = 224;
const NODE_HEIGHT = 92;
const MATRIX_WIDTH = 252;
const MATRIX_HEADER_HEIGHT = 34;
const MATRIX_MEMBER_HEIGHT = 58;
const COLUMN_GAP = 48;
const ROW_GAP = 58;

function displayStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function ActionNode({ data }: NodeProps<Node<ActionNodeData, "action">>) {
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

function MatrixNode({ data }: NodeProps<Node<MatrixNodeData, "matrix">>) {
  return <div className="matrix-node">
    <Handle className="action-node-handle" type="target" position={Position.Left} />
    <div className="matrix-node-heading"><strong>{data.label}</strong><span>Matrix · {data.members.length}</span></div>
    <div className="matrix-node-members">
      {data.members.map((member) => <button
        aria-pressed={data.selectedNodeId === member.id}
        className={`matrix-member${data.selectedNodeId === member.id ? " is-selected" : ""}`}
        key={member.id}
        onClick={(event) => {
          event.stopPropagation();
          data.onSelect?.(member.id);
        }}
        type="button"
      >
        <span><strong>{member.name}</strong><small>{formatDuration(member.durationMs)}</small></span>
        <span className={`action-node-outcome action-node-outcome-${member.outcome}`}><span aria-hidden="true">●</span>{displayStatus(member.outcome)}</span>
      </button>)}
    </div>
    <Handle className="action-node-handle" type="source" position={Position.Right} />
  </div>;
}

const nodeTypes: NodeTypes = { action: ActionNode, matrix: MatrixNode };

function commonMatrixLabel(nodes: readonly ActionGraphNode[]): string | null {
  const words = nodes.map((node) => node.name.trim().split(/\s+/));
  const limit = Math.min(...words.map((parts) => parts.length));
  let shared = 0;
  while (shared < limit && words.every((parts) => parts[shared]!.toLowerCase() === words[0]![shared]!.toLowerCase())) shared += 1;
  if (shared === 0 || words.some((parts) => parts.length === shared)) return null;
  return words[0]!.slice(0, shared).join(" ").replace(/[\s([{/,:-]+$/, "") || null;
}

function matrixGroups(graph: ActionGraphDto): Map<string, { id: string; label: string; members: ActionGraphNode[] }> {
  const groups = new Map<string, { id: string; label: string; members: ActionGraphNode[] }>();
  if (graph.edges.length === 0) return groups;
  const incoming = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of graph.edges) {
    incoming.get(edge.to)?.push(edge.from);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const candidates = new Map<string, ActionGraphNode[]>();
  for (const node of graph.nodes) {
    const family = node.name.trim().split(/\s+/, 1)[0]?.toLowerCase();
    if (!family) continue;
    const key = `${family}|${(incoming.get(node.id) ?? []).sort().join(",")}|${(outgoing.get(node.id) ?? []).sort().join(",")}`;
    candidates.set(key, [...(candidates.get(key) ?? []), node]);
  }
  for (const nodes of candidates.values()) {
    if (nodes.length < 2) continue;
    const label = commonMatrixLabel(nodes);
    if (!label) continue;
    const group = { id: `matrix:${nodes.map((node) => node.id).join("|")}`, label, members: nodes };
    for (const node of nodes) groups.set(node.id, group);
  }
  return groups;
}

export function layoutActionGraph(graph: ActionGraphDto): { nodes: ActionFlowNode[]; edges: Edge[] } {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const graphEdges = graph.edges.length > 0
    ? graph.edges
    : graph.nodes.slice(1).map((node, index) => ({ from: graph.nodes[index]!.id, to: node.id }));
  const groups = matrixGroups(graph);
  const memberToUnit = new Map(graph.nodes.map((node) => [node.id, groups.get(node.id)?.id ?? node.id]));
  const unitMembers = new Map<string, ActionGraphNode[]>();
  for (const node of graph.nodes) {
    const unitId = memberToUnit.get(node.id)!;
    unitMembers.set(unitId, [...(unitMembers.get(unitId) ?? []), node]);
  }
  const unitIds = [...unitMembers.keys()];
  const unitEdges = new Map<string, { from: string; to: string }>();
  for (const edge of graphEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    const from = memberToUnit.get(edge.from)!;
    const to = memberToUnit.get(edge.to)!;
    if (from !== to) unitEdges.set(`${from}:${to}`, { from, to });
  }
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(unitIds.map((id) => [id, 0]));
  const depth = new Map(unitIds.map((id) => [id, 0]));
  for (const edge of unitEdges.values()) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = unitIds.filter((id) => indegree.get(id) === 0);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const source = queue[cursor]!;
    for (const target of outgoing.get(source) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(source) ?? 0) + 1));
      const nextIndegree = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) queue.push(target);
    }
  }
  const unitHeight = (id: string) => {
    const members = unitMembers.get(id) ?? [];
    return members.length > 1 ? MATRIX_HEADER_HEIGHT + members.length * MATRIX_MEMBER_HEIGHT : NODE_HEIGHT;
  };
  const layers = new Map<number, string[]>();
  for (const id of unitIds) {
    const layer = depth.get(id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), id]);
  }
  const layerHeight = (ids: string[]) => ids.reduce((sum, id) => sum + unitHeight(id), 0) + Math.max(0, ids.length - 1) * ROW_GAP;
  const tallestLayer = Math.max(NODE_HEIGHT, ...[...layers.values()].map(layerHeight));
  const nodes: ActionFlowNode[] = [];
  for (const [layer, ids] of layers) {
    let y = (tallestLayer - layerHeight(ids)) / 2;
    for (const id of ids) {
      const members = unitMembers.get(id)!;
      const height = unitHeight(id);
      if (members.length > 1) {
        const group = groups.get(members[0]!.id)!;
        nodes.push({
          id,
          type: "matrix",
          position: { x: layer * (MATRIX_WIDTH + COLUMN_GAP), y },
          width: MATRIX_WIDTH,
          height,
          data: { label: group.label, members: members.map((member) => ({ ...member, outcome: member.conclusion ?? member.status })) },
          focusable: false,
          ariaLabel: `${group.label} matrix, ${members.length} jobs`,
        });
      } else {
        const member = members[0]!;
        const outcome = member.conclusion ?? member.status;
        nodes.push({
          id,
          type: "action",
          position: { x: layer * (MATRIX_WIDTH + COLUMN_GAP), y },
          width: NODE_WIDTH,
          height,
          data: { ...member, outcome },
          focusable: true,
          ariaLabel: `${member.name}, ${displayStatus(outcome)}, runtime ${formatDuration(member.durationMs)}`,
        });
      }
      y += height + ROW_GAP;
    }
  }
  const edges = [...unitEdges.values()].map((edge): Edge => ({
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
  const nodes = flow.nodes.map((node): ActionFlowNode => node.type === "matrix"
    ? {
        ...node,
        selected: node.data.members.some((member) => member.id === selectedNodeId),
        data: { ...node.data, onSelect: onNodeSelect, selectedNodeId },
      }
    : {
        ...node,
        selected: node.id === selectedNodeId,
        data: { ...node.data, onSelect: onNodeSelect },
      });
  return <section className="graph-panel" aria-labelledby="graph-title">
    <div className="panel-kicker" id="graph-title">Action dependency graph</div>
    {nodes.length > 0
      ? <div className="action-graph-wrap" role="img" aria-label="Action dependency relationships">
          <ReactFlow
            nodes={nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => {
              if (node.type === "action") onNodeSelect(node.id);
            }}
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
