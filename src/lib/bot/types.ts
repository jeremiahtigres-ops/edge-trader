// ============================================================
// CONFIGURATION
// ============================================================

export type BetSizeMode = "fixed" | "percent";

export interface BotConfig {
  minEdge: number;
  betSize: number;
  betSizePct: number;
  betSizeMode: BetSizeMode;
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

export const DEFAULT_CONFIG: BotConfig = {
  minEdge: 0.06,
  betSize: 15,
  betSizePct: 0.05,
  betSizeMode: "percent",
  edgeCaptureRatio: 0.6,
  maxPositions: 8,
  maxBetsPerCycle: 2,
  scanIntervalMin: 5,
  stopLossPct: 0.30,
  maxHoldDays: 30,
  maxDrawdownPct: 0.40,
  buyEnabled: true,
  sellEnabled: true,
};

export const STRATEGY_PRESETS = {
  conservative: {
    minEdge: 0.10,
    betSizePct: 0.03,
    edgeCaptureRatio: 0.5,
    maxPositions: 5,
    maxBetsPerCycle: 1,
    stopLossPct: 0.20,
    maxHoldDays: 20,
    maxDrawdownPct: 0.25,
  },
  balanced: {
    minEdge: 0.06,
    betSizePct: 0.05,
    edgeCaptureRatio: 0.6,
    maxPositions: 8,
    maxBetsPerCycle: 2,
    stopLossPct: 0.30,
    maxHoldDays: 30,
    maxDrawdownPct: 0.40,
  },
  aggressive: {
    minEdge: 0.04,
    betSizePct: 0.08,
    edgeCaptureRatio: 0.7,
    maxPositions: 12,
    maxBetsPerCycle: 3,
    stopLossPct: 0.40,
    maxHoldDays: 45,
    maxDrawdownPct: 0.55,
  },
};

// ============================================================
// POSITIONS
// ============================================================

export type PositionStatus = "open" | "sold" | "expired";
export type PositionSide = "YES" | "NO";
export type SellReason =
  | "target_hit"
  | "stop_loss"
  | "ai_reversal"
  | "time_decay"
  | "market_resolved"
  | "manual";

export interface BotPosition {
  id: string;
  slug: string;
  question: string;
  tokenId: string;
  side: PositionSide;
  shares: number;
  costBasis: number;
  entryPrice: number;
  targetPrice: number;
  originalTargetPrice: number;
  aiProbability: number;
  edge: number;
  lastFairPrice: number;
  negRisk: boolean;
  status: PositionStatus;
  openedAt: string;
  lastReviewedAt?: string;
  soldAt?: string;
  soldPrice?: number;
  pnl?: number;
  sellReason?: SellReason;
}

// ============================================================
// STATE
// ============================================================

export interface PortfolioSnapshot {
  timestamp: string;
  balance: number;
  unrealizedValue: number;
  totalValue: number;
}

export interface BotState {
  positions: BotPosition[];
  config: BotConfig;
  totalCycles: number;
  totalTrades: number;
  totalPnl: number;
  startingCapital: number;
  portfolioSnapshots: PortfolioSnapshot[];
  fokCooldowns: Record<string, string>;
  lastCycleAt?: string;
  lastError?: string;
}

// ============================================================
// CYCLE RESULTS
// ============================================================

export interface CycleResult {
  sold: Array<{
    slug: string;
    reason: SellReason;
    pnl: number;
    soldPrice: number;
  }>;
  bought: Array<{
    slug: string;
    side: PositionSide;
    shares: number;
    price: number;
    edge: number;
  }>;
  reviewed: Array<{
    slug: string;
    fairPrice: number;
    aiProbability: number;
    edge: number;
  }>;
  skipped: Array<{
    slug: string;
    reason: string;
  }>;
  errors: Array<{
    slug?: string;
    message: string;
  }>;
  balance: number;
  openPositions: number;
  timestamp: string;
}

// ============================================================
// PROGRESS EVENTS (streamed to frontend)
// ============================================================

export type CyclePhase =
  | "init"
  | "balance"
  | "fetch_ai"
  | "review"
  | "scan"
  | "buy"
  | "sell"
  | "complete"
  | "error";

export interface ProgressEvent {
  phase: CyclePhase;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

// ============================================================
// TRUTH MACHINE API
// ============================================================

export interface TruthMachineBet {
  slug: string;
  question: string;
  side: PositionSide;
  ai_probability: number;
  market_price: number;
  edge: number;
  confidence: "high" | "medium" | "low";
  volume: number;
  category: string;
  analyzed_at: string;
  url: string;
}

export interface TruthMachineResponse {
  markets: TruthMachineBet[];
  count: number;
  generated_at: string;
}

// ============================================================
// MARKET INFO
// ============================================================

export interface TradingMarketInfo {
  yesTokenId: string;
  noTokenId: string;
  negRisk: boolean;
  active: boolean;
}

// ============================================================
// STORED CREDENTIALS
// ============================================================

export interface StoredCreds {
  key: string;
  secret: string;
  passphrase: string;
  derivedAt: string;
}