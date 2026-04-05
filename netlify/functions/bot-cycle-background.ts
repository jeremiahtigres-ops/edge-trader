import type { HandlerEvent, HandlerContext } from "@netlify/functions";
import { runCycle } from "../../src/lib/bot/cycle";
import {
  getJob,
  updateJob,
  appendJobProgress,
} from "../../src/lib/bot/store";
import type { ProgressEvent } from "../../src/lib/bot/types";

// ============================================================
// V1 HANDLER (required for background functions)
// ============================================================

export const handler = async (
  event: HandlerEvent,
  _context: HandlerContext
) => {
  let jobId: string | null = null;

  try {
    // Parse jobId from body
    const body = JSON.parse(event.body ?? "{}");
    jobId = body.jobId ?? null;

    if (!jobId) {
      console.error("[bg] No jobId provided");
      return { statusCode: 400 };
    }

    // Verify job exists
    const job = await getJob(jobId);
    if (!job) {
      console.error(`[bg] Job not found: ${jobId}`);
      return { statusCode: 404 };
    }

    // Mark as running
    await updateJob(jobId, { status: "running" });

    console.log(`[bg] Starting cycle for job: ${jobId}`);

    // Progress callback — streams events to blob
    const onProgress = async (event: ProgressEvent) => {
      console.log(`[bg] ${event.phase}: ${event.message}`);
      await appendJobProgress(jobId!, {
        phase: event.phase,
        message: event.message,
        timestamp: event.timestamp,
      });
    };

    // Run the cycle
    const result = await runCycle(onProgress);

    // Mark as complete
    await updateJob(jobId, {
      status: "complete",
      result,
    });

    console.log(
      `[bg] Cycle complete — bought: ${result.bought.length}, sold: ${result.sold.length}`
    );

    return { statusCode: 200 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[bg] Cycle error:`, err);

    if (jobId) {
      await updateJob(jobId, {
        status: "error",
        error: message,
      });
    }

    return { statusCode: 500 };
  }
};