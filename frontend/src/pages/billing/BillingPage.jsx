import { useEffect, useState } from "react";
import api from "@/services/api";
import { useWorkspaceStore } from "@/store/workspaceStore";
import toast from "react-hot-toast";
import { CheckCircle2, Crown, Zap, Building, Briefcase, X } from "lucide-react";

const PLANS = [
  {
    id: "starter",
    name: "Starter",
    price: 0,
    icon: Zap,
    color: "gray",
    messages: "500/mo",
    agents: 1,
    features: [
      "500 messages/month",
      "1 agent seat",
      "UltraMsg (QR scan)",
      "3 active flows",
      "Basic analytics",
      "Email support",
    ],
  },
  {
    id: "growth",
    name: "Growth",
    price: 2999,
    icon: Zap,
    color: "blue",
    messages: "5,000/mo",
    agents: 3,
    popular: true,
    features: [
      "5,000 messages/month",
      "3 agent seats",
      "UltraMsg or Meta API",
      "20 active flows",
      "Advanced analytics",
      "Broadcast campaigns",
      "Priority support",
    ],
  },
  {
    id: "business",
    name: "Business",
    price: 6999,
    icon: Building,
    color: "brand",
    messages: "25,000/mo",
    agents: 10,
    features: [
      "25,000 messages/month",
      "10 agent seats",
      "Meta Cloud API",
      "Unlimited flows",
      "Full analytics + heatmap",
      "Broadcast campaigns",
      "API access",
      "Dedicated support",
    ],
  },
  {
    id: "agency",
    name: "Agency",
    price: 14999,
    icon: Crown,
    color: "purple",
    messages: "Unlimited",
    agents: "Unlimited",
    features: [
      "Unlimited messages",
      "Unlimited agent seats",
      "Multi-workspace",
      "White-label option",
      "Custom integrations",
      "SLA support",
      "Onboarding assistance",
    ],
  },
];

export default function BillingPage() {
  const { workspace } = useWorkspaceStore();
  const [billing, setBilling] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [showPayModal, setShowPayModal] = useState(null); // plan id
  const [annual, setAnnual] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const [planRes, invRes] = await Promise.all([
          api.get("/billing/plans"),
          api.get("/billing/invoices"),
        ]);
        setBilling(planRes.data);
        setInvoices(invRes.data.invoices || []);
      } catch (err) {
        console.error(err);
      }
    };
    load();
  }, []);

  const currentPlan = workspace?.subscription?.plan || "starter";

  const getDisplayPrice = (basePrice) => {
    if (basePrice === 0) return "Free";
    const p = annual ? Math.round(basePrice * 10) : basePrice;
    return `PKR ${p.toLocaleString()}/${annual ? "yr" : "mo"}`;
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Billing & Plans</h1>
          <p className="text-sm text-gray-500">
            Current plan:{" "}
            <strong className="text-brand-600 capitalize">{currentPlan}</strong>
          </p>
        </div>
        {/* Annual toggle */}
        <div className="flex items-center gap-2 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setAnnual(false)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition ${!annual ? "bg-white shadow-sm text-gray-800" : "text-gray-500"}`}
          >
            Monthly
          </button>
          <button
            onClick={() => setAnnual(true)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition flex items-center gap-1 ${annual ? "bg-white shadow-sm text-gray-800" : "text-gray-500"}`}
          >
            Annual <span className="badge-green badge text-xs">Save 17%</span>
          </button>
        </div>
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {PLANS.map((plan) => {
          const isActive = currentPlan === plan.id;
          return (
            <div
              key={plan.id}
              className={`card p-5 flex flex-col relative ${plan.popular ? "ring-2 ring-brand-500" : ""} ${isActive ? "bg-brand-50 border-brand-200" : ""}`}
            >
              {plan.popular && (
                <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 badge-green badge text-xs px-3">
                  Most Popular
                </div>
              )}
              <div className="mb-4">
                <p className="font-bold text-gray-900 text-base">{plan.name}</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">
                  {getDisplayPrice(plan.price)}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {plan.messages} messages
                </p>
              </div>
              <ul className="space-y-2 flex-1 mb-5">
                {plan.features.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-2 text-xs text-gray-600"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-brand-500 flex-shrink-0 mt-0.5" />
                    {f}
                  </li>
                ))}
              </ul>
              {isActive ? (
                <span className="btn bg-brand-50 text-brand-700 border border-brand-200 text-sm cursor-default">
                  Current plan
                </span>
              ) : plan.price === 0 ? (
                <span className="btn-secondary text-sm cursor-default">
                  Free forever
                </span>
              ) : (
                <button
                  onClick={() => setShowPayModal(plan)}
                  className="btn-primary text-sm"
                >
                  Upgrade →
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Invoices */}
      {invoices.length > 0 && (
        <div className="card overflow-hidden">
          <div className="p-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-800">Invoice History</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100 text-left">
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                  Invoice #
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                  Plan
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                  Amount
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                  Date
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {invoices.map((inv) => (
                <tr key={inv._id}>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">
                    {inv.invoiceNumber}
                  </td>
                  <td className="px-4 py-3 capitalize text-gray-800">
                    {inv.plan}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-800">
                    PKR {inv.amount?.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {new Date(inv.createdAt).toLocaleDateString("en-PK")}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        inv.status === "paid"
                          ? "badge-green badge"
                          : "badge-yellow badge"
                      }
                    >
                      {inv.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showPayModal && (
        <PaymentModal
          plan={showPayModal}
          annual={annual}
          onClose={() => setShowPayModal(null)}
        />
      )}
    </div>
  );
}

function PaymentModal({ plan, annual, onClose }) {
  const [provider, setProvider] = useState("jazzcash");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [paid, setPaid] = useState(false);
  const amount = annual ? plan.price * 10 : plan.price;

  const initiate = async () => {
    if (!phone) {
      toast.error("Phone number required");
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post("/billing/initiate-payment", {
        planId: plan.id,
        provider,
        phone,
        billingCycle: annual ? "annual" : "monthly",
      });
      toast.success("Payment initiated! Enter MPIN on your phone.");
      // Poll or wait for user confirmation
      setTimeout(async () => {
        try {
          await api.post("/billing/confirm-payment", {
            orderId: data.orderId,
            provider,
            planId: plan.id,
          });
          setPaid(true);
          toast.success("🎉 Plan upgraded successfully!");
        } catch {
          toast.error("Payment not confirmed. Try again.");
        }
      }, 15000);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to initiate payment");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl">
        {paid ? (
          <div className="text-center py-4">
            <CheckCircle2 className="w-14 h-14 text-brand-500 mx-auto mb-3" />
            <h2 className="text-xl font-bold text-gray-900 mb-1">
              Payment Successful!
            </h2>
            <p className="text-gray-500 text-sm mb-4">
              Your account has been upgraded to <strong>{plan.name}</strong>.
            </p>
            <button onClick={onClose} className="btn-primary w-full">
              Go to Dashboard
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-bold text-gray-900">
                  Upgrade to {plan.name}
                </h2>
                <p className="text-sm text-gray-500">
                  PKR {amount.toLocaleString()} / {annual ? "year" : "month"}
                </p>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded text-gray-400 hover:bg-gray-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Provider tabs */}
            <div className="flex gap-2 mb-4">
              {["jazzcash", "easypaisa"].map((p) => (
                <button
                  key={p}
                  onClick={() => setProvider(p)}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition ${provider === p ? "border-brand-500 bg-brand-50 text-brand-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`}
                >
                  {p === "jazzcash" ? "🟤 JazzCash" : "🟢 EasyPaisa"}
                </button>
              ))}
            </div>

            <div className="space-y-3">
              <div>
                <label className="label">
                  {provider === "jazzcash" ? "JazzCash" : "EasyPaisa"} Mobile
                  Number
                </label>
                <input
                  className="input"
                  placeholder="03001234567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-500">
                <p>1. Enter your registered mobile wallet number above.</p>
                <p>
                  2. Click "Pay Now" — you'll receive an MPIN prompt on your
                  phone.
                </p>
                <p>3. Approve the payment with your MPIN.</p>
              </div>
              <div className="flex items-center justify-between text-sm font-medium border-t pt-3">
                <span>Total amount</span>
                <span className="text-brand-700">
                  PKR {amount.toLocaleString()}
                </span>
              </div>
              <button
                onClick={initiate}
                className="btn-primary w-full"
                disabled={loading}
              >
                {loading
                  ? "Initiating payment…"
                  : `Pay PKR ${amount.toLocaleString()}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
