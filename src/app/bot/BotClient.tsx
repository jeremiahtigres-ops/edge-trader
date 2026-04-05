"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ============================================================
// TYPES
// ============================================================

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
  soldPrice?: number;
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
  health: {
    checks: Record<string, HealthCheck>;
    healthy: boolean;
  };
  history: unknown[];
  lastCycleAt?: string;
}

interface JobStatus {
  id: string;
  status: "dispatched" | "running" | "complete" | "error";
  progress: Array<{ phase: string; message: string; timestamp: string }>;
  result?: unknown;
  error?: string;
}

// ============================================================
// API HELPERS
// ============================================================

function useApi(secret: string) {
  const headers = {
    "Content-Type": "application/json",
    "x-admin-secret": secret,
  };

  const get = async (path: string) => {
    const res = await fetch(`/api/bot/${path}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`/api/bot/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  return { get, post };
}

// ============================================================
// MAIN COMPONENT
// ============================================================

export default function BotClient() {
  const [secret, setSecret] = useState("");
  const [authed, setAuthed] = useState(false);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"trading" | "positions" | "strategy" | "system">("trading");
  const [cycleLog, setCycleLog] = useState<string[]>([]);
  const [cycling, setCycling] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const autoRef = useRef<NodeJS.Timeout | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const api = useApi(secret);

  // ── Load status ───────────────────────────────────────────
  const loadStatus = useCallback(async () => {
    if (!authed) return;
    try {
      const data = await api.get("status");
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status");
    }
  }, [authed, secret]);

  useEffect(() => {
    if (authed) {
      loadStatus();
      const interval = setInterval(loadStatus, 30000);
      return () => clearInterval(interval);
    }
  }, [authed, loadStatus]);

  // ── Auto scroll log ───────────────────────────────────────
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [cycleLog]);

  // ── Auto mode ─────────────────────────────────────────────
  useEffect(() => {
    if (autoMode && !cycling) {
      const interval = (status?.config.scanIntervalMin ?? 5) * 60 * 1000;
      autoRef.current = setInterval(() => {
        runCycle();
      }, interval);
    } else {
      if (autoRef.current) clearInterval(autoRef.current);
    }
    return () => {
      if (autoRef.current) clearInterval(autoRef.current);
    };
  }, [autoMode, cycling, status?.config.scanIntervalMin]);

  // ── Run cycle ─────────────────────────────────────────────
  const runCycle = async () => {
    if (cycling) return;
    setCycling(true);
    setCycleLog([]);
    setError("");

    try {
      const { jobId } = await api.post("cycle", {});
      setCycleLog([`[${new Date().toLocaleTimeString()}] Cycle dispatched — job: ${jobId}`]);

      // Poll for progress
      let done = false;
      while (!done) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const job: JobStatus = await api.get(`cycle?jobId=${jobId}`);

          const newLogs = job.progress.map(
            (p) =>
              `[${new Date(p.timestamp).toLocaleTimeString()}] [${p.phase}] ${p.message}`
          );
          setCycleLog(newLogs);

          if (job.status === "complete" || job.status === "error") {
            done = true;
            if (job.status === "error") {
              setCycleLog((prev) => [...prev, `❌ Error: ${job.error}`]);
            } else {
              setCycleLog((prev) => [...prev, `✅ Cycle complete!`]);
            }
            await loadStatus();
          }
        } catch {
          // polling error — keep trying
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cycle failed");
    } finally {
      setCycling(false);
    }
  };

  // ── Force sell ────────────────────────────────────────────
  const forceSell = async (positionId: string) => {
    if (!confirm("Force sell this position?")) return;
    try {
      await api.post("sell", { positionId });
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sell failed");
    }
  };

  // ── Update config ─────────────────────────────────────────
  const updateConfig = async (updates: Partial<Config>) => {
    try {
      await api.post("status", updates);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Config update failed");
    }
  };

  // ── Apply preset ──────────────────────────────────────────
  const applyPreset = async (preset: string) => {
    if (!confirm(`Apply ${preset} preset?`)) return;
    try {
      await api.post("status", { preset });
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preset failed");
    }
  };

  // ── LOGIN SCREEN ──────────────────────────────────────────
  if (!authed) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-xl font-bold text-white mb-2">Edge Trader Bot</h1>
          <p className="text-gray-400 text-sm mb-6">Enter your admin secret to continue</p>
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

  // ── MAIN DASHBOARD ────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${status?.health.healthy ? "bg-green-400" : "bg-red-400"}`} />
          <h1 className="font-bold text-lg">Edge Trader Bot</h1>
          {status?.lastCycleAt && (
            <span className="text-gray-500 text-xs">
              Last cycle: {new Date(status.lastCycleAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setAutoMode(!autoMode)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              autoMode
                ? "bg-green-600 hover:bg-green-700"
                : "bg-gray-800 hover:bg-gray-700"
            }`}
          >
            {autoMode ? "Auto ON" : "Auto OFF"}
          </button>
          <button
            onClick={loadStatus}
            className="px-3 py-1 bg-gray-800 hover:bg-gray-700 rounded text-xs transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Stats Bar */}
      {status && (
        <div className="grid grid-cols-4 gap-px bg-gray-800 border-b border-gray-800">
          {[
            { label: "Total P&L", value: `$${status.stats.totalPnl.toFixed(2)}`, color: status.stats.totalPnl >= 0 ? "text-green-400" : "text-red-400" },
            { label: "Win Rate", value: `${(status.stats.winRate * 100).toFixed(0)}%`, color: "text-white" },
            { label: "Open Positions", value: status.stats.openPositions, color: "text-white" },
            { label: "Total Cycles", value: status.stats.totalCycles, color: "text-white" },
          ].map((stat) => (
            <div key={stat.label} className="bg-gray-950 px-6 py-3">
              <div className="text-gray-500 text-xs">{stat.label}</div>
              <div className={`font-bold text-lg ${stat.color}`}>{stat.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-6 mt-4 bg-red-900/30 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm flex justify-between">
          {error}
          <button onClick={() => setError("")} className="text-red-400 hover:text-red-200">✕</button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gray-800 px-6">
        {(["trading", "positions", "strategy", "system"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-3 text-sm font-medium capitalize transition-colors border-b-2 ${
              tab === t
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-gray-400 hover:text-white"
            }`}
          >
            {t}
            {t === "positions" && openPositions.length > 0 && (
              <span className="ml-1 bg-blue-600 text-white text-xs rounded-full px-1.5">
                {openPositions.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="p-6">
        {/* ── TRADING TAB ── */}
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
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      status.config.buyEnabled
                        ? "bg-green-700 hover:bg-green-800"
                        : "bg-gray-700 hover:bg-gray-600"
                    }`}
                  >
                    Buy {status.config.buyEnabled ? "ON" : "OFF"}
                  </button>
                  <button
                    onClick={() => updateConfig({ sellEnabled: !status.config.sellEnabled })}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      status.config.sellEnabled
                        ? "bg-green-700 hover:bg-green-800"
                        : "bg-gray-700 hover:bg-gray-600"
                    }`}
                  >
                    Sell {status.config.sellEnabled ? "ON" : "OFF"}
                  </button>
                </div>
              )}
            </div>

            {/* Cycle Log */}
            <div
              ref={logRef}
              className="bg-gray-900 border border-gray-800 rounded-lg p-4 h-80 overflow-y-auto font-mono text-xs text-gray-300 space-y-1"
            >
              {cycleLog.length === 0 ? (
                <div className="text-gray-600">Run a cycle to see live logs...</div>
              ) : (
                cycleLog.map((log, i) => (
                  <div key={i} className={
                    log.includes("❌") ? "text-red-400" :
                    log.includes("✅") ? "text-green-400" :
                    log.includes("[buy]") ? "text-blue-400" :
                    log.includes("[sell]") ? "text-yellow-400" :
                    "text-gray-300"
                  }>
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ── POSITIONS TAB ── */}
        {tab === "positions" && (
          <div className="space-y-6">
            {/* Open Positions */}
            <div>
              <h2 className="text-sm font-medium text-gray-400 mb-3">
                Open Positions ({openPositions.length})
              </h2>
              {openPositions.length === 0 ? (
                <div className="text-gray-600 text-sm">No open positions</div>
              ) : (
                <div className="space-y-2">
                  {openPositions.map((pos) => {
                    const unrealized = (pos.lastFairPrice - pos.entryPrice) * pos.shares;
                    const pct = ((pos.lastFairPrice - pos.entryPrice) / pos.entryPrice) * 100;
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
                              className="px-2 py-1 bg-red-900/50 hover:bg-red-900 border border-red-800 rounded text-xs text-red-300 transition-colors"
                            >
                              Sell
                            </button>
                          </div>
                        </div>
                        {/* Progress bar */}
                        <div className="mt-2 h-1 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all"
                            style={{
                              width: `${Math.min(100, Math.max(0, ((pos.lastFairPrice - pos.entryPrice) / (pos.targetPrice - pos.entryPrice)) * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Closed Positions */}
            {closedPositions.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-gray-400 mb-3">
                  Recent Closed ({closedPositions.length})
                </h2>
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
                        <div className="text-xs text-gray-500">
                          {pos.sellReason} · {pos.soldAt ? new Date(pos.soldAt).toLocaleDateString() : ""}
                        </div>
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