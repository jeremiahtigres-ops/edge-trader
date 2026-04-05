import { getStore } from "@netlify/blobs";
import type {
  BotState,
  BotConfig,
  CycleResult,
  StoredCreds,
} from "./types";
import { DEFAULT_CONFIG } from "./types";

// ============================================================
// STORE HELPERS
// ============================================================

function getBotStore() {
  return getStore({
    name: "bot",
    consistency: "strong",
  });
}

function getJobStore() {
  return getStore({
    name: "bot-jobs",
    consistency: "strong",
  });
}

// ============================================================
// DEFAULT STATE
// ============================================================

function defaultState(): BotState {
  return {
    positions: [],
    config: { ...DEFAULT_CONFIG },
    totalCycles: 0,
    totalTrades: 0,
    totalPnl: 0,
    startingCapital: 0,
    portfolioSnapshots: [],
    fokCooldowns: {},
  };
}

// ============================================================
// LOAD + SAVE STATE
// ============================================================

export async function getBotState(): Promise<BotState> {
  try {
    const store = getBotStore();
    const raw = await store.get("state", { type: "text" });
    if (!raw) return defaultState();

    const parsed = JSON.parse(raw) as Partial<BotState>;

    // Merge with defaults for forward-compatibility
    const state: BotState = {
      ...defaultState(),
      ...parsed,
      config: {
        ...DEFAULT_CONFIG,
        ...(parsed.config ?? {}),
      },
    };

    // Migration: ensure fokCooldowns exists
    if (!state.fokCooldowns) state.fokCooldowns = {};

    // Migration: ensure originalTargetPrice exists on positions
    for (const pos of state.positions) {
      if (!pos.originalTargetPrice) {
        pos.originalTargetPrice = pos.targetPrice;
      }
    }

    return state;
  } catch {
    return defaultState();
  }
}

export async function saveBotState(state: BotState): Promise<void> {
  const store = getBotStore();
  await store.set("state", JSON.stringify(state));
}

// ============================================================
// CONFIG
// ============================================================

export async function updateBotConfig(
  updates: Partial<BotConfig>
): Promise<BotState> {
  const state = await getBotState();
  state.config = { ...state.config, ...updates };
  await saveBotState(state);
  return state;
}

// ============================================================
// CYCLE LOCK
// ============================================================

const LOCK_TTL_MS = 14 * 60 * 1000; // 14 minutes

export async function acquireCycleLock(): Promise<boolean> {
  const store = getBotStore();
  try {
    const existing = await store.get("cycle-lock", { type: "text" });
    if (existing) {
      const lock = JSON.parse(existing) as { acquiredAt: string };
      const age = Date.now() - new Date(lock.acquiredAt).getTime();
      if (age < LOCK_TTL_MS) {
        return false; // Lock is held
      }
    }
    // Acquire lock
    await store.set(
      "cycle-lock",
      JSON.stringify({ acquiredAt: new Date().toISOString() })
    );
    return true;
  } catch {
    return false;
  }
}

export async function releaseCycleLock(): Promise<void> {
  const store = getBotStore();
  try {
    await store.delete("cycle-lock");
  } catch {
    // ignore
  }
}

export async function forceReleaseLock(): Promise<void> {
  return releaseCycleLock();
}

export async function isCycleLocked(): Promise<boolean> {
  const store = getBotStore();
  try {
    const existing = await store.get("cycle-lock", { type: "text" });
    if (!existing) return false;
    const lock = JSON.parse(existing) as { acquiredAt: string };
    const age = Date.now() - new Date(lock.acquiredAt).getTime();
    return age < LOCK_TTL_MS;
  } catch {
    return false;
  }
}

// ============================================================
// CYCLE HISTORY
// ============================================================

const MAX_HISTORY = 200;

export async function appendCycleHistory(result: CycleResult): Promise<void> {
  const store = getBotStore();
  try {
    const raw = await store.get("cycle-history", { type: "text" });
    const history: CycleResult[] = raw ? JSON.parse(raw) : [];
    history.unshift(result);
    if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
    await store.set("cycle-history", JSON.stringify(history));
  } catch {
    // ignore history errors
  }
}

export async function getCycleHistory(): Promise<CycleResult[]> {
  const store = getBotStore();
  try {
    const raw = await store.get("cycle-history", { type: "text" });
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// ============================================================
// CREDENTIALS
// ============================================================

export async function getStoredCreds(): Promise<StoredCreds | null> {
  const store = getBotStore();
  try {
    const raw = await store.get("api-creds", { type: "text" });
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveStoredCreds(creds: StoredCreds): Promise<void> {
  const store = getBotStore();
  await store.set("api-creds", JSON.stringify(creds));
}

export async function clearStoredCreds(): Promise<void> {
  const store = getBotStore();
  try {
    await store.delete("api-creds");
  } catch {
    // ignore
  }
}

// ============================================================
// JOB STORE (background function progress)
// ============================================================

export interface JobStatus {
  id: string;
  status: "dispatched" | "running" | "complete" | "error";
  progress: Array<{ phase: string; message: string; timestamp: string }>;
  result?: CycleResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export async function createJob(jobId: string): Promise<void> {
  const store = getJobStore();
  const job: JobStatus = {
    id: jobId,
    status: "dispatched",
    progress: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.set(jobId, JSON.stringify(job));
}

export async function getJob(jobId: string): Promise<JobStatus | null> {
  const store = getJobStore();
  try {
    const raw = await store.get(jobId, { type: "text" });
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function updateJob(
  jobId: string,
  updates: Partial<JobStatus>
): Promise<void> {
  const store = getJobStore();
  try {
    const raw = await store.get(jobId, { type: "text" });
    const job: JobStatus = raw
      ? JSON.parse(raw)
      : {
          id: jobId,
          status: "running",
          progress: [],
          createdAt: new Date().toISOString(),
        };
    const updated = { ...job, ...updates, updatedAt: new Date().toISOString() };
    await store.set(jobId, JSON.stringify(updated));
  } catch {
    // ignore
  }
}

export async function appendJobProgress(
  jobId: string,
  event: { phase: string; message: string; timestamp: string }
): Promise<void> {
  const store = getJobStore();
  try {
    const raw = await store.get(jobId, { type: "text" });
    if (!raw) return;
    const job: JobStatus = JSON.parse(raw);
    job.progress.push(event);
    job.updatedAt = new Date().toISOString();
    await store.set(jobId, JSON.stringify(job));
  } catch {
    // ignore
  }
}