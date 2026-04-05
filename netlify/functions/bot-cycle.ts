import type { Context } from "@netlify/functions";
import { createJob, getJob } from "../../src/lib/bot/store";

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

  // ── POST: dispatch new cycle ───────────────────────────────
  if (req.method === "POST") {
    try {
      // Generate job ID
      const jobId = `cycle_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 7)}`;

      // Store job as dispatched
      await createJob(jobId);

      // Invoke background function
      const siteUrl =
        process.env.URL ||
        process.env.DEPLOY_URL ||
        "http://localhost:8888";

      const bgUrl = `${siteUrl}/.netlify/functions/bot-cycle-background`;

      // Fire and forget — don't await
      fetch(bgUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": process.env.ADMIN_SECRET ?? "",
        },
        body: JSON.stringify({ jobId }),
      }).catch((err) => {
        console.error("[bot-cycle] Failed to invoke background fn:", err);
      });

      return new Response(
        JSON.stringify({
          ok: true,
          jobId,
          message: "Cycle dispatched",
        }),
        {
          status: 202,
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

  // ── GET: poll job status ───────────────────────────────────
  if (req.method === "GET") {
    try {
      const url = new URL(req.url);
      const jobId = url.searchParams.get("jobId");

      if (!jobId) {
        return new Response(
          JSON.stringify({ error: "jobId query param required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const job = await getJob(jobId);

      if (!job) {
        return new Response(JSON.stringify({ error: "Job not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(job), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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