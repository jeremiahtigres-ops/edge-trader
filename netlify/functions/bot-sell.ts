import type { Context } from "@netlify/functions";
import { getBotState, saveBotState } from "../../src/lib/bot/store";
import { getClobClient } from "../../src/lib/bot/client";
import { fetchOrderBook } from "../../src/lib/bot/market";

// ============================================================
// AUTH
// ============================================================

function isAuthorized(req: Request): boolean {
  const secret = req.headers.get("x-admin-secret");
  const expected = process.env.ADMIN_SECRET;
  if (!secret || !expected) return false;
  if (secret.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) {
    diff |= secret.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
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

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { positionId } = body;

    if (!positionId) {
      return new Response(JSON.stringify({ error: "positionId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Find position
    const state = await getBotState();
    const pos = state.positions.find(
      (p) => p.id === positionId && p.status === "open"
    );

    if (!pos) {
      return new Response(
        JSON.stringify({ error: "Open position not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get order book for price floor
    const book = await fetchOrderBook(pos.tokenId);
    if (!book) {
      return new Response(
        JSON.stringify({ error: "Could not fetch order book" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const fairPrice = book.midpoint;
    const minPrice = fairPrice * 0.80; // Accept up to 20% slippage

    // Place FOK SELL
    const client = (await getClobClient()) as any;

    const order = await client.createMarketSellOrder({
      tokenID: pos.tokenId,
      amount: pos.shares,
      minAmountReceived: minPrice * pos.shares,
    });

    const resp = await client.postOrder(order, "FOK");

    if (!resp?.success) {
      return new Response(
        JSON.stringify({
          error: "FOK sell failed — market may be illiquid",
          fairPrice,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Update position
    const soldPrice = resp.price ? parseFloat(resp.price) : fairPrice;
    const proceeds = soldPrice * pos.shares;
    const pnl = proceeds - pos.costBasis;

    pos.status = "sold";
    pos.soldAt = new Date().toISOString();
    pos.soldPrice = soldPrice;
    pos.pnl = pnl;
    pos.sellReason = "manual";

    state.totalPnl += pnl;
    state.totalTrades++;

    await saveBotState(state);

    return new Response(
      JSON.stringify({
        ok: true,
        soldPrice,
        pnl,
        position: pos,
      }),
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