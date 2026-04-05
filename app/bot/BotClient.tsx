"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface Position {
  id: string;
  slug: string;
  question: string;
  side: "YES" | "NO";
  shares: number;
  costBasis: number;
  entryPrice: number;
  targetPrice: number;
  lastFairPrice: number;
  aiProbability: number;
  edge: number;
  status: string;
  openedAt: string;
  soldAt?: string;
  pnl?: number;
  sellReason?: string;
}

interface Config {
  minEdge: number;
  betSize: number;
  betSizePct: number;
  betSizeMode: "fixed" | "percent";
  edgeCaptureRatio: number;
  maxPositions: number;
  maxBetsPerCycle: number;
  scanIntervalMin: number;
  stopLossPct: number;
  maxHoldDays: number;
  maxDrawdownPct: number;
  buyEnabled: boolean;
  sellEnabled: boolean;
}

interface Stats {
  totalCycles: number;
  totalTrades: number;
  totalPnl: number;
  winRate: number;
  openPositions: number;
  closedPositions: number;
  unrealizedValue: number;
  startingCapital: number;
}

interface HealthCheck {
  ok: boolean;
  message: string;
}

interface BotStatus {
  config: Config;
  positions: Position[];
  stats: Stats;
  health: { checks: Record<string, HealthCheck>; healthy: boolean };
  lastCycleAt?: string;
}

interface JobStatus {
  id: string;
  status: "dispatched" | "running" | "complete" | "error";
  progress: Array<{ phase: string; message: string; timestamp: string }>;
  error?: string;
}

function useApi(secret: string) {
  const headers = { "Content-Type": "application/json", "x-admin-secret": secret };
  const get = async (path: string) => {
    const res = await fetch(`/api/bot/${path}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`/api/bot/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  return { get, post };
}

export default function BotClient() {
  const [secret, setSecret] = useState("");
  const [authed, setAuthed] = useState(false);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"trading" | "positions" | "strategy" | "system">("trading");
  const [cycleLog, setCycleLog] = useState<string[]>([]);
  const [cycling, setCycling] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const autoRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const api = useApi(secret);

  const loadStatus = useCallback(async () => {
    if (!authed) return;
    try {
      const data = await api.get("status");
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [authed, secret]);

  useEffect(() => {
    if (authed) {
      loadStatus();
      const i = setInterval(loadStatus, 30000);
      return () => clearInterval(i);
    }
  }, [authed, loadStatus]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [cycleLog]);

  useEffect(() => {
    if (autoMode && !cycling) {
      const interval = (status?.config.scanIntervalMin ?? 5) * 60 * 1000;
      autoRef.current = setInterval(() => runCycle(), interval);
    } else {
      if (autoRef.current) clearInterval(autoRef.current);
    }
    return () => { if (autoRef.current) clearInterval(autoRef.current); };
  }, [autoMode, cycling]);

  const runCycle = async () => {
    if (cycling) return;
    setCycling(true);
    setCycleLog([]);
    setError("");
    try {
      const { jobId } = await api.post("cycle", {});
      setCycleLog([`[${new Date().toLocaleTimeString()}] Dispatched — job: ${jobId}`]);
      let done = false;
      while (!done) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const job: JobStatus = await api.get(`cycle?jobId=${jobId}`);
          setCycleLog(job.progress.map((p) => `[${new Date(p.timestamp).toLocaleTimeString()}] [${p.phase}] ${p.message}`));
          if (job.status === "complete" || job.status === "error") {
            done = true;
            setCycleLog((prev) => [...prev, job.status === "error" ? `❌ ${job.error}` : "✅ Cycle complete!"]);
            await loadStatus();
          }
        } catch { /* keep polling */ }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cycle failed");
    } finally {
      setCycling(false);
    }
  };

  const forceSell = async (positionId: string) => {
    if (!confirm("Force sell this position?")) return;
    try {
      await api.post("sell", { positionId });
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sell failed");
    }
  };

  const updateConfig = async (updates: Partial<Config>) => {
    try {
      await api.post("status", updates);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Config update failed");
    }
  };

  const applyPreset = async (preset: string) => {
    if (!confirm(`Apply ${preset} preset?`)) return;
    try {
      await api.post("status", { preset });
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preset failed");
    }
  };

  if (!authed) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-xl font-bold text-white mb-2">Edge Trader Bot</h1>
          <p className="text-gray-400 text-sm mb-6">Enter your admin secret</p>
          <input
            type="password"
            placeholder="Admin secret..."
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setAuthed(true)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white text-sm mb-4 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => setAuthed(true)}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          >
            Login
          </button>
        </div>
      </div>
    );
  }

  const openPositions = status?.positions.filter((p) => p.status === "open") ?? [];
  const closedPositions = status?.positions.filter((p) => p.status === "sold") ?? [];

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${status?.health.healthy ? "bg-green-400" : "bg-red-400"}`} />
          <h1 className="font-bold text-lg">Edge Trader Bot</h1>
          {status?.lastCycleAt && (
            <span className="text-gray-500 text-xs">Last: {new Date(status.lastCycleAt).toLocaleTimeString()}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setAutoMode(!autoMode)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${autoMode ? "bg-green-600" : "bg-gray-800 hover:bg-gray-700"}`}
          >
            {autoMode ? "Auto ON" : "Auto OFF"}
          </button>
          <button onClick={loadStatus} className="px-3 py-1 bg-gray-800 hover:bg-gray-700 rounded text-xs">Refresh</button>
        </div>
      </div>

      {/* Stats */}
      {status && (
        <div className="grid grid-cols-4 gap-px bg-gray-800 border-b border-gray-800">
          {[
            { label: "Total P&L", value: `$${status.stats.totalPnl.toFixed(2)}`, color: status.stats.totalPnl >= 0 ? "text-green-400" : "text-red-400" },
            { label: "Win Rate", value: `${(status.stats.winRate * 100).toFixed(0)}%`, color: "text-white" },
            { label: "Open", value: status.stats.openPositions, color: "text-white" },
            { label: "Cycles", value: status.stats.totalCycles, color: "text-white" },
          ].map((s) => (
            <div key={s.label} className="bg-gray-950 px-6 py-3">
              <div className="text-gray-500 text-xs">{s.label}</div>
              <div className={`font-bold text-lg ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-6 mt-4 bg-red-900/30 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm flex justify-between">
          {error}
          <button onClick={() => setError("")}>✕</button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gray-800 px-6">
        {(["trading", "positions", "strategy", "system"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-3 text-sm font-medium capitalize border-b-2 transition-colors ${tab === t ? "border-blue-500 text-blue-400" : "border-transparent text-gray-400 hover:text-white"}`}
          >
            {t}
            {t === "positions" && openPositions.length > 0 && (
              <span className="ml-1 bg-blue-600 text-white text-xs rounded-full px-1.5">{openPositions.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="p-6">
        {/* Trading Tab */}
        {tab === "trading" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <button
                onClick={runCycle}
                disabled={cycling}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
              >
                {cycling ? "Running..." : "▶ Run Cycle"}
              </button>
              {status?.config && (
                <div className="flex gap-2">
                  <button
                    onClick={() => updateConfig({ buyEnabled: !status.config.buyEnabled })}
                    className={`px-3 py-1 rounded text-xs font-medium ${status.config.buyEnabled ? "bg-green-700" : "bg-gray-700"}`}
                  >
                    Buy {status.config.buyEnabled ? "ON" : "OFF"}
                  </button>
                  <button
                    onClick={() => updateConfig({ sellEnabled: !status.config.sellEnabled })}
                    className={`px-3 py-1 rounded text-xs font-medium ${status.config.sellEnabled ? "bg-green-700" : "bg-gray-700"}`}
                  >
                    Sell {status.config.sellEnabled ? "ON" : "OFF"}
                  </button>
                </div>
              )}
            </div>
            <div
              ref={logRef}
              className="bg-gray-900 border border-gray-800 rounded-lg p-4 h-80 overflow-y-auto font-mono text-xs text-gray-300 space-y-1"
            >
              {cycleLog.length === 0 ? (
                <div className="text-gray-600">Run a cycle to see live logs...</div>
              ) : (
                cycleLog.map((log, i) => (
                  <div
                    key={i}
                    className={
                      log.includes("❌") ? "text-red-400" :
                      log.includes("✅") ? "text-green-400" :
                      log.includes("[buy]") ? "text-blue-400" :
                      log.includes("[sell]") ? "text-yellow-400" :
                      "text-gray-300"
                    }
                  >
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Positions Tab */}
        {tab === "positions" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-sm font-medium text-gray-400 mb-3">Open Positions ({openPositions.length})</h2>
              {openPositions.length === 0 ? (
                <div className="text-gray-600 text-sm">No open positions</div>
              ) : (
                <div className="space-y-2">
                  {openPositions.map((pos) => {
                    const unrealized = (pos.lastFairPrice - pos.entryPrice) * pos.shares;
                    const pct = ((pos.lastFairPrice - pos.entryPrice) / pos.entryPrice) * 100;
                    const progress = Math.min(100, Math.max(0, ((pos.lastFairPrice - pos.entryPrice) / (pos.targetPrice - pos.entryPrice)) * 100));
                    return (
                      <div key={pos.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${pos.side === "YES" ? "bg-green-900 text-green-300" : "bg-red-900 text-red-300"}`}>
                                {pos.side}
                              </span>
                              <span className="text-sm font-medium truncate">{pos.question || pos.slug}</span>
                            </div>
                            <div className="flex gap-4 text-xs text-gray-400">
                              <span>Entry: {pos.entryPrice.toFixed(3)}</span>
                              <span>Fair: {pos.lastFairPrice.toFixed(3)}</span>
                              <span>Target: {pos.targetPrice.toFixed(3)}</span>
                              <span>AI: {(pos.aiProbability * 100).toFixed(0)}%</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 ml-4">
                            <div className="text-right">
                              <div className={`text-sm font-bold ${unrealized >= 0 ? "text-green-400" : "text-red-400"}`}>
                                {unrealized >= 0 ? "+" : ""}{unrealized.toFixed(2)}
                              </div>
                              <div className={`text-xs ${pct >= 0 ? "text-green-500" : "text-red-500"}`}>
                                {pct >= 0 ? "+" : ""}{pct.toFixed(1)}%
                              </div>
                            </div>
                            <button
                              onClick={() => forceSell(pos.id)}
                              className="px-2 py-1 bg-red-900/50 hover:bg-red-900 border border-red-800 rounded text-xs text-red-300"
                            >
                              Sell
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 h-1 bg-gray-800 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${progress}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {closedPositions.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-gray-400 mb-3">Recent Closed ({closedPositions.length})</h2>
                <div className="space-y-2">
                  {closedPositions.slice(0, 10).map((pos) => (
                    <div key={pos.id} className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${pos.side === "YES" ? "bg-green-900 text-green-300" : "bg-red-900 text-red-300"}`}>
                            {pos.side}
                          </span>
                          <span className="text-sm truncate max-w-xs">{pos.slug}</span>
                        </div>
                        <div className="text-xs text-gray-500">{pos.sellReason} · {pos.soldAt ? new Date(pos.soldAt).toLocaleDateString() : ""}</div>
                      </div>
                      <div className={`text-sm font-bold ${(pos.pnl ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {(pos.pnl ?? 0) >= 0 ? "+" : ""}${(pos.pnl ?? 0).toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Strategy Tab */}
        {tab === "strategy" && status?.config && (
          <div className="space-y-6 max-w-lg">
            <div>
              <h2 className="text-sm font-medium text-gray-400 mb-3">Presets</h2>
              <div className="flex gap-2">
                {["conservative", "balanced", "aggressive"].map((preset) => (
                  <button
                    key={preset}
                    onClick={() => applyPreset(preset)}
                    className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm capitalize"
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-4">
              {[
                { label: "Min Edge", key: "minEdge", step: 0.01, max: 0.5, pct: true },
                { label: "Bet Size % of Balance", key: "betSizePct", step: 0.01, max: 0.5, pct: true },
                { label: "Edge Capture Ratio", key: "edgeCaptureRatio", step: 0.05, max: 1, pct: true },
                { label: "Max Positions", key: "maxPositions", step: 1, max: 20, pct: false },
                { label: "Max Bets Per Cycle", key: "maxBetsPerCycle", step: 1, max: 10, pct: false },
                { label: "Stop Loss %", key: "stopLossPct", step: 0.05, max: 1, pct: true },
                { label: "Max Hold Days", key: "maxHoldDays", step: 1, max: 90, pct: false },
                { label: "Scan Interval (min)", key: "scanIntervalMin", step: 1, max: 60, pct: false },
              ].map(({ label, key, step, max, pct }) => (
                <div key={key} className="flex items-center justify-between">
                  <label className="text-sm text-gray-300">{label}</label>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400 text-sm w-12 text-right">
                      {pct ? `${((status.config as unknown as Record<string, number>)[key] * 100).toFixed(0)}%` : (status.config as unknown as Record<string, number>)[key]}
                    </span>
                    <input
                      type="range"
                      min={step}
                      max={max}
                      step={step}
                      value={(status.config as unknown as Record<string, number>)[key]}
                      onChange={(e) => updateConfig({ [key]: parseFloat(e.target.value) } as Partial<Config>)}
                      className="w-32 accent-blue-500"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* System Tab */}
        {tab === "system" && (
          <div className="space-y-6 max-w-lg">
            <div>
              <h2 className="text-sm font-medium text-gray-400 mb-3">Health Checks</h2>
              <div className="space-y-2">
                {status?.health.checks && Object.entries(status.health.checks).map(([key, check]) => (
                  <div key={key} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${check.ok ? "bg-green-400" : "bg-red-400"}`} />
                      <span className="text-sm capitalize">{key.replace(/_/g, " ")}</span>
                    </div>
                    <span className="text-xs text-gray-400">{check.message}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h2 className="text-sm font-medium text-gray-400 mb-3">Actions</h2>
              <div className="space-y-2">
                <button
                  onClick={async () => { await api.post("status", { action: "force_release_lock" }); await loadStatus(); }}
                  className="w-full px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-left"
                >
                  🔓 Force Release Cycle Lock
                </button>
                <button
                  onClick={async () => { await api.post("status", { action: "rederive_creds" }); await loadStatus(); }}
                  className="w-full px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-left"
                >
                  🔑 Re-derive API Credentials
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}