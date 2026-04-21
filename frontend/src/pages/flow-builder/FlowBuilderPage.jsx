import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Panel,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import api from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import toast from "react-hot-toast";
import { Plus, Save, ArrowLeft, Trash2, Play, Pause } from "lucide-react";
import NodePalette from "./components/NodePalette";
import NodeConfigPanel from "./components/NodeConfigPanel";
import FlowListSidebar from "./components/FlowListSidebar";
import { NODE_TYPES_MAP } from "./nodeTypes";

let nodeIdCounter = 1;
const getId = () => `node_${Date.now()}_${nodeIdCounter++}`;

export default function FlowBuilderPage() {
  const { flowId } = useParams();
  const { activeWorkspace } = useAuthStore();
  const navigate = useNavigate();

  const [flows, setFlows] = useState([]);
  const [currentFlow, setCurrentFlow] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const reactFlowWrapper = useRef(null);

  useEffect(() => {
    loadFlows();
  }, [activeWorkspace]);
  useEffect(() => {
    if (flowId) loadFlow(flowId);
    else setCurrentFlow(null);
  }, [flowId]);

  const loadFlows = async () => {
    try {
      const { data } = await api.get("/flows");
      setFlows(data.flows || []);
    } catch (err) {
      console.error(err);
    }
  };

  const loadFlow = async (id) => {
    try {
      const { data } = await api.get(`/flows/${id}`);
      const flow = data.flow;
      setCurrentFlow(flow);
      setNodes(
        flow.nodes.map((n) => ({
          id: n.id,
          type: n.nodeType,
          position: n.position || { x: 100, y: 100 },
          data: { ...n.data, nodeType: n.nodeType },
        })),
      );
      setEdges(flow.edges || []);
    } catch (err) {
      toast.error("Failed to load flow");
    }
  };

  const onConnect = useCallback((params) => {
    setEdges((eds) =>
      addEdge({ ...params, animated: true, style: { stroke: "#16a34a" } }, eds),
    );
  }, []);

  const onNodeClick = useCallback((_, node) => setSelectedNode(node), []);
  const onPaneClick = useCallback(() => setSelectedNode(null), []);

  const onDrop = useCallback((event) => {
    event.preventDefault();
    const nodeType = event.dataTransfer.getData("nodeType");
    if (!nodeType) return;
    const bounds = reactFlowWrapper.current.getBoundingClientRect();
    const position = {
      x: event.clientX - bounds.left - 75,
      y: event.clientY - bounds.top - 30,
    };
    const newNode = {
      id: getId(),
      type: nodeType,
      position,
      data: {
        label: NODE_TYPES_MAP[nodeType]?.label || nodeType,
        nodeType,
        content: "",
      },
    };
    setNodes((ns) => [...ns, newNode]);
  }, []);

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const updateNodeData = (nodeId, updates) => {
    setNodes((ns) =>
      ns.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...updates } } : n,
      ),
    );
    if (selectedNode?.id === nodeId)
      setSelectedNode((s) => ({ ...s, data: { ...s.data, ...updates } }));
  };

  const deleteNode = (nodeId) => {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    setEdges((es) =>
      es.filter((e) => e.source !== nodeId && e.target !== nodeId),
    );
    setSelectedNode(null);
  };

  const createNewFlow = async () => {
    try {
      const { data } = await api.post("/flows", {
        name: "New Flow",
        trigger: { type: "keyword", keywords: [] },
        nodes: [],
        edges: [],
      });
      setFlows((f) => [data.flow, ...f]);
      navigate(`/dashboard/flows/${data.flow._id}`);
    } catch (err) {
      toast.error("Failed to create flow");
    }
  };

  const saveFlow = async () => {
    if (!currentFlow) return;
    setSaving(true);
    try {
      const payload = {
        nodes: nodes.map((n) => ({
          id: n.id,
          nodeType: n.type,
          position: n.position,
          data: n.data,
        })),
        edges,
      };
      await api.put(`/flows/${currentFlow._id}`, payload);
      toast.success("Flow saved!");
    } catch (err) {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async () => {
    if (!currentFlow) return;
    try {
      const newStatus = currentFlow.status === "active" ? "draft" : "active";
      await api.put(`/flows/${currentFlow._id}`, { status: newStatus });
      setCurrentFlow((f) => ({ ...f, status: newStatus }));
      toast.success(
        `Flow ${newStatus === "active" ? "activated" : "deactivated"}`,
      );
    } catch (err) {
      toast.error("Failed to toggle flow");
    }
  };

  return (
    <div className="flex h-full">
      {/* Flow list sidebar */}
      <FlowListSidebar
        flows={flows}
        currentFlowId={currentFlow?._id}
        onSelect={(id) => navigate(`/dashboard/flows/${id}`)}
        onNew={createNewFlow}
      />

      {/* Canvas */}
      <div className="flex-1 flex flex-col relative" ref={reactFlowWrapper}>
        {currentFlow ? (
          <>
            {/* Top bar */}
            <div className="h-12 bg-white border-b border-gray-100 flex items-center justify-between px-4">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => navigate("/dashboard/flows")}
                  className="btn-ghost p-1.5"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <h2 className="font-semibold text-gray-800 text-sm">
                  {currentFlow.name}
                </h2>
                <span
                  className={`badge ${currentFlow.status === "active" ? "badge-green" : "badge-gray"}`}
                >
                  {currentFlow.status}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowPalette(!showPalette)}
                  className="btn-secondary text-xs gap-1"
                >
                  <Plus className="w-3 h-3" />
                  Add Node
                </button>
                <button
                  onClick={toggleActive}
                  className={`btn text-xs gap-1 ${currentFlow.status === "active" ? "bg-yellow-50 text-yellow-700 border border-yellow-200 hover:bg-yellow-100" : "btn-secondary"}`}
                >
                  {currentFlow.status === "active" ? (
                    <>
                      <Pause className="w-3 h-3" /> Deactivate
                    </>
                  ) : (
                    <>
                      <Play className="w-3 h-3" /> Activate
                    </>
                  )}
                </button>
                <button
                  onClick={saveFlow}
                  className="btn-primary text-xs gap-1"
                  disabled={saving}
                >
                  <Save className="w-3 h-3" />
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>

            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              onDrop={onDrop}
              onDragOver={onDragOver}
              nodeTypes={NODE_TYPES_MAP}
              fitView
              className="bg-gray-50"
            >
              <Background color="#e5e7eb" gap={20} />
              <Controls />
              <MiniMap />
              {showPalette && (
                <Panel position="top-left">
                  <NodePalette onClose={() => setShowPalette(false)} />
                </Panel>
              )}
            </ReactFlow>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="text-5xl mb-4">🤖</div>
            <h2 className="text-xl font-semibold text-gray-700 mb-2">
              Select or create a flow
            </h2>
            <p className="text-gray-400 text-sm mb-6">
              Build automated Instagram DM conversations with a visual
              drag-and-drop editor.
            </p>
            <button onClick={createNewFlow} className="btn-primary gap-2">
              <Plus className="w-4 h-4" />
              Create new flow
            </button>
          </div>
        )}
      </div>

      {/* Config panel */}
      {selectedNode && (
        <NodeConfigPanel
          node={selectedNode}
          onChange={(updates) => updateNodeData(selectedNode.id, updates)}
          onDelete={() => deleteNode(selectedNode.id)}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}
