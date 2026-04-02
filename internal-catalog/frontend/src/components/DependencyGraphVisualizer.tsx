import { useMemo } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  Handle,
  Position,
  MarkerType,
  BackgroundVariant,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ProvisionPlan, PlannedNodePreview } from "../lib/types";

interface DependencyGraphVisualizerProps {
  plan: ProvisionPlan;
}

function getNodeActionClass(action: string) {
  switch (action) {
    case "provision":
      return "status-badge status-success";
    case "reuse":
      return "status-badge status-primary";
    case "attach":
      return "status-badge status-pending";
    case "blocked":
      return "status-badge status-error";
    default:
      return "status-badge status-secondary";
  }
}

function GraphNodeCard({ data }: { data: PlannedNodePreview }) {
  const { spec_id, environment, runtime, action, blocked_reason, layer_index } = data;
  return (
    <div className="graph-node-card" style={{ minWidth: 220, position: 'relative' }}>
      {layer_index > 0 && <Handle type="target" position={Position.Left} style={{ width: 8, height: 8, background: 'var(--text-tertiary)', border: '2px solid var(--surface)' }} />}
      <div className="graph-node-header">
        <span className="graph-node-spec mono">{spec_id}</span>
        <span className={getNodeActionClass(action)}>{action}</span>
      </div>
      <div className="graph-node-details">
        <span className="graph-node-env">Env: {environment}</span>
        <span className="graph-node-runtime">Runtime: {runtime}</span>
      </div>
      {action === "blocked" && blocked_reason && (
        <div className="graph-node-error">
          {blocked_reason}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ width: 8, height: 8, background: 'var(--text-tertiary)', border: '2px solid var(--surface)' }} />
    </div>
  );
}

const nodeTypes = {
  graphNodeCard: GraphNodeCard,
};

export function DependencyGraphVisualizer({ plan }: DependencyGraphVisualizerProps) {
  const { nodes, edges } = useMemo(() => {
    if (!plan.layers) return { nodes: [], edges: [] };

    const rfNodes: Node[] = [];
    const rfEdges: Edge[] = [];

    const horizontalSpacing = 340;
    const verticalSpacing = 160;

    const maxNodesInLayer = Math.max(...plan.layers.map(l => l.spec_ids.length));
    const maxHeight = maxNodesInLayer * verticalSpacing;

    plan.layers.forEach((layer) => {
      const layerNodes = layer.spec_ids
        .map(id => plan.nodes.find(n => n.spec_id === id && n.layer_index === layer.layer_index))
        .filter((n): n is PlannedNodePreview => !!n);
      
      const layerHeight = layerNodes.length * verticalSpacing;
      const startY = (maxHeight - layerHeight) / 2;

      layerNodes.forEach((node, idx) => {
        rfNodes.push({
          id: node.key,
          type: 'graphNodeCard',
          position: {
            x: layer.layer_index * horizontalSpacing,
            y: startY + idx * verticalSpacing,
          },
          data: (node as unknown) as Record<string, unknown>,
        });

        // Add hard dependencies (solid lines)
        node.hard_dependencies.forEach(depSpecId => {
          const targetNode = plan.nodes.find(n => n.spec_id === depSpecId && n.environment === node.environment);
          if (targetNode) {
            rfEdges.push({
              id: `edge-${node.key}-${targetNode.key}`,
              source: targetNode.key, // Data flows from dependency
              target: node.key,       // To dependent
              animated: true,
              style: { stroke: 'var(--accent)', strokeWidth: 2 },
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: 'var(--accent)',
              },
            });
          }
        });
        
        // Add soft neighbors (dashed lines)
        node.soft_neighbors.forEach(depSpecId => {
          const targetNode = plan.nodes.find(n => n.spec_id === depSpecId && n.environment === node.environment);
          if (targetNode) {
            rfEdges.push({
              id: `edge-soft-${node.key}-${targetNode.key}`,
              source: targetNode.key,
              target: node.key,
              animated: false,
              style: { stroke: 'var(--muted)', strokeWidth: 1.5, strokeDasharray: '5,5' },
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: 'var(--muted)',
              },
            });
          }
        });
      });
    });

    return { nodes: rfNodes, edges: rfEdges };
  }, [plan]);

  if (!plan.layers || plan.layers.length === 0) {
    return <div className="graph-visualizer-empty">No dependencies to display.</div>;
  }

  return (
    <div style={{ width: '100%', height: '500px', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden', background: 'var(--surface-subtle)', marginTop: 16 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--border)" />
        <Controls />
      </ReactFlow>
    </div>
  );
}
