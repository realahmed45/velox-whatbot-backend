import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import toast from "react-hot-toast";
import { Eye, EyeOff } from "lucide-react";

export default function RegisterPage() {
  const [form, setForm] = useState({ name: "", email: "", password: "", confirmPassword: "" });
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    if (form.password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post("/auth/register", {
        name: form.name,
        email: form.email,
        password: form.password,
      });
      login(data.user, data.token, data.refreshToken);
      toast.success("Welcome to Botlify!");
      navigate("/onboarding");
    } catch (err) {
      toast.error(err.response?.data?.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-1">Create your account</h2>
      <p className="text-gray-500 text-sm mb-8">
        Already have an account?{" "}
        <Link to="/login" className="text-brand-600 font-medium hover:underline">Sign in</Link>
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Full name</label>
          <input className="input" placeholder="Ahmad Ali" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label className="label">Email address</label>
          <input className="input" type="email" placeholder="you@example.com" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <label className="label">Password</label>
          <div className="relative">
            <input className="input pr-10" type={show ? "text" : "password"} placeholder="Min 8 characters" required value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
            <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" onClick={() => setShow(!show)}>
              {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div>
          <label className="label">Confirm password</label>
          <input className="input" type="password" placeholder="Repeat password" required value={form.confirmPassword} onChange={e => setForm({ ...form, confirmPassword: e.target.value })} />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? "Creating account…" : "Create account"}
        </button>
      </form>
    </div>
  );
}

export default function RegisterPage() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    console.log("[Register] Form submitted", {
      name: form.name,
      email: form.email,
      passwordLen: form.password.length,
    });

    if (form.password !== form.confirmPassword) {
      console.warn("[Register] Password mismatch — aborting");
      toast.error("Passwords do not match");
      return;
    }
    if (form.password.length < 8) {
      console.warn("[Register] Password too short — aborting");
      toast.error("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    console.log("[Register] Sending POST /auth/register to API...");
    try {
      const res = await api.post("/auth/register", {
        name: form.name,
        email: form.email,
        password: form.password,
      });
      console.log("[Register] API response OK", res.status, res.data);
      console.log(
        "[Register] Email status from server:",
        res.data?._emailStatus,
      );
      toast.success("Account created! Check your email to verify.");
      console.log("[Register] Navigating to verify-email page...");
      navigate(`/verify-email?email=${encodeURIComponent(form.email)}`);
    } catch (err) {
      console.error("[Register] API call FAILED");
      console.error("[Register] HTTP status:", err.response?.status);
      console.error("[Register] Response body:", err.response?.data);
      console.error("[Register] Error message:", err.message);
      toast.error(err.response?.data?.message || "Registration failed");
    } finally {
      setLoading(false);
      console.log("[Register] handleSubmit done, loading=false");
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-1">
        Create your account
      </h2>
      <p className="text-gray-500 text-sm mb-8">
        Already have an account?{" "}
        <Link
          to="/login"
          className="text-brand-600 font-medium hover:underline"
        >
          Sign in
        </Link>
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Full name</label>
          <input
            className="input"
            type="text"
            placeholder="Ahmed Ali"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label className="label">Email address</label>
          <input
            className="input"
            type="email"
            placeholder="you@example.com"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div>
          <label className="label">Password</label>
          <div className="relative">
            <input
              className="input pr-10"
              type={show ? "text" : "password"}
              placeholder="Min. 8 characters"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              onClick={() => setShow(!show)}
            >
              {show ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
        <div>
          <label className="label">Confirm password</label>
          <input
            className="input"
            type="password"
            placeholder="••••••••"
            required
            value={form.confirmPassword}
            onChange={(e) =>
              setForm({ ...form, confirmPassword: e.target.value })
            }
          />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? "Creating account…" : "Create account"}
        </button>
        <p className="text-xs text-gray-400 text-center">
          By signing up, you agree to our Terms of Service and Privacy Policy.
        </p>
      </form>
    </div>
  );
}
