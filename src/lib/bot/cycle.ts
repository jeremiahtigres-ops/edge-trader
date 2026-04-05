import type {
  BotState,
  BotPosition,
  CycleResult,
  ProgressEvent,
  CyclePhase,
  TruthMachineBet,
  PositionSide,
  SellReason,
} from "./types";
import {
  getBotState,
  saveBotState,
  acquireCycleLock,
  releaseCycleLock,
  appendCycleHistory,
} from "./store";
import { getClobClient, getUsdcBalance, reAuth } from "./client";
import { fetchTradingInfo, fetchOrderBook } from "./market";

const TRUTH_MACHINE_URL = "https://truthmachine.live";
const FOK_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const MAX_BUY_SLIPPAGE = 0.10; // 10% above market
const MIN_PRICE = 0.05;
const MAX_PRICE = 0.90;
const MAX_ANALYSIS_AGE_HOURS = 48;

// ============================================================
// PROGRESS HELPER
// ============================================================

type OnProgress = (event: ProgressEvent) => Promise<void>;

function makeProgress(
  phase: CyclePhase,
  message: string,
  data?: Record<string, unknown>
): ProgressEvent {
  return { phase, message, data, timestamp: new Date().toISOString() };
}

// ============================================================
// TRUTH MACHINE API
// ============================================================

async function fetchAIBets(): Promise<TruthMachineBet[]> {
  try {
    const res = await fetch(
      `${TRUTH_MACHINE_URL}/api/best-bets?limit=50&min_edge=0`,
      { next: { revalidate: 0 } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.markets ?? [];
  } catch {
    return [];
  }
}

async function fetchIndividualAnalysis(
  slug: string
): Promise<TruthMachineBet | null> {
  try {
    const res = await fetch(
      `${TRUTH_MACHINE_URL}/.netlify/functions/get-analysis?slug=${encodeURIComponent(slug)}`,
      { next: { revalidate: 0 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.analysis) return null;

    const side: PositionSide =
      data.analysis.yesPercent >= 50 ? "YES" : "NO";
    const aiProb = (data.analysis.yesPercent ?? 50) / 100;
    const marketPrice =
      side === "YES" ? data.yesPrice ?? 0.5 : data.noPrice ?? 0.5;
    const edge =
      side === "YES"
        ? aiProb - marketPrice
        : (1 - aiProb) - marketPrice;

    return {
      slug,
      question: data.question ?? "",
      side,
      ai_probability: aiProb,
      market_price: marketPrice,
      edge: Math.abs(edge),
      confidence: data.analysis.confidence ?? "medium",
      volume: 0,
      category: "",
      analyzed_at: data.analyzedAt ?? new Date().toISOString(),
      url: "",
    };
  } catch {
    return null;
  }
}

// ============================================================
// EDGE COMPUTATION
// ============================================================

function computeEdge(
  side: PositionSide,
  aiProbability: number,
  currentPrice: number
): number {
  if (side === "YES") {
    return aiProbability - currentPrice;
  } else {
    return (1 - aiProbability) - currentPrice;
  }
}

// ============================================================
// POSITION SIZING
// ============================================================

function computeBetSize(state: BotState, balance: number): number {
  const { config } = state;
  let size: number;

  if (config.betSizeMode === "percent") {
    size = balance * config.betSizePct;
    size = Math.max(5, Math.min(500, size));
  } else {
    size = config.betSize;
  }

  return Math.min(size, balance);
}

// ============================================================
// STALE CHECK
// ============================================================

function isStale(analyzedAt: string): boolean {
  const age =
    (Date.now() - new Date(analyzedAt).getTime()) / (1000 * 60 * 60);
  return age > MAX_ANALYSIS_AGE_HOURS;
}

// ============================================================
// FOK COOLDOWN
// ============================================================

function cleanFokCooldowns(state: BotState): void {
  const now = Date.now();
  for (const [slug, ts] of Object.entries(state.fokCooldowns)) {
    if (now - new Date(ts).getTime() > FOK_COOLDOWN_MS) {
      delete state.fokCooldowns[slug];
    }
  }
}

function isOnCooldown(state: BotState, slug: string): boolean {
  const ts = state.fokCooldowns[slug];
  if (!ts) return false;
  return Date.now() - new Date(ts).getTime() < FOK_COOLDOWN_MS;
}

// ============================================================
// SELL POSITION
// ============================================================

async function sellPosition(
  position: BotPosition,
  reason: SellReason,
  fairPrice: number,
  client: any,
  result: CycleResult
): Promise<{ success: boolean; soldPrice: number; pnl: number }> {
  // Price floors to prevent dumping on thin books
  const floorMultipliers: Record<SellReason, number> = {
    target_hit: 0.90,
    stop_loss: 0.80,
    ai_reversal: 0.70,
    time_decay: 0.70,
    market_resolved: 0.90,
    manual: 0.70,
  };

  const minPrice = fairPrice * (floorMultipliers[reason] ?? 0.70);

  try {
    const order = await client.createMarketSellOrder({
      tokenID: position.tokenId,
      amount: position.shares,
      minAmountReceived: minPrice * position.shares,
    });

    const resp = await client.postOrder(order, "FOK");
    if (!resp?.success) {
      throw new Error("FOK sell failed");
    }

    const soldPrice = resp.price
      ? parseFloat(resp.price)
      : fairPrice;
    const proceeds = soldPrice * position.shares;
    const pnl = proceeds - position.costBasis;

    return { success: true, soldPrice, pnl };
  } catch (err) {
    console.error(`[cycle] sell error for ${position.slug}:`, err);
    return { success: false, soldPrice: 0, pnl: 0 };
  }
}

// ============================================================
// MAIN CYCLE
// ============================================================

export async function runCycle(onProgress: OnProgress): Promise<CycleResult> {
  const result: CycleResult = {
    sold: [],
    bought: [],
    reviewed: [],
    skipped: [],
    errors: [],
    balance: 0,
    openPositions: 0,
    timestamp: new Date().toISOString(),
  };

  // ── Phase 1: INIT ──────────────────────────────────────────
  await onProgress(makeProgress("init", "Acquiring cycle lock..."));

  const locked = await acquireCycleLock();
  if (!locked) {
    throw new Error("Cycle already running — lock is held");
  }

  let state: BotState;
  let client: any;

  try {
    state = await getBotState();
    const { config } = state;

    if (!config.buyEnabled && !config.sellEnabled) {
      throw new Error("Both buy and sell are disabled — nothing to do");
    }

    await onProgress(makeProgress("init", "Initializing CLOB client..."));
    try {
      client = await getClobClient();
    } catch {
      await reAuth();
      client = await getClobClient();
    }

    // ── Phase 2: BALANCE ────────────────────────────────────
    await onProgress(makeProgress("balance", "Fetching USDC balance..."));
    let balance = await getUsdcBalance();
    result.balance = balance;

    await onProgress(
      makeProgress("balance", `Balance: $${balance.toFixed(2)}`, { balance })
    );

    // Drawdown circuit breaker
    if (
      state.startingCapital > 0 &&
      state.totalPnl < -(state.startingCapital * config.maxDrawdownPct)
    ) {
      state.config.buyEnabled = false;
      await saveBotState(state);
      result.errors.push({
        message: `Drawdown circuit breaker triggered — buying disabled`,
      });
      await onProgress(
        makeProgress("error", "Drawdown limit hit — buying disabled")
      );
    }

    // Set starting capital on first run
    if (state.startingCapital === 0 && balance > 0) {
      state.startingCapital = balance;
    }

    // ── Phase 3: FETCH AI DATA ──────────────────────────────
    await onProgress(makeProgress("fetch_ai", "Fetching Truth Machine data..."));

    const bets = await fetchAIBets();
    await onProgress(
      makeProgress("fetch_ai", `Got ${bets.length} AI signals`, {
        count: bets.length,
      })
    );

    // Build lookup map
    const aiBySlug: Record<string, TruthMachineBet> = {};
    for (const bet of bets) {
      aiBySlug[bet.slug] = bet;
    }

    // Fetch individual analysis for held positions (more current)
    const openPositions = state.positions.filter((p) => p.status === "open");
    for (const pos of openPositions) {
      const individual = await fetchIndividualAnalysis(pos.slug);
      if (individual) {
        aiBySlug[pos.slug] = individual;
      }
    }

    // ── Phase 4: REVIEW POSITIONS ───────────────────────────
    if (openPositions.length > 0) {
      await onProgress(
        makeProgress(
          "review",
          `Reviewing ${openPositions.length} open positions...`
        )
      );

      for (const pos of openPositions) {
        try {
          const book = await fetchOrderBook(pos.tokenId);
          if (!book) {
            result.errors.push({
              slug: pos.slug,
              message: "Could not fetch order book",
            });
            continue;
          }

          const fairPrice = book.midpoint;
          pos.lastFairPrice = fairPrice;
          pos.lastReviewedAt = new Date().toISOString();

          const aiData = aiBySlug[pos.slug];
          const aiProb = aiData?.ai_probability ?? pos.aiProbability;
          const currentEdge = computeEdge(pos.side, aiProb, fairPrice);

          pos.aiProbability = aiProb;

          result.reviewed.push({
            slug: pos.slug,
            fairPrice,
            aiProbability: aiProb,
            edge: currentEdge,
          });

          await onProgress(
            makeProgress(
              "review",
              `${pos.slug}: fair=${fairPrice.toFixed(3)}, edge=${currentEdge.toFixed(3)}`
            )
          );

          // Target ratcheting
          if (currentEdge > pos.edge * 1.2) {
            // Edge grew — raise target
            const newTarget = fairPrice + currentEdge * state.config.edgeCaptureRatio;
            if (newTarget > pos.targetPrice) {
              pos.targetPrice = Math.min(newTarget, 0.95);
              pos.edge = currentEdge;
            }
          } else if (currentEdge < pos.edge * 0.5) {
            // Edge shrunk — lower target but never below midpoint of (entry, originalTarget)
            const floor =
              (pos.entryPrice + pos.originalTargetPrice) / 2;
            const newTarget = Math.max(
              fairPrice + currentEdge * state.config.edgeCaptureRatio,
              floor
            );
            if (newTarget < pos.targetPrice) {
              pos.targetPrice = newTarget;
              pos.edge = currentEdge;
            }
          }

          if (!state.config.sellEnabled) continue;

          let sellReason: SellReason | null = null;

          // Check exit conditions
          if (fairPrice >= 0.95) {
            sellReason = "market_resolved";
          } else if (currentEdge <= 0) {
            sellReason = "ai_reversal";
          } else if (
            fairPrice <=
            pos.entryPrice * (1 - state.config.stopLossPct)
          ) {
            sellReason = "stop_loss";
          } else if (
            (Date.now() - new Date(pos.openedAt).getTime()) /
              (1000 * 60 * 60 * 24) >
            state.config.maxHoldDays
          ) {
            sellReason = "time_decay";
          } else if (fairPrice >= pos.targetPrice) {
            sellReason = "target_hit";
          }

          if (sellReason) {
            await onProgress(
              makeProgress(
                "sell",
                `Selling ${pos.slug} — reason: ${sellReason}`
              )
            );

            const { success, soldPrice, pnl } = await sellPosition(
              pos,
              sellReason,
              fairPrice,
              client,
              result
            );

            if (success) {
              pos.status = "sold";
              pos.soldAt = new Date().toISOString();
              pos.soldPrice = soldPrice;
              pos.pnl = pnl;
              pos.sellReason = sellReason;
              state.totalPnl += pnl;
              state.totalTrades++;
              balance += soldPrice * pos.shares;

              result.sold.push({
                slug: pos.slug,
                reason: sellReason,
                pnl,
                soldPrice,
              });

              await onProgress(
                makeProgress(
                  "sell",
                  `Sold ${pos.slug} @ ${soldPrice.toFixed(3)}, PnL: $${pnl.toFixed(2)}`
                )
              );
            }
          }
        } catch (err) {
          result.errors.push({
            slug: pos.slug,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ── Phase 5: SCAN + BUY ─────────────────────────────────
    if (state.config.buyEnabled) {
      await onProgress(makeProgress("scan", "Scanning for edge opportunities..."));

      const heldSlugs = new Set(
        state.positions
          .filter((p) => p.status === "open")
          .map((p) => p.slug)
      );

      cleanFokCooldowns(state);

      // Filter candidates
      const candidates = bets.filter((bet) => {
        if (bet.edge < state.config.minEdge) return false;
        if (bet.market_price < MIN_PRICE || bet.market_price > MAX_PRICE)
          return false;
        if (isStale(bet.analyzed_at)) return false;
        if (heldSlugs.has(bet.slug)) return false;
        if (isOnCooldown(state, bet.slug)) return false;
        return true;
      });

      // Sort by edge descending
      candidates.sort((a, b) => b.edge - a.edge);

      await onProgress(
        makeProgress("scan", `Found ${candidates.length} candidates`, {
          count: candidates.length,
        })
      );

      const currentOpen = state.positions.filter(
        (p) => p.status === "open"
      ).length;
      const slotsAvailable = state.config.maxPositions - currentOpen;
      const toBuy = candidates.slice(
        0,
        Math.min(state.config.maxBetsPerCycle, slotsAvailable)
      );

      for (const bet of toBuy) {
        if (balance < 5) {
          result.skipped.push({ slug: bet.slug, reason: "Insufficient balance" });
          continue;
        }

        await onProgress(
          makeProgress(
            "buy",
            `Attempting to buy ${bet.slug} (${bet.side}, edge=${bet.edge.toFixed(3)})`
          )
        );

        try {
          // Resolve slug → token ID
          const marketInfo = await fetchTradingInfo(bet.slug);
          if (!marketInfo) {
            result.skipped.push({
              slug: bet.slug,
              reason: "Could not resolve market info",
            });
            continue;
          }

          if (!marketInfo.active) {
            result.skipped.push({ slug: bet.slug, reason: "Market not active" });
            continue;
          }

          const tokenId =
            bet.side === "YES"
              ? marketInfo.yesTokenId
              : marketInfo.noTokenId;

          // Get order book
          const book = await fetchOrderBook(tokenId);
          if (!book) {
            result.skipped.push({
              slug: bet.slug,
              reason: "Could not fetch order book",
            });
            continue;
          }

          const betSize = computeBetSize(state, balance);
          const maxPrice = Math.min(
            book.bestAsk * (1 + MAX_BUY_SLIPPAGE),
            0.99
          );

          // Place FOK BUY
          const order = await client.createMarketBuyOrder({
            tokenID: tokenId,
            amount: betSize,
            price: maxPrice,
          });

          const resp = await client.postOrder(order, "FOK");

          if (!resp?.success) {
            // FOK failed — set cooldown
            state.fokCooldowns[bet.slug] = new Date().toISOString();
            result.skipped.push({
              slug: bet.slug,
              reason: "FOK order failed — cooldown set",
            });
            await onProgress(
              makeProgress(
                "buy",
                `FOK failed for ${bet.slug} — 30min cooldown set`
              )
            );
            continue;
          }

          // Compute actual fill
          const fillPrice = resp.price
            ? parseFloat(resp.price)
            : book.bestAsk;
          const shares = betSize / fillPrice;
          const edgeAtFill = computeEdge(
            bet.side,
            bet.ai_probability,
            fillPrice
          );

          // Set target
          let targetPrice: number;
          if (edgeAtFill < 0.02) {
            // Slippage ate the edge — exit at breakeven
            targetPrice = fillPrice + 0.01;
          } else {
            targetPrice =
              fillPrice +
              edgeAtFill * state.config.edgeCaptureRatio;
          }
          targetPrice = Math.min(Math.max(targetPrice, fillPrice + 0.01), 0.95);

          // Create position
          const position: BotPosition = {
            id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            slug: bet.slug,
            question: bet.question,
            tokenId,
            side: bet.side,
            shares,
            costBasis: betSize,
            entryPrice: fillPrice,
            targetPrice,
            originalTargetPrice: targetPrice,
            aiProbability: bet.ai_probability,
            edge: edgeAtFill,
            lastFairPrice: fillPrice,
            negRisk: marketInfo.negRisk,
            status: "open",
            openedAt: new Date().toISOString(),
          };

          state.positions.push(position);
          state.totalTrades++;
          balance -= betSize;

          result.bought.push({
            slug: bet.slug,
            side: bet.side,
            shares,
            price: fillPrice,
            edge: edgeAtFill,
          });

          await onProgress(
            makeProgress(
              "buy",
              `Bought ${bet.slug} @ ${fillPrice.toFixed(3)}, target=${targetPrice.toFixed(3)}`
            )
          );
        } catch (err) {
          result.errors.push({
            slug: bet.slug,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Log skipped candidates
      for (const bet of candidates.slice(toBuy.length)) {
        result.skipped.push({
          slug: bet.slug,
          reason: "Max bets per cycle reached",
        });
      }

      // Log filtered out
      const filteredOut = bets.filter((b) => !candidates.includes(b));
      for (const bet of filteredOut.slice(0, 5)) {
        let reason = "Unknown";
        if (bet.edge < state.config.minEdge)
          reason = `Edge too low: ${bet.edge.toFixed(3)}`;
        else if (heldSlugs.has(bet.slug)) reason = "Already holding";
        else if (isOnCooldown(state, bet.slug)) reason = "FOK cooldown";
        else if (isStale(bet.analyzed_at)) reason = "Stale analysis";
        else if (
          bet.market_price < MIN_PRICE ||
          bet.market_price > MAX_PRICE
        )
          reason = `Price out of range: ${bet.market_price}`;
        result.skipped.push({ slug: bet.slug, reason });
      }
    }

    // ── Phase 6: SAVE + COMPLETE ────────────────────────────
    await onProgress(makeProgress("complete", "Saving state..."));

    // Prune old closed positions (keep last 7 days)
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    state.positions = state.positions.filter(
      (p) =>
        p.status === "open" ||
        new Date(p.soldAt ?? p.openedAt).getTime() > cutoff
    );

    // Portfolio snapshot
    const openValue = state.positions
      .filter((p) => p.status === "open")
      .reduce((sum, p) => sum + p.lastFairPrice * p.shares, 0);

    state.portfolioSnapshots.push({
      timestamp: new Date().toISOString(),
      balance,
      unrealizedValue: openValue,
      totalValue: balance + openValue,
    });

    // Keep last 500 snapshots
    if (state.portfolioSnapshots.length > 500) {
      state.portfolioSnapshots = state.portfolioSnapshots.slice(-500);
    }

    state.totalCycles++;
    state.lastCycleAt = new Date().toISOString();

    result.balance = balance;
    result.openPositions = state.positions.filter(
      (p) => p.status === "open"
    ).length;

    await saveBotState(state);
    await appendCycleHistory(result);

    await onProgress(
      makeProgress(
        "complete",
        `Cycle complete — bought: ${result.bought.length}, sold: ${result.sold.length}, balance: $${balance.toFixed(2)}`
      )
    );

    return result;
  } finally {
    await releaseCycleLock();
  }
}