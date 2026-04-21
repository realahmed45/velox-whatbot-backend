import { Outlet } from "react-router-dom";
import { Instagram } from "lucide-react";

export default function AuthLayout() {
  return (
    <div className="min-h-screen flex">
      {/* Left decorative panel */}
      <div className="hidden lg:flex w-1/2 bg-gradient-to-br from-pink-500 to-purple-700 flex-col items-center justify-center p-12 text-white">
        <div className="max-w-md text-center">
          <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Instagram className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold mb-3">Botlify</h1>
          <p className="text-pink-100 text-lg">
            Automate your Instagram DMs. Send greetings when someone follows or likes your post — automatically.
          </p>
          <div className="mt-8 space-y-3 text-sm text-left">
            {[
              "Auto DM on follow or like",
              "Smart follow-up sequences",
              "Random delay — feels human",
              "Analytics & contact tracking",
            ].map((f) => (
              <div key={f} className="flex items-center gap-2 bg-white/10 rounded-xl px-4 py-2">
                <span className="text-pink-300">✓</span> {f}
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Right form panel */}
      <div className="flex-1 flex items-center justify-center p-6 bg-white">
        <div className="w-full max-w-md">
          <div className="flex items-center gap-2 mb-8 lg:hidden">
            <div className="w-8 h-8 bg-gradient-to-br from-pink-500 to-purple-600 rounded-lg flex items-center justify-center">
              <Instagram className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-gray-900 text-lg">Botlify</span>
          </div>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
