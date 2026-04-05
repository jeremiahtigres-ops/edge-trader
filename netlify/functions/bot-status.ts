import type { Context } from "@netlify/functions";
import {
  getBotState,
  saveBotState,
  updateBotConfig,
  getCycleHistory,
  isCycleLocked,
  forceReleaseLock,
  getStoredCreds,
} from "../../src/lib/bot/store";
import { getUsdcBalance, deriveAndStoreCreds } from "../../src/lib/bot/client";
import type { BotConfig } from "../../src/lib/bot/types";
import { STRATEGY_PRESETS } from "../../src/lib/bot/types";

// ============================================================
// AUTH
// ============================================================

function isAuthorized(req: Request): boolean {
  const secret = req.headers.get("x-admin-secret");
  const expected = process.env.ADMIN_SECRET;
  if (!secret || !expected) return false;
  // Constant-time comparison
  if (secret.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) {
    diff |= secret.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// ============================================================
// HEALTH CHECK
// ============================================================

async function runHealthCheck() {
  const checks: Record<string, { ok: boolean; message: string }> = {};

  // Env vars
  checks.env_vars = {
    ok: !!(
      process.env.POLYMARKET_PRIVATE_KEY &&
      process.env.POLYMARKET_FUNDER &&
      process.env.ADMIN_SECRET
    ),
    message: process.env.POLYMARKET_PRIVATE_KEY
      ? "All required env vars present"
      : "Missing required env vars",
  };

  // API creds
  try {
    const creds = await getStoredCreds();
    checks.api_creds = {
      ok: !!creds,
      message: creds
        ? `Creds derived at ${creds.derivedAt}`
        : "No creds stored — will derive on first cycle",
    };
  } catch {
    checks.api_creds = { ok: false, message: "Failed to check creds" };
  }

  // CLOB API
  try {
    const balance = await getUsdcBalance();
    checks.clob_api = {
      ok: true,
      message: `Connected — balance: $${balance.toFixed(2)}`,
    };
    checks.usdc_balance = {
      ok: balance > 0,
      message: `$${balance.toFixed(2)} USDC`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.clob_api = { ok: false, message: `CLOB error: ${msg}` };
    checks.usdc_balance = { ok: false, message: "Could not fetch balance" };
  }

  // Truth Machine API
  try {
    const res = await fetch(
      "https://truthmachine.live/api/best-bets?limit=1&min_edge=0"
    );
    checks.truth_machine = {
      ok: res.ok,
      message: res.ok ? "Reachable" : `HTTP ${res.status}`,
    };
  } catch {
    checks.truth_machine = { ok: false, message: "Unreachable" };
  }

  // Cycle lock
  try {
    const locked = await isCycleLocked();
    checks.cycle_lock = {
      ok: true,
      message: locked ? "Locked (cycle running)" : "Unlocked",
    };
  } catch {
    checks.cycle_lock = { ok: false, message: "Could not check lock" };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return { checks, healthy: allOk };
}

// ============================================================
// STATS COMPUTATION
// ============================================================

function computeStats(state: Awaited<ReturnType<typeof getBotState>>) {
  const closed = state.positions.filter((p) => p.status === "sold");
  const open = state.positions.filter((p) => p.status === "open");

  const wins = closed.filter((p) => (p.pnl ?? 0) > 0).length;
  const winRate = closed.length > 0 ? wins / closed.length : 0;

  const unrealizedValue = open.reduce(
    (sum, p) => sum + p.lastFairPrice * p.shares,
    0
  );

  const snapshots = state.portfolioSnapshots.slice(-50);

  return {
    totalCycles: state.totalCycles,
    totalTrades: state.totalTrades,
    totalPnl: state.totalPnl,
    winRate,
    openPositions: open.length,
    closedPositions: closed.length,
    unrealizedValue,
    startingCapital: state.startingCapital,
    snapshots,
  };
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: Request, _context: Context) {
  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── GET ────────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const [state, history, health] = await Promise.all([
        getBotState(),
        getCycleHistory(),
        runHealthCheck(),
      ]);

      const stats = computeStats(state);

      return new Response(
        JSON.stringify({
          config: state.config,
          positions: state.positions,
          stats,
          health,
          history: history.slice(0, 20),
          lastCycleAt: state.lastCycleAt,
          lastError: state.lastError,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // ── POST ───────────────────────────────────────────────────
  if (req.method === "POST") {
    try {
      const body = await req.json();

      // Force release lock
      if (body.action === "force_release_lock") {
        await forceReleaseLock();
        return new Response(JSON.stringify({ ok: true, message: "Lock released" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Re-derive API credentials
      if (body.action === "rederive_creds") {
        await deriveAndStoreCreds();
        return new Response(
          JSON.stringify({ ok: true, message: "Credentials re-derived" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Edit position
      if (body.positionId) {
        const state = await getBotState();
        const pos = state.positions.find((p) => p.id === body.positionId);
        if (!pos) {
          return new Response(JSON.stringify({ error: "Position not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (body.targetPrice !== undefined) {
          pos.targetPrice = parseFloat(body.targetPrice);
        }
        if (body.status === "expired") {
          pos.status = "expired";
        }
        if (body.delete) {
          state.positions = state.positions.filter(
            (p) => p.id !== body.positionId
          );
        }

        await saveBotState(state);
        return new Response(JSON.stringify({ ok: true, position: pos }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Apply preset
      if (body.preset) {
        const preset =
          STRATEGY_PRESETS[body.preset as keyof typeof STRATEGY_PRESETS];
        if (!preset) {
          return new Response(JSON.stringify({ error: "Invalid preset" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const state = await updateBotConfig(preset);
        return new Response(
          JSON.stringify({ ok: true, config: state.config }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Update config
      const allowed: (keyof BotConfig)[] = [
        "minEdge",
        "betSize",
        "betSizePct",
        "betSizeMode",
        "edgeCaptureRatio",
        "maxPositions",
        "maxBetsPerCycle",
        "scanIntervalMin",
        "stopLossPct",
        "maxHoldDays",
        "maxDrawdownPct",
        "buyEnabled",
        "sellEnabled",
      ];

      const updates: Partial<BotConfig> = {};
      for (const key of allowed) {
        if (body[key] !== undefined) {
          (updates as any)[key] = body[key];
        }
      }

      if (Object.keys(updates).length === 0) {
        return new Response(JSON.stringify({ error: "No valid fields" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const state = await updateBotConfig(updates);
      return new Response(
        JSON.stringify({ ok: true, config: state.config }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}