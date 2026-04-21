import { useState } from "react";
import { Link } from "react-router-dom";
import api from "@/services/api";
import toast from "react-hot-toast";
import { ArrowLeft } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email });
      setSent(true);
    } catch (err) {
      toast.error(err.response?.data?.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  if (sent)
    return (
      <div className="text-center">
        <h2 className="text-2xl font-bold mb-2">Email sent!</h2>
        <p className="text-gray-500 text-sm mb-4">
          Check your inbox for a password reset link.
        </p>
        <Link to="/login" className="text-brand-600 hover:underline text-sm">
          Back to login
        </Link>
      </div>
    );

  return (
    <div>
      <Link
        to="/login"
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-6"
      >
        <ArrowLeft className="w-4 h-4" /> Back to login
      </Link>
      <h2 className="text-2xl font-bold text-gray-900 mb-1">Forgot password</h2>
      <p className="text-gray-500 text-sm mb-6">
        Enter your email and we'll send you a reset link.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Email address</label>
          <input
            className="input"
            type="email"
            placeholder="you@example.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? "Sending…" : "Send reset link"}
        </button>
      </form>
    </div>
  );
}
