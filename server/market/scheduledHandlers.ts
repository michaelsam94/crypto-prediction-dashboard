import type { Request, Response } from "express";
import { sdk } from "../_core/sdk";
import { runCycle, runRetrainAll, withJobLog } from "./jobs";

/**
 * Shared guard for `/api/scheduled/*` endpoints. Only the Manus cron identity
 * may invoke them.
 */
async function assertCron(req: Request, res: Response): Promise<boolean> {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      res.status(403).json({ error: "cron-only endpoint" });
      return false;
    }
    return true;
  } catch (error) {
    res.status(403).json({ error: "authentication failed", detail: String(error) });
    return false;
  }
}

function errorPayload(error: unknown, req: Request) {
  return {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    context: { url: req.originalUrl },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Fires shortly after every UTC 4H candle close (00/04/08/12/16/20 UTC).
 * Syncs candles, resolves the matured prediction, and publishes the new signal.
 */
export async function candleCycleHandler(req: Request, res: Response): Promise<void> {
  if (!(await assertCron(req, res))) return;
  try {
    const summary = await withJobLog("candle-cycle", () => runCycle());
    res.json({ ok: true, summary });
  } catch (error) {
    res.status(500).json(errorPayload(error, req));
  }
}

/** Daily full retrain so models keep absorbing the newest market regime. */
export async function retrainHandler(req: Request, res: Response): Promise<void> {
  if (!(await assertCron(req, res))) return;
  try {
    const results = await withJobLog("retrain-all", () => runRetrainAll());
    res.json({ ok: true, results });
  } catch (error) {
    res.status(500).json(errorPayload(error, req));
  }
}

