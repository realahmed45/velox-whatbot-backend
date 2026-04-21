import { useState, useEffect } from "react";
import api from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import toast from "react-hot-toast";
import { Loader2, MessageCircle, Clock, Zap, Save } from "lucide-react";

export default function AutomationSetupPage() {
  const { activeWorkspace } = useAuthStore();
  const [messages, setMessages] = useState({
    greeting: "",
    followUp1: "",
    followUp2: "",
    followUp3: "",
    followUpIntervalHours: 3,
  });
  const [timing, setTiming] = useState({
    minDelayMinutes: 3,
    maxDelayMinutes: 15,
    automationEnabled: true,
  });
  const [loading, setLoading] = useState(true);
  const [savingMsgs, setSavingMsgs] = useState(false);
  const [savingTiming, setSavingTiming] = useState(false);

  useEffect(() => {
    if (!activeWorkspace) return;
    api.get(`/workspaces/${activeWorkspace}`)
      .then(({ data }) => {
        const ws = data.workspace;
        if (ws.dmMessages) {
          setMessages({
            greeting: ws.dmMessages.greeting || "",
            followUp1: ws.dmMessages.followUp1 || "",
            followUp2: ws.dmMessages.followUp2 || "",
            followUp3: ws.dmMessages.followUp3 || "",
            followUpIntervalHours: ws.dmMessages.followUpIntervalHours ?? 3,
          });
        }
        if (ws.settings) {
          setTiming({
            minDelayMinutes: ws.settings.minDelayMinutes ?? 3,
            maxDelayMinutes: ws.settings.maxDelayMinutes ?? 15,
            automationEnabled: ws.settings.automationEnabled ?? true,
          });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [activeWorkspace]);

  const saveMessages = async () => {
    setSavingMsgs(true);
    try {
      await api.put(`/workspaces/${activeWorkspace}/dm-messages`, messages);
      toast.success("Messages saved!");
    } catch {
      toast.error("Failed to save messages");
    } finally {
      setSavingMsgs(false);
    }
  };

  const saveTiming = async () => {
    if (timing.minDelayMinutes < 1 || timing.maxDelayMinutes < timing.minDelayMinutes) {
      toast.error("Max delay must be greater than min delay");
      return;
    }
    setSavingTiming(true);
    try {
      await api.put(`/workspaces/${activeWorkspace}/automation-settings`, timing);
      toast.success("Timing saved!");
    } catch {
      toast.error("Failed to save timing");
    } finally {
      setSavingTiming(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Zap className="w-6 h-6 text-purple-600" />
          Setup Automation
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Edit your DM messages and timing settings
        </p>
      </div>

      {/* Toggle automation */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5 flex items-center justify-between">
        <div>
          <p className="font-semibold text-gray-900">Automation Active</p>
          <p className="text-xs text-gray-400">When off, no DMs will be sent automatically</p>
        </div>
        <button
          onClick={() => setTiming(t => ({ ...t, automationEnabled: !t.automationEnabled }))}
          className={`relative w-12 h-6 rounded-full transition-colors ${timing.automationEnabled ? "bg-purple-600" : "bg-gray-300"}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${timing.automationEnabled ? "translate-x-6" : "translate-x-0.5"}`} />
        </button>
      </div>

      {/* Messages section */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-5">
        <h2 className="font-bold text-gray-900 flex items-center gap-2">
          <MessageCircle className="w-4 h-4 text-pink-500" />
          DM Messages
        </h2>
        <p className="text-xs text-gray-400 -mt-3">
          Use <code className="bg-gray-100 px-1 rounded">{"{name}"}</code> to insert the user's first name
        </p>

        <MessageField
          label="Greeting Message"
          hint="Sent when someone follows or likes your post"
          value={messages.greeting}
          onChange={v => setMessages(m => ({ ...m, greeting: v }))}
        />
        <MessageField
          label="Follow-up #1"
          hint="Sent if no reply after the interval"
          value={messages.followUp1}
          onChange={v => setMessages(m => ({ ...m, followUp1: v }))}
        />
        <MessageField
          label="Follow-up #2"
          hint="Sent if still no reply after another interval"
          value={messages.followUp2}
          onChange={v => setMessages(m => ({ ...m, followUp2: v }))}
        />
        <MessageField
          label="Follow-up #3 (final)"
          hint="Last automated message in the sequence"
          value={messages.followUp3}
          onChange={v => setMessages(m => ({ ...m, followUp3: v }))}
        />

        <div>
          <label className="label">Follow-up interval (hours)</label>
          <input
            type="number"
            min={1}
            max={72}
            className="input w-32"
            value={messages.followUpIntervalHours}
            onChange={e => setMessages(m => ({ ...m, followUpIntervalHours: +e.target.value }))}
          />
          <p className="text-xs text-gray-400 mt-1">Time between each follow-up message</p>
        </div>

        <button onClick={saveMessages} disabled={savingMsgs} className="btn-primary flex items-center gap-2">
          {savingMsgs ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Messages
        </button>
      </div>

      {/* Timing section */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
        <h2 className="font-bold text-gray-900 flex items-center gap-2">
          <Clock className="w-4 h-4 text-blue-500" />
          Greeting Delay Timing
        </h2>
        <p className="text-xs text-gray-400 -mt-2">
          After a trigger (follow/like), the greeting DM is sent after a random delay within this range — so it feels natural, not robotic.
        </p>

        <div className="flex items-center gap-4">
          <div>
            <label className="label">Min (minutes)</label>
            <input
              type="number"
              min={1}
              max={60}
              className="input w-24"
              value={timing.minDelayMinutes}
              onChange={e => setTiming(t => ({ ...t, minDelayMinutes: +e.target.value }))}
            />
          </div>
          <span className="text-gray-400 mt-5">–</span>
          <div>
            <label className="label">Max (minutes)</label>
            <input
              type="number"
              min={1}
              max={60}
              className="input w-24"
              value={timing.maxDelayMinutes}
              onChange={e => setTiming(t => ({ ...t, maxDelayMinutes: +e.target.value }))}
            />
          </div>
        </div>

        <button onClick={saveTiming} disabled={savingTiming} className="btn-primary flex items-center gap-2">
          {savingTiming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Timing
        </button>
      </div>
    </div>
  );
}

function MessageField({ label, hint, value, onChange }) {
  return (
    <div>
      <label className="label">{label}</label>
      <p className="text-xs text-gray-400 mb-1">{hint}</p>
      <textarea
        className="input min-h-[70px] resize-y"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Type your message..."
      />
    </div>
  );
}
