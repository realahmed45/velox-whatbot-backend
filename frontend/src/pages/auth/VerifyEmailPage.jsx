import { useEffect, useState } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { Mail, CheckCircle, XCircle, Loader } from "lucide-react";
import api from "@/services/api";
import { useAuthStore } from "@/store/authStore";

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const email = params.get("email") || "your email";
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  const [status, setStatus] = useState(token ? "verifying" : "waiting"); // verifying | success | error | waiting
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!token) return;

    console.log(
      "[VerifyEmail] Token found in URL, calling /auth/verify-email...",
    );
    api
      .post("/auth/verify-email", { token })
      .then((res) => {
        console.log("[VerifyEmail] Verification success", res.data);
        // Log the user in automatically
        const { user, token: accessToken } = res.data;
        login(user, accessToken, null);
        setStatus("success");
        setTimeout(() => navigate("/onboarding"), 2000);
      })
      .catch((err) => {
        console.error(
          "[VerifyEmail] Verification failed",
          err.response?.data || err.message,
        );
        setErrorMsg(
          err.response?.data?.message ||
            "Verification failed. The link may have expired.",
        );
        setStatus("error");
      });
  }, [token]);

  // ── Waiting for email (no token in URL) ──
  if (status === "waiting") {
    return (
      <div className="text-center">
        <div className="w-16 h-16 bg-brand-50 rounded-full flex items-center justify-center mx-auto mb-4">
          <Mail className="w-8 h-8 text-brand-600" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Check your email
        </h2>
        <p className="text-gray-500 text-sm mb-4">
          We sent a verification link to{" "}
          <strong className="text-gray-700">{email}</strong>. Click the link in
          the email to verify your account.
        </p>
        <p className="text-xs text-gray-400">
          Didn't get it? Check your spam folder.{" "}
          <Link to="/login" className="text-brand-600 hover:underline">
            Back to login
          </Link>
        </p>
      </div>
    );
  }

  // ── Verifying in progress ──
  if (status === "verifying") {
    return (
      <div className="text-center">
        <div className="w-16 h-16 bg-brand-50 rounded-full flex items-center justify-center mx-auto mb-4">
          <Loader className="w-8 h-8 text-brand-600 animate-spin" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Verifying your email...
        </h2>
        <p className="text-gray-500 text-sm">Please wait a moment.</p>
      </div>
    );
  }

  // ── Success ──
  if (status === "success") {
    return (
      <div className="text-center">
        <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
          <CheckCircle className="w-8 h-8 text-green-500" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Email Verified!
        </h2>
        <p className="text-gray-500 text-sm">
          Your account is confirmed. Taking you to setup...
        </p>
      </div>
    );
  }

  // ── Error ──
  return (
    <div className="text-center">
      <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
        <XCircle className="w-8 h-8 text-red-500" />
      </div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        Verification Failed
      </h2>
      <p className="text-gray-500 text-sm mb-4">{errorMsg}</p>
      <Link to="/login" className="text-brand-600 hover:underline text-sm">
        Back to login
      </Link>
    </div>
  );
}
