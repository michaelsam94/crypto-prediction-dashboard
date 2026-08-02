import { describe, expect, it } from "vitest";
import { ACCURACY_WINDOW } from "@shared/market";
import { computeAccuracy } from "../routers/market";

type Row = Parameters<typeof computeAccuracy>[0][number];

/** Build a synthetic prediction row; only the fields accuracy math reads matter. */
function row(confidence: number, outcome: "win" | "loss" | "pending", i = 0): Row {
  return {
    id: i,
    symbol: "UNIUSDC",
    targetOpenTime: i,
    basisOpenTime: i,
    direction: "LONG",
    confidence,
    probUp: confidence,
    outcome,
    basisClose: 1,
    resolvedClose: null,
    realizedChangePct: null,
    modelVersion: "test",
    createdAt: new Date(),
  } as unknown as Row;
}

describe("computeAccuracy", () => {
  it("returns null win rate when nothing has resolved", () => {
    const stats = computeAccuracy([row(0.7, "pending", 1)], 0.6);
    expect(stats.winRate).toBeNull();
    expect(stats.resolved).toBe(0);
  });

  it("ignores pending rows entirely", () => {
    const stats = computeAccuracy(
      [row(0.7, "win", 1), row(0.7, "pending", 2), row(0.7, "loss", 3)],
      0.6,
    );
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.resolved).toBe(2);
    expect(stats.winRate).toBeCloseTo(0.5, 10);
  });

  it("counts only rows at or above the confidence gate", () => {
    const stats = computeAccuracy(
      [row(0.75, "win", 1), row(0.55, "loss", 2), row(0.8, "win", 3)],
      0.7,
    );
    expect(stats.resolved).toBe(2);
    expect(stats.winRate).toBeCloseTo(1, 10);
  });

  it("treats the gate as inclusive at exactly the threshold", () => {
    const stats = computeAccuracy([row(0.6, "win", 1)], 0.6);
    expect(stats.resolved).toBe(1);
    expect(stats.winRate).toBeCloseTo(1, 10);
  });

  it("tracks all-signal accuracy separately from gated accuracy", () => {
    const stats = computeAccuracy(
      [row(0.9, "win", 1), row(0.51, "loss", 2), row(0.52, "loss", 3)],
      0.8,
    );
    expect(stats.winRate).toBeCloseTo(1, 10);
    expect(stats.resolved).toBe(1);
    expect(stats.allSignalWinRate).toBeCloseTo(1 / 3, 10);
    expect(stats.allSignalResolved).toBe(3);
  });

  it("limits the rolling window to the newest N resolved gated rows", () => {
    // 60 gated wins followed by losses; only the newest 50 should be counted.
    const rows: Row[] = [];
    for (let i = 0; i < ACCURACY_WINDOW; i++) rows.push(row(0.9, "win", i));
    for (let i = 0; i < 20; i++) rows.push(row(0.9, "loss", ACCURACY_WINDOW + i));

    const stats = computeAccuracy(rows, 0.8);
    expect(stats.resolved).toBe(ACCURACY_WINDOW);
    expect(stats.wins).toBe(ACCURACY_WINDOW);
    expect(stats.winRate).toBeCloseTo(1, 10);
  });

  it("returns a win rate of zero rather than null when every gated row lost", () => {
    const stats = computeAccuracy([row(0.9, "loss", 1), row(0.9, "loss", 2)], 0.8);
    expect(stats.winRate).toBe(0);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(2);
  });
});
