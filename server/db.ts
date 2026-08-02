import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  candles,
  InsertCandle,
  InsertModel,
  InsertPrediction,
  InsertUser,
  jobRuns,
  models,
  predictions,
  users,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/* ------------------------------------------------------------------ */
/* Candles                                                             */
/* ------------------------------------------------------------------ */

/** Upsert a batch of candles. Chunked to stay well under MySQL packet limits. */
export async function upsertCandles(rows: InsertCandle[]): Promise<number> {
  const db = await getDb();
  if (!db || rows.length === 0) return 0;

  const chunkSize = 400;
  let written = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db
      .insert(candles)
      .values(chunk)
      .onDuplicateKeyUpdate({
        set: {
          closeTime: sql`values(closeTime)`,
          open: sql`values(open)`,
          high: sql`values(high)`,
          low: sql`values(low)`,
          close: sql`values(close)`,
          volume: sql`values(volume)`,
          quoteVolume: sql`values(quoteVolume)`,
          trades: sql`values(trades)`,
          takerBuyBase: sql`values(takerBuyBase)`,
        },
      });
    written += chunk.length;
  }
  return written;
}

/** Chronological candles for a symbol, optionally limited to the newest N. */
export async function getCandles(symbol: string, limit?: number) {
  const db = await getDb();
  if (!db) return [];

  if (limit === undefined) {
    return db.select().from(candles).where(eq(candles.symbol, symbol)).orderBy(asc(candles.openTime));
  }

  const newest = await db
    .select()
    .from(candles)
    .where(eq(candles.symbol, symbol))
    .orderBy(desc(candles.openTime))
    .limit(limit);
  return newest.reverse();
}

export async function getCandleCount(symbol: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(candles)
    .where(eq(candles.symbol, symbol));
  return Number(rows[0]?.count ?? 0);
}

export async function getLatestCandleOpenTime(symbol: string): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ openTime: candles.openTime })
    .from(candles)
    .where(eq(candles.symbol, symbol))
    .orderBy(desc(candles.openTime))
    .limit(1);
  return rows[0]?.openTime ?? null;
}

/* ------------------------------------------------------------------ */
/* Predictions                                                         */
/* ------------------------------------------------------------------ */

export async function upsertPredictions(rows: InsertPrediction[]): Promise<number> {
  const db = await getDb();
  if (!db || rows.length === 0) return 0;

  const chunkSize = 200;
  let written = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db
      .insert(predictions)
      .values(chunk)
      .onDuplicateKeyUpdate({
        set: {
          direction: sql`values(direction)`,
          confidence: sql`values(confidence)`,
          probUp: sql`values(probUp)`,
          basisClose: sql`values(basisClose)`,
          basisOpenTime: sql`values(basisOpenTime)`,
          modelVersion: sql`values(modelVersion)`,
          features: sql`values(features)`,
        },
      });
    written += chunk.length;
  }
  return written;
}

/** Newest predictions for a symbol, newest first. */
export async function getPredictions(symbol: string, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(predictions)
    .where(eq(predictions.symbol, symbol))
    .orderBy(desc(predictions.targetOpenTime))
    .limit(limit);
}

/** The single most recent prediction per symbol. */
export async function getLatestPredictionPerSymbol(symbols: string[]) {
  const db = await getDb();
  if (!db || symbols.length === 0) return [];
  const rows = await db
    .select()
    .from(predictions)
    .where(inArray(predictions.symbol, symbols))
    .orderBy(desc(predictions.targetOpenTime))
    .limit(symbols.length * 4);

  const seen = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!seen.has(row.symbol)) seen.set(row.symbol, row);
  }
  return Array.from(seen.values());
}

/** Predictions still awaiting an outcome, oldest first. */
export async function getPendingPredictions(limit = 500) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(predictions)
    .where(eq(predictions.outcome, "pending"))
    .orderBy(asc(predictions.targetOpenTime))
    .limit(limit);
}

export async function resolvePrediction(
  id: number,
  outcome: "win" | "loss" | "flat",
  resolvedClose: number,
  realizedChangePct: number,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(predictions)
    .set({ outcome, resolvedClose, realizedChangePct, resolvedAt: new Date() })
    .where(eq(predictions.id, id));
}

/** Delete all predictions for a symbol — used when a model is rebuilt from scratch. */
export async function deletePredictions(symbol: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(predictions).where(eq(predictions.symbol, symbol));
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

export async function upsertModel(row: InsertModel): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(models)
    .values(row)
    .onDuplicateKeyUpdate({
      set: {
        algorithm: sql`values(algorithm)`,
        modelVersion: sql`values(modelVersion)`,
        payload: sql`values(payload)`,
        trainSamples: sql`values(trainSamples)`,
        validationAccuracy: sql`values(validationAccuracy)`,
        highConfidenceAccuracy: sql`values(highConfidenceAccuracy)`,
        confidenceThreshold: sql`values(confidenceThreshold)`,
        featureNames: sql`values(featureNames)`,
        trainedThroughOpenTime: sql`values(trainedThroughOpenTime)`,
        trainedAt: new Date(),
      },
    });
}

export async function getModel(symbol: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(models).where(eq(models.symbol, symbol)).limit(1);
  return rows[0];
}

/** Model metadata for all symbols, excluding the heavy serialized payload. */
export async function getModelSummaries() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      symbol: models.symbol,
      algorithm: models.algorithm,
      modelVersion: models.modelVersion,
      trainSamples: models.trainSamples,
      validationAccuracy: models.validationAccuracy,
      highConfidenceAccuracy: models.highConfidenceAccuracy,
      confidenceThreshold: models.confidenceThreshold,
      trainedThroughOpenTime: models.trainedThroughOpenTime,
      trainedAt: models.trainedAt,
    })
    .from(models);
}

/* ------------------------------------------------------------------ */
/* Job runs                                                            */
/* ------------------------------------------------------------------ */

export async function startJobRun(job: string): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(jobRuns).values({ job, status: "running" });
  // drizzle/mysql2 surfaces the OkPacket header either directly or as element 0.
  const raw = result as unknown;
  const header = Array.isArray(raw)
    ? (raw[0] as { insertId?: number } | undefined)
    : (raw as { insertId?: number } | undefined);
  return header?.insertId ?? null;
}

export async function finishJobRun(
  id: number | null,
  status: "success" | "error",
  detail: string,
): Promise<void> {
  const db = await getDb();
  if (!db || id === null) return;
  await db
    .update(jobRuns)
    .set({ status, detail: detail.slice(0, 4000), finishedAt: new Date() })
    .where(eq(jobRuns.id, id));
}

export async function getRecentJobRuns(limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(limit);
}

export async function getLastSuccessfulRun(job: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.job, job), eq(jobRuns.status, "success")))
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  return rows[0];
}
