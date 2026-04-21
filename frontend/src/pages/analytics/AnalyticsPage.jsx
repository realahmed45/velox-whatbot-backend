import { useEffect, useState } from "react";
import api from "@/services/api";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import dayjs from "dayjs";

const COLORS = ["#16a34a", "#22c55e", "#4ade80", "#86efac"];

export default function AnalyticsPage() {
  const [overview, setOverview] = useState(null);
  const [msgData, setMsgData] = useState([]);
  const [peakData, setPeakData] = useState([]);
  const [flowData, setFlowData] = useState([]);
  const [period, setPeriod] = useState("week");

  useEffect(() => {
    const load = async () => {
      try {
        const [ov, msg, peak, flows] = await Promise.all([
          api.get("/analytics/overview"),
          api.get(`/analytics/messages-over-time?period=${period}`),
          api.get("/analytics/peak-hours"),
          api.get("/analytics/flow-performance"),
        ]);
        setOverview(ov.data);
        setMsgData(msg.data.data || []);
        setPeakData(peak.data.data || []);
        setFlowData(flows.data.flows || []);
      } catch (err) {
        console.error(err);
      }
    };
    load();
  }, [period]);

  const pieData = overview
    ? [
        { name: "Bot handled", value: overview.botHandled || 0 },
        { name: "Human handled", value: overview.humanHandled || 0 },
      ]
    : [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Analytics</h1>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {["week", "month", "3months"].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${period === p ? "bg-white text-gray-800 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
            >
              {p === "week" ? "7 days" : p === "month" ? "30 days" : "3 months"}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Total Messages", value: overview?.totalMessages ?? "—" },
          { label: "Inbound", value: overview?.inboundMessages ?? "—" },
          { label: "Outbound", value: overview?.outboundMessages ?? "—" },
          {
            label: "Bot Handled %",
            value: overview?.botHandledPct ? `${overview.botHandledPct}%` : "—",
          },
        ].map(({ label, value }) => (
          <div key={label} className="card p-4">
            <p className="text-2xl font-bold text-gray-900">{value}</p>
            <p className="text-xs text-gray-500 mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Messages over time */}
      <div className="card p-5">
        <h2 className="font-semibold text-gray-800 mb-4">Messages over time</h2>
        {msgData.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={msgData}>
              <defs>
                <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#16a34a" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#16a34a" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11 }}
                tickFormatter={(d) => dayjs(d).format("D MMM")}
              />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Area
                type="monotone"
                dataKey="count"
                stroke="#16a34a"
                fill="url(#grad)"
                strokeWidth={2}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Peak hours */}
        <div className="card p-5">
          <h2 className="font-semibold text-gray-800 mb-4">
            Peak message hours
          </h2>
          {peakData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={peakData}>
                <XAxis
                  dataKey="hour"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(h) => `${h}:00`}
                />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#16a34a" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart />
          )}
        </div>

        {/* Bot vs Human pie */}
        <div className="card p-5">
          <h2 className="font-semibold text-gray-800 mb-4">
            Bot vs Human handled
          </h2>
          {pieData.some((d) => d.value > 0) ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={70}
                  label
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Legend />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart />
          )}
        </div>
      </div>

      {/* Flow performance table */}
      <div className="card overflow-hidden">
        <div className="p-5 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">Flow performance</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100 text-left">
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                  Flow name
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                  Triggered
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                  Completed
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                  Completion rate
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {flowData.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="text-center py-6 text-gray-400 text-sm"
                  >
                    No flow data yet
                  </td>
                </tr>
              ) : (
                flowData.map((f) => (
                  <tr key={f._id}>
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {f.name}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {f.stats?.triggered ?? 0}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {f.stats?.completed ?? 0}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 max-w-[80px] h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-brand-500 rounded-full"
                            style={{
                              width: `${f.stats?.triggered ? Math.round((f.stats.completed / f.stats.triggered) * 100) : 0}%`,
                            }}
                          />
                        </div>
                        <span className="text-xs text-gray-500">
                          {f.stats?.triggered
                            ? Math.round(
                                (f.stats.completed / f.stats.triggered) * 100,
                              )
                            : 0}
                          %
                        </span>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const EmptyChart = () => (
  <div className="h-[200px] flex items-center justify-center text-gray-400 text-sm">
    No data for this period yet
  </div>
);
