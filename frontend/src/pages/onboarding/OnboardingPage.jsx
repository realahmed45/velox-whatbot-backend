import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import api from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import toast from "react-hot-toast";
import {
  Building2,
  Instagram,
  Bot,
  CheckCircle2,
  ExternalLink,
  Loader2,
  AlertCircle,
} from "lucide-react";

const STEPS = [
  { id: 1, title: "Create Workspace", icon: Building2 },
  { id: 2, title: "Connect Instagram", icon: Instagram },
  { id: 3, title: "Pick a Template", icon: Bot },
  { id: 4, title: "You're Ready!", icon: CheckCircle2 },
];

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(false);
  const { setActiveWorkspace } = useAuthStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // If redirected back from Meta OAuth callback, advance to step 3
  useEffect(() => {
    const oauthStatus = searchParams.get("oauth");
    const wsId = searchParams.get("ws");
    if (oauthStatus === "success" && wsId) {
      setWorkspace({ _id: wsId });
      setActiveWorkspace(wsId);
      toast.success("Instagram connected successfully!");
      setStep(3);
    } else if (oauthStatus === "error") {
      toast.error("Instagram connection failed. Please try again.");
    }
  }, [searchParams, setActiveWorkspace]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-pink-50 via-white to-purple-50 flex items-center justify-center p-6">
      <div className="w-full max-w-xl">
        {/* Branding */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-9 h-9 bg-gradient-to-br from-pink-500 to-purple-600 rounded-xl flex items-center justify-center shadow-md">
              <Instagram className="w-5 h-5 text-white" />
            </div>
            <span className="text-2xl font-bold text-gray-900">Flowgram</span>
          </div>
          <p className="text-gray-500 text-sm">Instagram DM Automation</p>
        </div>
        {/* Progress steps */}
        <div className="flex items-center gap-0 mb-8">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center flex-1">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0 transition-colors
                ${step > s.id ? "bg-brand-600 text-white" : step === s.id ? "bg-brand-600 text-white ring-4 ring-brand-100" : "bg-gray-200 text-gray-400"}`}
              >
                {step > s.id ? "✓" : s.id}
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`h-0.5 flex-1 mx-1 transition-colors ${step > s.id ? "bg-brand-400" : "bg-gray-200"}`}
                />
              )}
            </div>
          ))}
        </div>

        <div className="card p-8 shadow-lg">
          {step === 1 && (
            <Step1
              onNext={(ws) => {
                setWorkspace(ws);
                setActiveWorkspace(ws._id);
                setStep(2);
              }}
              loading={loading}
              setLoading={setLoading}
            />
          )}
          {step === 2 && (
            <Step2
              workspace={workspace}
              onNext={() => setStep(3)}
              onSkip={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <Step3
              workspace={workspace}
              onNext={() => setStep(4)}
              onSkip={() => setStep(4)}
            />
          )}
          {step === 4 && (
            <Step4
              workspace={workspace}
              onDone={() => {
                setActiveWorkspace(workspace?._id);
                navigate("/dashboard");
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Step1({ onNext, loading, setLoading }) {
  const [form, setForm] = useState({
    name: "",
    industry: "other",
    timezone: "Asia/Karachi",
  });
  const TYPES = [
    "restaurant",
    "retail",
    "beauty_salon",
    "real_estate",
    "general",
  ];

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("Workspace name required");
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post("/workspaces", form);
      onNext(data.workspace);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to create workspace");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center mb-4">
        <Building2 className="w-5 h-5 text-brand-600" />
      </div>
      <h2 className="text-xl font-bold text-gray-900 mb-1">
        Create your workspace
      </h2>
      <p className="text-gray-500 text-sm mb-6">
        A workspace holds your Instagram account, flows, and contacts.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Brand / Business Name</label>
          <input
            className="input"
            placeholder="e.g. Blushstrike Beauty"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label className="label">Industry</label>
          <select
            className="input"
            value={form.industry}
            onChange={(e) => setForm({ ...form, industry: e.target.value })}
          >
            {[
              { value: "ecommerce", label: "E-commerce / Shop" },
              { value: "beauty_salon", label: "Beauty / Salon" },
              { value: "restaurant", label: "Restaurant / Food" },
              { value: "real_estate", label: "Real Estate" },
              { value: "fitness", label: "Fitness / Wellness" },
              { value: "education", label: "Education / Coaching" },
              { value: "influencer", label: "Creator / Influencer" },
              { value: "other", label: "Other / General" },
            ].map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? (
            <span className="flex items-center gap-2 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Creating…
            </span>
          ) : (
            "Create workspace & continue →"
          )}
        </button>
      </form>
    </div>
  );
}

function Step2({ workspace, onNext, onSkip }) {
  const [loading, setLoading] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const startOAuth = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/instagram/connect/oauth-url");
      sessionStorage.setItem("onboarding_ws_id", workspace._id);
      window.location.href = data.url;
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to start OAuth");
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="w-10 h-10 bg-pink-50 rounded-xl flex items-center justify-center mb-4">
        <Instagram className="w-5 h-5 text-pink-600" />
      </div>
      <h2 className="text-xl font-bold mb-1">Connect Instagram</h2>
      <p className="text-gray-500 text-sm mb-6">
        Sign in with Facebook to connect your Instagram Business account.
      </p>

      <button
        onClick={startOAuth}
        disabled={loading}
        className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-pink-500 to-purple-600 text-white font-semibold py-3 rounded-xl shadow-md hover:opacity-90 transition disabled:opacity-60 mb-3"
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Instagram className="w-4 h-4" />
        )}
        Connect Instagram Business Account
      </button>

      <button
        onClick={() => setShowHelp(!showHelp)}
        className="w-full text-xs text-gray-400 hover:text-gray-600 transition mb-1"
      >
        Don't have a business account?
      </button>

      {showHelp && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 mb-3">
          <p className="font-semibold mb-1">Switch to a Business or Creator account:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Open Instagram &rarr; go to your profile</li>
            <li>Tap Settings &rarr; Account</li>
            <li>Tap &quot;Switch to Professional Account&quot;</li>
            <li>Choose <strong>Business</strong> or <strong>Creator</strong></li>
            <li>Come back here and connect</li>
          </ol>
        </div>
      )}

      <button
        onClick={onSkip}
        className="btn-ghost w-full mt-1 text-gray-400 text-xs"
      >
        Skip for now &mdash; connect later in Settings
      </button>
    </div>
  );
}


function Step3({ workspace, onNext, onSkip }) {
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);

  const TEMPLATES = [
    {
      id: "ig_welcome_dm",
      label: "👋 Welcome DM",
      desc: "Auto-DM new followers with a personalised welcome",
    },
    {
      id: "ig_keyword_reply",
      label: "🔑 Keyword Reply",
      desc: "Reply when someone DMs a specific keyword (e.g. 'price')",
    },
    {
      id: "ig_story_mention",
      label: "📸 Story Mention Reply",
      desc: "DM users who mention you in their story",
    },
    {
      id: "ig_comment_to_dm",
      label: "💬 Comment → DM",
      desc: "Auto-DM users who comment on your posts",
    },
    {
      id: "ig_lead_capture",
      label: "🎯 Lead Capture",
      desc: "Collect name + email via DM conversation",
    },
  ];

  const applyTemplate = async () => {
    if (!selected) {
      toast.error("Please pick a template");
      return;
    }
    setLoading(true);
    try {
      await api.post("/flows/from-template", {
        workspaceId: workspace?._id,
        templateKey: selected,
      });
      toast.success("Template flow created!");
      onNext();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to apply template");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="w-10 h-10 bg-purple-50 rounded-xl flex items-center justify-center mb-4">
        <Bot className="w-5 h-5 text-purple-600" />
      </div>
      <h2 className="text-xl font-bold mb-1">Pick a starter template</h2>
      <p className="text-gray-500 text-sm mb-4">
        We'll create a ready-made automation flow you can customize.
      </p>
      <div className="space-y-2 mb-4">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelected(t.id)}
            className={`w-full text-left p-3 rounded-lg border transition ${
              selected === t.id
                ? "border-brand-500 bg-brand-50"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <div className="font-medium text-sm">{t.label}</div>
            <div className="text-xs text-gray-500">{t.desc}</div>
          </button>
        ))}
      </div>
      <button
        onClick={applyTemplate}
        className="btn-primary w-full"
        disabled={loading || !selected}
      >
        {loading ? (
          <span className="flex items-center gap-2 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Creating…
          </span>
        ) : (
          "Apply template →"
        )}
      </button>
      <button
        onClick={onSkip}
        className="btn-ghost w-full mt-2 text-gray-400 text-sm"
      >
        Start from scratch
      </button>
    </div>
  );
}

function Step4({ workspace, onDone }) {
  return (
    <div className="text-center">
      <div className="w-16 h-16 bg-gradient-to-br from-pink-100 to-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <CheckCircle2 className="w-8 h-8 text-brand-600" />
      </div>
      <h2 className="text-xl font-bold mb-2">You're all set! 🎉</h2>
      <p className="text-gray-500 text-sm mb-6">
        <strong>{workspace?.name}</strong> is ready. Go to your dashboard to
        build flows, monitor DMs, and grow your Instagram presence.
      </p>
      <button onClick={onDone} className="btn-primary w-full">
        Open Dashboard →
      </button>
    </div>
  );
}
