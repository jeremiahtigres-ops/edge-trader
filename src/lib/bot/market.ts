import type { TradingMarketInfo } from "./types";

const GAMMA_API = "https://gamma-api.polymarket.com";

// ============================================================
// SLUG RESOLUTION
// ============================================================

// Slug format: "event-slug--market-slug"
// Example: "us-cuba-invasion--will-the-us-invade-cuba-in-2026"

export async function fetchTradingInfo(
  slug: string
): Promise<TradingMarketInfo | null> {
  try {
    // Try split on "--" first
    const parts = slug.split("--");
    
    if (parts.length >= 2) {
      // Standard format: event--market
      const eventSlug = parts[0];
      const marketSlug = parts.slice(1).join("--");
      const result = await fetchByEventAndMarket(eventSlug, marketSlug);
      if (result) return result;
    }

    // Fallback: try direct market lookup
    return await fetchByMarketSlug(slug);
  } catch (err) {
    console.error(`[market] fetchTradingInfo error for ${slug}:`, err);
    return null;
  }
}

async function fetchByEventAndMarket(
  eventSlug: string,
  marketSlug: string
): Promise<TradingMarketInfo | null> {
  const url = `${GAMMA_API}/events?slug=${encodeURIComponent(eventSlug)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const events = await res.json();
  if (!Array.isArray(events) || events.length === 0) return null;
  const event = events[0];
  const market = (event.markets ?? []).find(
    (m: { slug: string }) => m.slug === marketSlug
  );
  if (!market) return null;
  return parseMarketTokens(market);
}

async function fetchByMarketSlug(
  slug: string
): Promise<TradingMarketInfo | null> {
  // Try fetching directly as market slug
  const url = `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const markets = await res.json();
  const list = Array.isArray(markets) ? markets : markets?.markets ?? [];
  if (list.length === 0) return null;
  return parseMarketTokens(list[0]);
}

function parseMarketTokens(market: any): TradingMarketInfo | null {
  let tokenIds: string[] = [];
  try {
    if (typeof market.clobTokenIds === "string") {
      tokenIds = JSON.parse(market.clobTokenIds);
    } else if (Array.isArray(market.clobTokenIds)) {
      tokenIds = market.clobTokenIds;
    }
  } catch {
    return null;
  }
  if (tokenIds.length < 2) return null;
  return {
    yesTokenId: tokenIds[0],
    noTokenId: tokenIds[1],
    negRisk: market.negRisk ?? false,
    active: market.active ?? true,
  };
}

// ============================================================
// ORDER BOOK HELPERS
// ============================================================

export interface OrderBookInfo {
  bestBid: number;
  bestAsk: number;
  midpoint: number;
  tickSize: number;
}

export async function fetchOrderBook(
  tokenId: string
): Promise<OrderBookInfo | null> {
  try {
    const client = await import("./client").then((m) => m.getClobClient());
    const c = client as any;

    const [book, tickSize] = await Promise.all([
      c.getOrderBook(tokenId),
      c.getTickSize(tokenId).catch(() => 0.01),
    ]);

    const bids: Array<{ price: string }> = book?.bids ?? [];
    const asks: Array<{ price: string }> = book?.asks ?? [];

    const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;
    const midpoint = (bestBid + bestAsk) / 2;

    return {
      bestBid,
      bestAsk,
      midpoint,
      tickSize: parseFloat(tickSize) || 0.01,
    };
  } catch (err) {
    console.error(`[market] fetchOrderBook error for ${tokenId}:`, err);
    return null;
  }
}

// ============================================================
// FAIR PRICE (midpoint of order book)
// ============================================================

export async function getFairPrice(tokenId: string): Promise<number | null> {
  const book = await fetchOrderBook(tokenId);
  return book ? book.midpoint : null;
}