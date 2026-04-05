import type { Context } from "@netlify/functions";
import { createJob, getJob } from "../../src/lib/bot/store";

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

export default async function handler(req: Request, _context: Context) {
  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    try {
      const jobId = `cycle_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await createJob(jobId);

      const siteUrl =
        process.env.URL ||
        process.env.DEPLOY_URL ||
        process.env.NETLIFY_SITE_URL ||
        `https://dapper-snickerdoodle-dda1b6.netlify.app`;

      const bgUrl = `${siteUrl}/.netlify/functions/bot-cycle-background`;
      console.log(`[cycle] Dispatching job ${jobId} to ${bgUrl}`);

      fetch(bgUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": process.env.ADMIN_SECRET ?? "",
        },
        body: JSON.stringify({ jobId }),
      }).catch((err) => {
        console.error("[cycle] Failed to invoke background fn:", err);
      });

      return new Response(
        JSON.stringify({ ok: true, jobId, message: "Cycle dispatched" }),
        { status: 202, headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  if (req.method === "GET") {
    try {
      const url = new URL(req.url);
      const jobId = url.searchParams.get("jobId");

      if (!jobId) {
        return new Response(JSON.stringify({ error: "jobId required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
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
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}