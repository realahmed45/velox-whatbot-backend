import {
  AlignLeft,
  HelpCircle,
  MousePointer,
  Clock,
  Tag,
  User,
  GitBranch,
  X,
  Image,
  FileText,
  List,
  Hash,
} from "lucide-react";

const PALETTE_NODES = [
  {
    type: "send_text",
    label: "Send Text",
    icon: AlignLeft,
    color: "text-blue-600",
    bg: "bg-blue-50",
  },
  {
    type: "send_image",
    label: "Send Image",
    icon: Image,
    color: "text-purple-600",
    bg: "bg-purple-50",
  },
  {
    type: "send_file",
    label: "Send File",
    icon: FileText,
    color: "text-indigo-600",
    bg: "bg-indigo-50",
  },
  {
    type: "ask_question",
    label: "Ask Question",
    icon: HelpCircle,
    color: "text-yellow-600",
    bg: "bg-yellow-50",
  },
  {
    type: "button_menu",
    label: "Button Menu",
    icon: MousePointer,
    color: "text-orange-600",
    bg: "bg-orange-50",
  },
  {
    type: "list_menu",
    label: "List Menu",
    icon: List,
    color: "text-pink-600",
    bg: "bg-pink-50",
  },
  {
    type: "delay",
    label: "Delay",
    icon: Clock,
    color: "text-gray-600",
    bg: "bg-gray-50",
  },
  {
    type: "tag_contact",
    label: "Tag Contact",
    icon: Tag,
    color: "text-green-600",
    bg: "bg-green-50",
  },
  {
    type: "assign_agent",
    label: "Assign Agent",
    icon: User,
    color: "text-teal-600",
    bg: "bg-teal-50",
  },
  {
    type: "condition",
    label: "Condition",
    icon: GitBranch,
    color: "text-red-600",
    bg: "bg-red-50",
  },
  {
    type: "end_flow",
    label: "End Flow",
    icon: X,
    color: "text-gray-500",
    bg: "bg-gray-50",
  },
];

export default function NodePalette({ onClose }) {
  const onDragStart = (event, nodeType) => {
    event.dataTransfer.setData("nodeType", nodeType);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-lg p-3 w-48">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Nodes
        </span>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-gray-100 text-gray-400"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      <div className="space-y-1">
        {PALETTE_NODES.map(({ type, label, icon: Icon, color, bg }) => (
          <div
            key={type}
            draggable
            onDragStart={(e) => onDragStart(e, type)}
            className="flex items-center gap-2 p-2 rounded-lg cursor-grab hover:bg-gray-50 transition border border-transparent hover:border-gray-200"
          >
            <div
              className={`w-6 h-6 rounded-md flex items-center justify-center ${bg} flex-shrink-0`}
            >
              <Icon className={`w-3 h-3 ${color}`} />
            </div>
            <span className="text-xs font-medium text-gray-700">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
