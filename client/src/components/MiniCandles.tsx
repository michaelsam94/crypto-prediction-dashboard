import { useMemo } from "react";

export type MiniCandle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

/**
 * Compact 4H candlestick chart drawn as inline SVG. Deliberately not a charting
 * library: the card only needs recent price shape, and hand-drawn rects keep the
 * grid of six cards light enough to re-render on every price tick.
 */
export function MiniCandles({
  candles,
  height = 72,
  className,
}: {
  candles: MiniCandle[];
  height?: number;
  className?: string;
}) {
  const geometry = useMemo(() => {
    if (candles.length === 0) return null;

    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const max = Math.max(...highs);
    const min = Math.min(...lows);
    const span = max - min || max * 0.01 || 1;

    // Virtual coordinate space; the SVG scales to its container via viewBox.
    const width = 100;
    const slot = width / candles.length;
    const bodyWidth = Math.max(slot * 0.62, 0.6);

    const yOf = (price: number) => ((max - price) / span) * height;

    return candles.map((c, i) => {
      const cx = i * slot + slot / 2;
      const up = c.close >= c.open;
      const bodyTop = yOf(Math.max(c.open, c.close));
      const bodyBottom = yOf(Math.min(c.open, c.close));
      return {
        key: c.openTime,
        cx,
        up,
        wickTop: yOf(c.high),
        wickBottom: yOf(c.low),
        bodyY: bodyTop,
        bodyHeight: Math.max(bodyBottom - bodyTop, 0.75),
        bodyX: cx - bodyWidth / 2,
        bodyWidth,
      };
    });
  }, [candles, height]);

  if (!geometry) {
    return (
      <div
        className={className}
        style={{ height }}
        aria-label="No candle data available"
      />
    );
  }

  return (
    <svg
      className={className}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      style={{ height, width: "100%" }}
      role="img"
      aria-label={`Recent ${candles.length} four-hour candles`}>
      {geometry.map(g => {
        const color = g.up ? "var(--long)" : "var(--short)";
        return (
          <g key={g.key}>
            <line
              x1={g.cx}
              x2={g.cx}
              y1={g.wickTop}
              y2={g.wickBottom}
              stroke={color}
              strokeWidth={0.35}
              opacity={0.75}
            />
            <rect
              x={g.bodyX}
              y={g.bodyY}
              width={g.bodyWidth}
              height={g.bodyHeight}
              fill={color}
              opacity={0.9}
            />
          </g>
        );
      })}
    </svg>
  );
}
