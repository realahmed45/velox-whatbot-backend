import { Handle, Position } from "@xyflow/react";
import {
  MessageSquare,
  HelpCircle,
  MousePointer,
  Clock,
  Tag,
  User,
  GitBranch,
  X,
  AlignLeft,
  Image,
  FileText,
  List,
} from "lucide-react";

const baseStyle =
  "min-w-[160px] max-w-[220px] rounded-xl border-2 bg-white shadow-sm text-xs font-medium";
const NodeWrapper = ({ children, color, selected }) => (
  <div
    className={`${baseStyle} ${selected ? `border-${color}-500` : `border-${color}-200`} p-3`}
  >
    {children}
  </div>
);

const mkNode = (icon, label, color) => {
  const Comp = ({ data, selected }) => (
    <NodeWrapper color={color} selected={selected}>
      <Handle type="target" position={Position.Top} className="!bg-gray-300" />
      <div className={`flex items-center gap-2 text-${color}-700 mb-1`}>
        {icon}
        <span className="font-semibold text-xs">{label}</span>
      </div>
      <p className="text-gray-500 truncate text-xs">
        {data.content || data.text || data.label || "(empty)"}
      </p>
      <Handle
        type="source"
        position={Position.Bottom}
        className={`!bg-${color}-400`}
      />
    </NodeWrapper>
  );
  return Comp;
};

export const SendTextNode = mkNode(
  <AlignLeft className="w-3 h-3" />,
  "Send Text",
  "blue",
);
export const SendImageNode = mkNode(
  <Image className="w-3 h-3" />,
  "Send Image",
  "purple",
);
export const SendFileNode = mkNode(
  <FileText className="w-3 h-3" />,
  "Send File",
  "indigo",
);
export const AskQuestionNode = mkNode(
  <HelpCircle className="w-3 h-3" />,
  "Ask Question",
  "yellow",
);
export const ButtonMenuNode = mkNode(
  <MousePointer className="w-3 h-3" />,
  "Button Menu",
  "orange",
);
export const ListMenuNode = mkNode(
  <List className="w-3 h-3" />,
  "List Menu",
  "pink",
);
export const DelayNode = mkNode(<Clock className="w-3 h-3" />, "Delay", "gray");
export const TagContactNode = mkNode(
  <Tag className="w-3 h-3" />,
  "Tag Contact",
  "green",
);
export const AssignAgentNode = mkNode(
  <User className="w-3 h-3" />,
  "Assign Agent",
  "teal",
);
export const ConditionNode = mkNode(
  <GitBranch className="w-3 h-3" />,
  "Condition",
  "red",
);
export const EndFlowNode = ({ data, selected }) => (
  <div
    className={`${baseStyle} ${selected ? "border-gray-500" : "border-gray-300"} p-3 bg-gray-50`}
  >
    <Handle type="target" position={Position.Top} className="!bg-gray-300" />
    <div className="flex items-center gap-2 text-gray-500">
      <X className="w-3 h-3" />
      <span className="font-semibold text-xs">End Flow</span>
    </div>
  </div>
);

// Keyword trigger node (starting node)
export const KeywordTriggerNode = ({ data, selected }) => (
  <div
    className={`${baseStyle} ${selected ? "border-brand-600" : "border-brand-400"} p-3 bg-brand-50`}
  >
    <Handle
      type="source"
      position={Position.Bottom}
      className="!bg-brand-500"
    />
    <div className="flex items-center gap-2 text-brand-700 mb-1">
      <MessageSquare className="w-3 h-3" />
      <span className="font-semibold text-xs">Keyword Trigger</span>
    </div>
    <p className="text-brand-600 text-xs truncate">
      {data.keywords?.join(", ") || "(no keywords)"}
    </p>
  </div>
);

export const NODE_TYPES_MAP = {
  send_text: SendTextNode,
  send_image: SendImageNode,
  send_file: SendFileNode,
  ask_question: AskQuestionNode,
  button_menu: ButtonMenuNode,
  list_menu: ListMenuNode,
  delay: DelayNode,
  tag_contact: TagContactNode,
  assign_agent: AssignAgentNode,
  condition: ConditionNode,
  end_flow: EndFlowNode,
  keyword_trigger: KeywordTriggerNode,
  any_message_trigger: KeywordTriggerNode,
};

// Metadata for palette
NODE_TYPES_MAP.send_text.label = "Send Text";
NODE_TYPES_MAP.send_image.label = "Send Image";
NODE_TYPES_MAP.ask_question.label = "Ask Question";
NODE_TYPES_MAP.button_menu.label = "Button Menu";
NODE_TYPES_MAP.list_menu.label = "List Menu";
NODE_TYPES_MAP.delay.label = "Delay";
NODE_TYPES_MAP.tag_contact.label = "Tag Contact";
NODE_TYPES_MAP.assign_agent.label = "Assign Agent";
NODE_TYPES_MAP.condition.label = "Condition";
NODE_TYPES_MAP.end_flow.label = "End Flow";
NODE_TYPES_MAP.keyword_trigger.label = "Keyword Trigger";
