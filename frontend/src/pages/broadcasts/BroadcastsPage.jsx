import { useEffect, useState } from "react";
import api from "@/services/api";
import toast from "react-hot-toast";
import {
  Plus,
  Send,
  Trash2,
  X,
  Users,
  Calendar,
  Megaphone,
} from "lucide-react";
import dayjs from "dayjs";

export default function BroadcastsPage() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    loadCampaigns();
  }, []);

  const loadCampaigns = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/broadcasts");
      setCampaigns(data.campaigns || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const sendCampaign = async (id) => {
    if (!window.confirm("Send this broadcast now?")) return;
    try {
      await api.post(`/broadcasts/${id}/send`);
      toast.success("Broadcast queued for sending!");
      loadCampaigns();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to send");
    }
  };

  const deleteCampaign = async (id) => {
    if (!window.confirm("Delete this campaign?")) return;
    try {
      await api.delete(`/broadcasts/${id}`);
      setCampaigns((c) => c.filter((x) => x._id !== id));
      toast.success("Campaign deleted");
    } catch (err) {
      toast.error("Failed to delete");
    }
  };

  const STATUS_BADGE = {
    draft: "badge-gray",
    scheduled: "badge-blue",
    sending: "badge-yellow",
    sent: "badge-green",
    cancelled: "badge-red",
    failed: "badge-red",
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Broadcasts</h1>
          <p className="text-sm text-gray-500">
            Send messages to multiple contacts at once
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="btn-primary gap-2"
        >
          <Plus className="w-4 h-4" />
          New Campaign
        </button>
      </div>

      {/* Campaigns list */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-16">
          <Megaphone className="w-10 h-10 text-gray-200 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No campaigns yet</p>
          <p className="text-gray-300 text-sm mt-1">
            Create your first broadcast to reach all your contacts
          </p>
          <button
            onClick={() => setShowModal(true)}
            className="btn-primary mt-4 gap-2"
          >
            <Plus className="w-4 h-4" />
            Create campaign
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map((c) => (
            <div key={c._id} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-gray-800 truncate">
                      {c.name}
                    </h3>
                    <span
                      className={`badge ${STATUS_BADGE[c.status] || "badge-gray"}`}
                    >
                      {c.status}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 line-clamp-2">
                    {c.message}
                  </p>
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                    <span className="flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {c.stats?.totalTargeted || 0} targets
                    </span>
                    {c.status === "sent" && (
                      <>
                        <span>✓ {c.stats?.sent || 0} sent</span>
                        <span>✗ {c.stats?.failed || 0} failed</span>
                      </>
                    )}
                    {c.scheduledAt && (
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {dayjs(c.scheduledAt).format("D MMM HH:mm")}
                      </span>
                    )}
                    <span>{dayjs(c.createdAt).format("D MMM YYYY")}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {c.status === "draft" && (
                    <button
                      onClick={() => sendCampaign(c._id)}
                      className="btn-primary text-xs gap-1"
                    >
                      <Send className="w-3 h-3" />
                      Send now
                    </button>
                  )}
                  {["draft", "scheduled"].includes(c.status) && (
                    <button
                      onClick={() => deleteCampaign(c._id)}
                      className="p-1.5 rounded text-gray-300 hover:text-red-500 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <CreateCampaignModal
          onClose={() => setShowModal(false)}
          onCreated={(c) => {
            setCampaigns((cs) => [c, ...cs]);
            setShowModal(false);
          }}
        />
      )}
    </div>
  );
}

function CreateCampaignModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    name: "",
    message: "",
    targetType: "all",
    tag: "",
    scheduledAt: "",
  });
  const [loading, setLoading] = useState(false);
  const [estimate, setEstimate] = useState(null);

  const fetchEstimate = async () => {
    try {
      const segment =
        form.targetType === "tag"
          ? { type: "tag", tags: [form.tag] }
          : { type: "all" };
      const { data } = await api.get(
        `/broadcasts/preview?targetSegment=${encodeURIComponent(JSON.stringify(segment))}`,
      );
      setEstimate(data.estimatedReach);
    } catch {
      setEstimate(null);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const targetSegment =
        form.targetType === "tag"
          ? { type: "tag", tags: [form.tag] }
          : { type: "all" };
      const payload = { name: form.name, message: form.message, targetSegment };
      if (form.scheduledAt) payload.scheduledAt = form.scheduledAt;
      const { data } = await api.post("/broadcasts", payload);
      onCreated(data.campaign);
      toast.success("Campaign created!");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to create");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-gray-900">New Broadcast Campaign</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:bg-gray-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label">Campaign name</label>
            <input
              className="input"
              required
              placeholder="Eid Special Offer"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Message</label>
            <textarea
              className="input resize-none"
              rows={4}
              required
              placeholder="Hello {{name}}! 🎉 Special Eid discount just for you…"
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Target audience</label>
            <select
              className="input"
              value={form.targetType}
              onChange={(e) => setForm({ ...form, targetType: e.target.value })}
            >
              <option value="all">All opted-in contacts</option>
              <option value="tag">Filter by tag</option>
            </select>
          </div>
          {form.targetType === "tag" && (
            <div>
              <label className="label">Tag</label>
              <input
                className="input"
                placeholder="VIP"
                value={form.tag}
                onChange={(e) => setForm({ ...form, tag: e.target.value })}
                onBlur={fetchEstimate}
              />
            </div>
          )}
          {form.targetType === "all" && (
            <div>
              <button
                type="button"
                className="text-xs text-brand-600 hover:underline"
                onClick={fetchEstimate}
              >
                Estimate reach
              </button>
            </div>
          )}
          {estimate !== null && (
            <p className="text-xs text-gray-500">
              Estimated reach: <strong>{estimate} contacts</strong>
            </p>
          )}
          <div>
            <label className="label">Schedule for later (optional)</label>
            <input
              className="input"
              type="datetime-local"
              value={form.scheduledAt}
              onChange={(e) =>
                setForm({ ...form, scheduledAt: e.target.value })
              }
            />
          </div>
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary flex-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary flex-1"
              disabled={loading}
            >
              {loading ? "Creating…" : "Create campaign"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
