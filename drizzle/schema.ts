import {
  bigint,
  double,
  index,
  int,
  longtext,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Raw 4H OHLCV candles from Binance Futures (fapi.binance.com).
 * `openTime` is the UTC candle open time in epoch milliseconds and is always a
 * multiple of the 4h interval, so candles align to 00/04/08/12/16/20 UTC.
 */
export const candles = mysqlTable(
  "candles",
  {
    id: int("id").autoincrement().primaryKey(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    openTime: bigint("openTime", { mode: "number" }).notNull(),
    closeTime: bigint("closeTime", { mode: "number" }).notNull(),
    open: double("open").notNull(),
    high: double("high").notNull(),
    low: double("low").notNull(),
    close: double("close").notNull(),
    volume: double("volume").notNull(),
    quoteVolume: double("quoteVolume").notNull(),
    trades: int("trades").notNull().default(0),
    takerBuyBase: double("takerBuyBase").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    symbolOpenTimeIdx: uniqueIndex("candles_symbol_openTime_idx").on(table.symbol, table.openTime),
    openTimeIdx: index("candles_openTime_idx").on(table.openTime),
  }),
);

export type Candle = typeof candles.$inferSelect;
export type InsertCandle = typeof candles.$inferInsert;

/**
 * One row per (symbol, target candle). `targetOpenTime` is the UTC open time of
 * the candle whose direction is being predicted. Outcome stays `pending` until
 * that candle closes and the resolver job fills it in.
 */
export const predictions = mysqlTable(
  "predictions",
  {
    id: int("id").autoincrement().primaryKey(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    /** UTC open time (ms) of the predicted candle. */
    targetOpenTime: bigint("targetOpenTime", { mode: "number" }).notNull(),
    /** UTC open time (ms) of the last closed candle used as model input. */
    basisOpenTime: bigint("basisOpenTime", { mode: "number" }).notNull(),
    direction: mysqlEnum("direction", ["LONG", "SHORT"]).notNull(),
    /** Calibrated probability of the predicted direction, 0.5 - 1.0 */
    confidence: double("confidence").notNull(),
    /** Raw model probability that the next candle closes up. */
    probUp: double("probUp").notNull(),
    /** Close price of the basis candle = entry reference price. */
    basisClose: double("basisClose").notNull(),
    outcome: mysqlEnum("outcome", ["pending", "win", "loss", "flat"]).notNull().default("pending"),
    /** Close price of the target candle once resolved. */
    resolvedClose: double("resolvedClose"),
    /** Percentage move of the target candle, signed. */
    realizedChangePct: double("realizedChangePct"),
    modelVersion: varchar("modelVersion", { length: 64 }),
    /** JSON snapshot of the feature vector for auditability. */
    features: text("features"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    resolvedAt: timestamp("resolvedAt"),
  },
  table => ({
    symbolTargetIdx: uniqueIndex("predictions_symbol_target_idx").on(table.symbol, table.targetOpenTime),
    symbolCreatedIdx: index("predictions_symbol_created_idx").on(table.symbol, table.targetOpenTime),
    outcomeIdx: index("predictions_outcome_idx").on(table.outcome),
  }),
);

export type Prediction = typeof predictions.$inferSelect;
export type InsertPrediction = typeof predictions.$inferInsert;

/**
 * Serialized per-symbol model. Holds the trained ensemble (JSON) plus the
 * walk-forward validation metrics measured at training time.
 */
export const models = mysqlTable(
  "models",
  {
    id: int("id").autoincrement().primaryKey(),
    symbol: varchar("symbol", { length: 32 }).notNull().unique(),
    algorithm: varchar("algorithm", { length: 32 }).notNull().default("gradient_boosting"),
    modelVersion: varchar("modelVersion", { length: 64 }).notNull(),
    /** Serialized ensemble of decision trees — hundreds of KB, so LONGTEXT. */
    payload: longtext("payload").notNull(),
    trainSamples: int("trainSamples").notNull().default(0),
    /** Out-of-sample accuracy from walk-forward validation on all signals. */
    validationAccuracy: double("validationAccuracy"),
    /** Out-of-sample accuracy restricted to signals above the confidence gate. */
    highConfidenceAccuracy: double("highConfidenceAccuracy"),
    /** Confidence gate chosen during training to hit the target accuracy band. */
    confidenceThreshold: double("confidenceThreshold").notNull().default(0.5),
    featureNames: text("featureNames"),
    /** UTC open time (ms) of the newest candle included in training. */
    trainedThroughOpenTime: bigint("trainedThroughOpenTime", { mode: "number" }),
    trainedAt: timestamp("trainedAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
);

export type ModelRow = typeof models.$inferSelect;
export type InsertModel = typeof models.$inferInsert;

/**
 * Audit log for every scheduled/manual pipeline run so the dashboard can show
 * when data was last refreshed and surface failures.
 */
export const jobRuns = mysqlTable(
  "job_runs",
  {
    id: int("id").autoincrement().primaryKey(),
    job: varchar("job", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["running", "success", "error"]).notNull().default("running"),
    detail: text("detail"),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    finishedAt: timestamp("finishedAt"),
  },
  table => ({
    jobStartedIdx: index("job_runs_job_started_idx").on(table.job, table.startedAt),
  }),
);

export type JobRun = typeof jobRuns.$inferSelect;
