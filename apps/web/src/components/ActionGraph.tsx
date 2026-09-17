import dagre from "@dagrejs/dagre";
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
import { useState } from "react";
import type { ActionGraph as ActionGraphDto } from "@mars/contracts";
import { formatDuration } from "./RunTelemetry.tsx";

type ActionGraphNode = ActionGraphDto["nodes"][number];
type ActionMember = ActionGraphNode & { outcome: string };
type ActionNodeData = ActionMember & { onSelect?: (nodeId: string) => void; onHover?: (nodeId: string | null) => void };
type MatrixNodeData = { label: string; members: ActionMember[]; expanded: boolean; onSelect?: (nodeId: string) => void; onHover?: (nodeId: string | null) => void; onToggle?: () => void; selectedNodeId?: string | null };
type ActionFlowNode = Node<ActionNodeData, "action"> | Node<MatrixNodeData, "matrix">;

const NODE_WIDTH = 224;
const NODE_HEIGHT = 92;
const MATRIX_WIDTH = 252;
const MATRIX_HEADER_HEIGHT = 34;
const MATRIX_MEMBER_HEIGHT = 58;
const COLUMN_GAP = 64;
const ROW_GAP = 44;

function displayStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function ActionNode({ id, data }: NodeProps<Node<ActionNodeData, "action">>) {
  return <div className={`action-node action-node-${data.outcome}`} onMouseOver={() => data.onHover?.(id)} onMouseOut={(event) => { if (!(event.relatedTarget instanceof globalThis.Node) || !event.currentTarget.contains(event.relatedTarget)) data.onHover?.(null); }}>
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

function MatrixNode({ id, data }: NodeProps<Node<MatrixNodeData, "matrix">>) {
  return <div className="matrix-node" onMouseOver={() => data.onHover?.(id)} onMouseOut={(event) => { if (!(event.relatedTarget instanceof globalThis.Node) || !event.currentTarget.contains(event.relatedTarget)) data.onHover?.(null); }}>
    <Handle className="action-node-handle" type="target" position={Position.Left} />
    <button className="matrix-node-heading" type="button" aria-expanded={data.expanded} onClick={(event) => {
      event.stopPropagation();
      data.onToggle?.();
    }}>
      <strong>{data.label}</strong><span>{data.expanded ? "▾" : "▸"} Matrix · {data.members.length}</span>
    </button>
    {data.expanded ? <div className="matrix-node-members">
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
    </div> : null}
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

function matrixGroups(nodes: readonly ActionGraphNode[], edges: ActionGraphDto["edges"]): Map<string, { id: string; label: string; members: ActionGraphNode[] }> {
  const groups = new Map<string, { id: string; label: string; members: ActionGraphNode[] }>();
  const candidates = new Map<string, ActionGraphNode[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  const reachableByNode = new Map<string, Set<string>>();
  const reachableFrom = (from: string): Set<string> => {
    const cached = reachableByNode.get(from);
    if (cached) return cached;
    const reachable = new Set<string>();
    const pending = [...(outgoing.get(from) ?? [])];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      pending.push(...(outgoing.get(current) ?? []));
    }
    reachableByNode.set(from, reachable);
    return reachable;
  };
  for (const node of nodes) {
    const family = node.name.trim().split(/\s+/, 1)[0]?.toLowerCase();
    if (!family) continue;
    candidates.set(family, [...(candidates.get(family) ?? []), node]);
  }
  for (const members of candidates.values()) {
    const independentGroups: ActionGraphNode[][] = [];
    for (const member of members) {
      const group = independentGroups.find((items) => items.every((item) => !reachableFrom(item.id).has(member.id) && !reachableFrom(member.id).has(item.id)));
      if (group) group.push(member);
      else independentGroups.push([member]);
    }
    for (const independentMembers of independentGroups) {
      if (independentMembers.length < 2) continue;
      const label = commonMatrixLabel(independentMembers);
      if (!label) continue;
      const group = { id: `matrix:${independentMembers.map((node) => node.id).join("|")}`, label, members: independentMembers };
      for (const node of independentMembers) groups.set(node.id, group);
    }
  }
  return groups;
}

function deduplicateJobNodes(nodes: readonly ActionGraphNode[]): ActionGraphNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

export function layoutActionGraph(graph: ActionGraphDto, expandedGroupIds?: ReadonlySet<string>): { nodes: ActionFlowNode[]; edges: Edge[] } {
  const jobNodes = deduplicateJobNodes(graph.nodes);
  const nodeIds = new Set(jobNodes.map((node) => node.id));
  const graphEdges = graph.edges.length > 0
    ? graph.edges
    : jobNodes.slice(1).map((node, index) => ({ from: jobNodes[index]!.id, to: node.id }));
  const groups = matrixGroups(jobNodes, graph.edges);
  const memberToUnit = new Map(jobNodes.map((node) => [node.id, groups.get(node.id)?.id ?? node.id]));
  const unitMembers = new Map<string, ActionGraphNode[]>();
  for (const node of jobNodes) {
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
  const unitHeight = (id: string) => {
    const members = unitMembers.get(id) ?? [];
    if (members.length <= 1) return NODE_HEIGHT;
    return expandedGroupIds?.has(id) ? MATRIX_HEADER_HEIGHT + members.length * MATRIX_MEMBER_HEIGHT : MATRIX_HEADER_HEIGHT;
  };
  const unitWidth = (id: string) => (unitMembers.get(id)?.length ?? 0) > 1 ? MATRIX_WIDTH : NODE_WIDTH;
  const layoutGraph = new dagre.graphlib.Graph();
  layoutGraph.setGraph({
    rankdir: "LR",
    ranker: "network-simplex",
    acyclicer: "greedy",
    ranksep: COLUMN_GAP,
    nodesep: ROW_GAP,
    edgesep: 18,
    marginx: 0,
    marginy: 0,
  });
  layoutGraph.setDefaultEdgeLabel(() => ({}));
  for (const id of unitIds) {
    layoutGraph.setNode(id, { width: unitWidth(id), height: unitHeight(id) });
  }
  for (const edge of unitEdges.values()) {
    layoutGraph.setEdge(edge.from, edge.to);
  }
  dagre.layout(layoutGraph);

  const nodes: ActionFlowNode[] = [];
  for (const id of unitIds) {
    const members = unitMembers.get(id)!;
    const width = unitWidth(id);
    const height = unitHeight(id);
    const center = layoutGraph.node(id);
    const position = { x: center.x - width / 2, y: center.y - height / 2 };
    if (members.length > 1) {
      const group = groups.get(members[0]!.id)!;
      const expanded = expandedGroupIds?.has(id) ?? false;
      nodes.push({
        id,
        type: "matrix",
        position,
        width,
        height,
        data: { label: group.label, members: members.map((member) => ({ ...member, outcome: member.conclusion ?? member.status })), expanded },
        focusable: false,
        ariaLabel: `${group.label} matrix, ${members.length} jobs, ${expanded ? "expanded" : "collapsed"}`,
      });
    } else {
      const member = members[0]!;
      const outcome = member.conclusion ?? member.status;
      nodes.push({
        id,
        type: "action",
        position,
        width,
        height,
        data: { ...member, outcome },
        focusable: true,
        ariaLabel: `${member.name}, ${displayStatus(outcome)}, runtime ${formatDuration(member.durationMs)}`,
      });
    }
  }
  const edges = [...unitEdges.values()].map((edge): Edge => ({
    id: `${edge.from}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    type: "smoothstep",
    className: "action-flow-edge",
    style: { stroke: "var(--ui-primary)", strokeWidth: 2.25 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--ui-primary)", width: 18, height: 18 },
    zIndex: 1,
  }));
  return { nodes, edges };
}

export function ActionGraph({ graph, selectedNodeId, onNodeSelect }: { graph: ActionGraphDto; selectedNodeId: string | null; onNodeSelect: (nodeId: string) => void }) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set());
  const flow = layoutActionGraph(graph, expandedGroupIds);
  const nodes = flow.nodes.map((node): ActionFlowNode => node.type === "matrix"
    ? {
        ...node,
        selected: node.data.members.some((member) => member.id === selectedNodeId),
        data: {
          ...node.data,
          onSelect: onNodeSelect,
          onHover: setHoveredNodeId,
          onToggle: () => setExpandedGroupIds((current) => {
            const next = new Set(current);
            if (next.has(node.id)) next.delete(node.id);
            else next.add(node.id);
            return next;
          }),
          selectedNodeId,
        },
      }
    : {
        ...node,
        selected: node.id === selectedNodeId,
        data: { ...node.data, onSelect: onNodeSelect, onHover: setHoveredNodeId },
      });
  return <section className="graph-panel" aria-labelledby="graph-title">
    <div className="panel-kicker" id="graph-title">Action dependency graph</div>
    {nodes.length > 0
      ? <div className="action-graph-wrap" role="img" aria-label="Action dependency relationships">
          <ReactFlow
            nodes={nodes}
            edges={flow.edges.map((edge) => ({
              ...edge,
              className: `action-flow-edge${hoveredNodeId === null
                ? ""
                : edge.source === hoveredNodeId || edge.target === hoveredNodeId
                  ? " is-highlighted"
                  : " is-dimmed"}`,
            }))}
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
    <details className="graph-fallback"><summary>View dependency table</summary><table><caption className="sr-only">Action dependencies</caption><thead><tr><th>Action</th><th>Outcome</th><th>Runtime</th><th>Depends on</th></tr></thead><tbody>{graph.nodes.map((node) => <tr key={node.id}><th><button className="graph-fallback-action" type="button" onClick={() => onNodeSelect(node.id)}>{node.name}</button></th><td>{displayStatus(node.conclusion ?? node.status)}</td><td>{formatDuration(node.durationMs)}</td><td>{graph.edges.filter((edge) => edge.to === node.id).map((edge) => graph.nodes.find((candidate) => candidate.id === edge.from)?.name ?? edge.from).join(", ") || "—"}</td></tr>)}</tbody></table></details>
  </section>;
}
