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
    // Split on "--" to get event slug and market slug
    const parts = slug.split("--");
    if (parts.length < 2) {
      console.warn(`[market] Invalid slug format: ${slug}`);
      return null;
    }

    const eventSlug = parts[0];
    const marketSlug = parts.slice(1).join("--");

    // Fetch event from Gamma API
    const url = `${GAMMA_API}/events?slug=${encodeURIComponent(eventSlug)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[market] Gamma API error ${res.status} for ${eventSlug}`);
      return null;
    }

    const events = await res.json();
    if (!Array.isArray(events) || events.length === 0) {
      console.warn(`[market] No event found for slug: ${eventSlug}`);
      return null;
    }

    const event = events[0];
    const markets = event.markets ?? [];

    // Find matching sub-market
    const market = markets.find(
      (m: { slug: string }) => m.slug === marketSlug
    );

    if (!market) {
      console.warn(
        `[market] No market found for slug: ${marketSlug} in event: ${eventSlug}`
      );
      // NEVER fallback to wrong market
      return null;
    }

    // Parse token IDs
    let tokenIds: string[] = [];
    try {
      if (typeof market.clobTokenIds === "string") {
        tokenIds = JSON.parse(market.clobTokenIds);
      } else if (Array.isArray(market.clobTokenIds)) {
        tokenIds = market.clobTokenIds;
      }
    } catch {
      console.warn(`[market] Failed to parse clobTokenIds for ${slug}`);
      return null;
    }

    if (tokenIds.length < 2) {
      console.warn(`[market] Not enough token IDs for ${slug}`);
      return null;
    }

    return {
      yesTokenId: tokenIds[0],
      noTokenId: tokenIds[1],
      negRisk: market.negRisk ?? false,
      active: market.active ?? true,
    };
  } catch (err) {
    console.error(`[market] fetchTradingInfo error for ${slug}:`, err);
    return null;
  }
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