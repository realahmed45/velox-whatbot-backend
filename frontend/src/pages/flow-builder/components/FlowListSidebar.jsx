import { Plus, GitBranch } from "lucide-react";
import { clsx } from "clsx";

export default function FlowListSidebar({
  flows,
  currentFlowId,
  onSelect,
  onNew,
}) {
  return (
    <div className="w-56 flex-shrink-0 bg-white border-r border-gray-100 flex flex-col">
      <div className="h-12 flex items-center justify-between px-3 border-b border-gray-100">
        <span className="font-semibold text-sm text-gray-700">Flows</span>
        <button
          onClick={onNew}
          className="p-1.5 rounded-lg bg-brand-50 text-brand-600 hover:bg-brand-100 transition"
          title="New flow"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {flows.length === 0 && (
          <p className="text-xs text-gray-400 text-center py-6">No flows yet</p>
        )}
        {flows.map((flow) => (
          <button
            key={flow._id}
            onClick={() => onSelect(flow._id)}
            className={clsx(
              "w-full text-left flex items-start gap-2 px-2 py-2 rounded-lg transition text-sm",
              currentFlowId === flow._id
                ? "bg-brand-50 text-brand-700"
                : "text-gray-600 hover:bg-gray-50",
            )}
          >
            <GitBranch className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="font-medium truncate text-xs">{flow.name}</p>
              <p
                className={clsx(
                  "text-xs mt-0.5",
                  flow.status === "active" ? "text-green-600" : "text-gray-400",
                )}
              >
                {flow.status}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
