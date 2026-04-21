import { X, Trash2 } from "lucide-react";

const FIELDS = {
  send_text: [
    {
      key: "content",
      label: "Message text",
      type: "textarea",
      placeholder: "Hello {{name}}! How can I help?",
    },
  ],
  send_image: [
    {
      key: "url",
      label: "Image URL",
      type: "text",
      placeholder: "https://...",
    },
    {
      key: "caption",
      label: "Caption (optional)",
      type: "text",
      placeholder: "Check this out!",
    },
  ],
  send_file: [
    { key: "url", label: "File URL", type: "text", placeholder: "https://..." },
    {
      key: "filename",
      label: "File name",
      type: "text",
      placeholder: "document.pdf",
    },
  ],
  ask_question: [
    {
      key: "content",
      label: "Question text",
      type: "textarea",
      placeholder: "What is your name?",
    },
    {
      key: "variableName",
      label: "Save answer as variable",
      type: "text",
      placeholder: "customerName",
    },
  ],
  button_menu: [
    {
      key: "content",
      label: "Message body",
      type: "textarea",
      placeholder: "Choose an option:",
    },
    {
      key: "buttonsJson",
      label: "Buttons (one per line, max 3)",
      type: "textarea",
      placeholder: "Book Table\nView Menu\nContact Us",
    },
  ],
  list_menu: [
    {
      key: "header",
      label: "Header",
      type: "text",
      placeholder: "Our Services",
    },
    {
      key: "content",
      label: "Body",
      type: "textarea",
      placeholder: "Choose a service from the list below.",
    },
    {
      key: "buttonText",
      label: "Button text",
      type: "text",
      placeholder: "View options",
    },
    {
      key: "itemsJson",
      label: "List items (one per line)",
      type: "textarea",
      placeholder: "Haircut\nColoring\nSpa Treatment",
    },
  ],
  delay: [
    {
      key: "delaySeconds",
      label: "Delay (seconds)",
      type: "number",
      placeholder: "3",
    },
  ],
  tag_contact: [
    {
      key: "tag",
      label: "Tag name",
      type: "text",
      placeholder: "VIP Customer",
    },
  ],
  assign_agent: [
    {
      key: "agentNote",
      label: "Note to agent (optional)",
      type: "text",
      placeholder: "Customer needs urgent help",
    },
  ],
  condition: [
    {
      key: "variable",
      label: "Variable to check",
      type: "text",
      placeholder: "customerBudget",
    },
    {
      key: "operator",
      label: "Operator",
      type: "select",
      options: [
        "equals",
        "contains",
        "greater_than",
        "less_than",
        "not_equals",
      ],
    },
    {
      key: "value",
      label: "Compare value",
      type: "text",
      placeholder: "100000",
    },
  ],
  keyword_trigger: [
    {
      key: "keywordsText",
      label: "Keywords (one per line)",
      type: "textarea",
      placeholder: "hi\nhello\nstart",
    },
  ],
};

export default function NodeConfigPanel({ node, onChange, onDelete, onClose }) {
  const fields = FIELDS[node.type] || [];
  const data = node.data || {};

  const handleChange = (key, value) => onChange({ [key]: value });

  return (
    <div className="w-72 bg-white border-l border-gray-100 flex flex-col flex-shrink-0">
      <div className="h-12 flex items-center justify-between px-4 border-b border-gray-100">
        <span className="font-semibold text-sm text-gray-800 capitalize">
          {node.type?.replace(/_/g, " ")}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={onDelete}
            className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:bg-gray-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Node label */}
        <div>
          <label className="label">Node label</label>
          <input
            className="input"
            value={data.label || ""}
            onChange={(e) => handleChange("label", e.target.value)}
            placeholder="Node label"
          />
        </div>
        {fields.map(({ key, label, type, placeholder, options }) => (
          <div key={key}>
            <label className="label">{label}</label>
            {type === "textarea" ? (
              <textarea
                className="input resize-none"
                rows={3}
                value={data[key] || ""}
                onChange={(e) => handleChange(key, e.target.value)}
                placeholder={placeholder}
              />
            ) : type === "select" ? (
              <select
                className="input"
                value={data[key] || ""}
                onChange={(e) => handleChange(key, e.target.value)}
              >
                <option value="">Select…</option>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                type={type}
                value={data[key] || ""}
                onChange={(e) => handleChange(key, e.target.value)}
                placeholder={placeholder}
              />
            )}
          </div>
        ))}
        {fields.length === 0 && (
          <p className="text-sm text-gray-400">No configuration needed.</p>
        )}
      </div>
    </div>
  );
}
