/**
 * Minimal gradient-boosted decision-tree classifier (logistic loss), written in
 * plain TypeScript so it can train and score inside the web server without any
 * native dependency.
 *
 * Design notes:
 * - Regression trees fit the negative gradient of log-loss (Friedman's GBM).
 * - Row subsampling + feature subsampling per tree act as regularization and
 *   give the ensemble some of the variance reduction of a random forest.
 * - Split search uses per-feature quantile bins, keeping training O(bins) per
 *   node instead of O(n log n) sorting at every node.
 */

export type TreeNode =
  | { leaf: true; value: number }
  | { leaf: false; f: number; t: number; l: TreeNode; r: TreeNode };

export type GbmModel = {
  kind: "gbm";
  base: number;
  learningRate: number;
  trees: TreeNode[];
  featureCount: number;
};

export type TrainOptions = {
  trees?: number;
  depth?: number;
  learningRate?: number;
  minSamplesLeaf?: number;
  subsample?: number;
  featureFraction?: number;
  bins?: number;
  seed?: number;
  l2?: number;
};

/** Deterministic PRNG so retraining on identical data is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

function quantileThresholds(column: number[], bins: number): number[] {
  const sorted = column.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (let b = 1; b < bins; b++) {
    const idx = Math.floor((b / bins) * (sorted.length - 1));
    const v = sorted[idx];
    if (out.length === 0 || v > out[out.length - 1]) out.push(v);
  }
  return out;
}

type SplitCandidate = { feature: number; threshold: number; gain: number };

function bestSplit(
  X: number[][],
  gradients: number[],
  hessians: number[],
  indices: number[],
  featureSubset: number[],
  thresholds: number[][],
  minSamplesLeaf: number,
  l2: number,
): SplitCandidate | null {
  let gSum = 0;
  let hSum = 0;
  for (const i of indices) {
    gSum += gradients[i];
    hSum += hessians[i];
  }
  const parentScore = (gSum * gSum) / (hSum + l2);

  let best: SplitCandidate | null = null;

  for (const f of featureSubset) {
    const cuts = thresholds[f];
    if (!cuts || cuts.length === 0) continue;

    for (const t of cuts) {
      let gl = 0;
      let hl = 0;
      let nl = 0;
      for (const i of indices) {
        if (X[i][f] <= t) {
          gl += gradients[i];
          hl += hessians[i];
          nl++;
        }
      }
      const nr = indices.length - nl;
      if (nl < minSamplesLeaf || nr < minSamplesLeaf) continue;

      const gr = gSum - gl;
      const hr = hSum - hl;
      const gain =
        (gl * gl) / (hl + l2) + (gr * gr) / (hr + l2) - parentScore;

      if (gain > 1e-9 && (!best || gain > best.gain)) {
        best = { feature: f, threshold: t, gain };
      }
    }
  }
  return best;
}

function leafValue(gradients: number[], hessians: number[], indices: number[], l2: number): number {
  let g = 0;
  let h = 0;
  for (const i of indices) {
    g += gradients[i];
    h += hessians[i];
  }
  // Newton step for logistic loss; clipped to keep single trees from dominating.
  const v = -g / (h + l2);
  return Math.max(-4, Math.min(4, v));
}

function buildTree(
  X: number[][],
  gradients: number[],
  hessians: number[],
  indices: number[],
  depth: number,
  opts: Required<Pick<TrainOptions, "depth" | "minSamplesLeaf" | "l2">>,
  featureSubset: number[],
  thresholds: number[][],
): TreeNode {
  if (depth >= opts.depth || indices.length < opts.minSamplesLeaf * 2) {
    return { leaf: true, value: leafValue(gradients, hessians, indices, opts.l2) };
  }

  const split = bestSplit(
    X,
    gradients,
    hessians,
    indices,
    featureSubset,
    thresholds,
    opts.minSamplesLeaf,
    opts.l2,
  );
  if (!split) {
    return { leaf: true, value: leafValue(gradients, hessians, indices, opts.l2) };
  }

  const left: number[] = [];
  const right: number[] = [];
  for (const i of indices) {
    if (X[i][split.feature] <= split.threshold) left.push(i);
    else right.push(i);
  }

  return {
    leaf: false,
    f: split.feature,
    t: split.threshold,
    l: buildTree(X, gradients, hessians, left, depth + 1, opts, featureSubset, thresholds),
    r: buildTree(X, gradients, hessians, right, depth + 1, opts, featureSubset, thresholds),
  };
}

function predictTree(node: TreeNode, x: number[]): number {
  let cur = node;
  while (!cur.leaf) {
    cur = x[cur.f] <= cur.t ? cur.l : cur.r;
  }
  return cur.value;
}

/** Train a GBM classifier on binary labels (0/1). */
export function trainGbm(X: number[][], y: number[], options: TrainOptions = {}): GbmModel {
  const trees = options.trees ?? 120;
  const depth = options.depth ?? 3;
  const learningRate = options.learningRate ?? 0.06;
  const minSamplesLeaf = options.minSamplesLeaf ?? 20;
  const subsample = options.subsample ?? 0.8;
  const featureFraction = options.featureFraction ?? 0.7;
  const bins = options.bins ?? 24;
  const l2 = options.l2 ?? 1.5;
  const rand = mulberry32(options.seed ?? 20260101);

  const n = X.length;
  const featureCount = n > 0 ? X[0].length : 0;
  if (n === 0 || featureCount === 0) {
    return { kind: "gbm", base: 0, learningRate, trees: [], featureCount };
  }

  const positives = y.reduce((a, b) => a + b, 0);
  const p0 = Math.min(0.95, Math.max(0.05, positives / n));
  const base = Math.log(p0 / (1 - p0));

  // Precompute candidate thresholds per feature once.
  const thresholds: number[][] = [];
  for (let f = 0; f < featureCount; f++) {
    thresholds.push(quantileThresholds(X.map(row => row[f]), bins));
  }

  const scores = new Array<number>(n).fill(base);
  const ensemble: TreeNode[] = [];

  for (let t = 0; t < trees; t++) {
    const gradients = new Array<number>(n);
    const hessians = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const p = sigmoid(scores[i]);
      gradients[i] = p - y[i];
      hessians[i] = Math.max(p * (1 - p), 1e-6);
    }

    const rowIndices: number[] = [];
    for (let i = 0; i < n; i++) if (rand() < subsample) rowIndices.push(i);
    if (rowIndices.length < minSamplesLeaf * 2) continue;

    const featureSubset: number[] = [];
    for (let f = 0; f < featureCount; f++) if (rand() < featureFraction) featureSubset.push(f);
    if (featureSubset.length === 0) featureSubset.push(Math.floor(rand() * featureCount));

    const tree = buildTree(
      X,
      gradients,
      hessians,
      rowIndices,
      0,
      { depth, minSamplesLeaf, l2 },
      featureSubset,
      thresholds,
    );
    ensemble.push(tree);

    for (let i = 0; i < n; i++) scores[i] += learningRate * predictTree(tree, X[i]);
  }

  return { kind: "gbm", base, learningRate, trees: ensemble, featureCount };
}

/** Raw logit for a single feature vector. */
export function gbmLogit(model: GbmModel, x: number[]): number {
  let s = model.base;
  for (const tree of model.trees) s += model.learningRate * predictTree(tree, x);
  return s;
}

/** Probability that the label is 1 (next candle closes up). */
export function gbmPredictProba(model: GbmModel, x: number[]): number {
  return sigmoid(gbmLogit(model, x));
}

