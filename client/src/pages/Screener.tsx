import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { formatUtc } from "@shared/market";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";

const QUOTES = ["ALL", "USDT", "USDC"] as const;
type Quote = (typeof QUOTES)[number];

const usd = (n: number) => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};

/** Colour volatility by band: calm is the point of this page. */
function volClass(v: number | null) {
  if (v === null) return "text-muted-foreground";
  if (v < 40) return "text-[var(--long)]";
  if (v < 70) return "text-foreground";
  return "text-[var(--short)]";
}

export default function Screener() {
  const [minVolume, setMinVolume] = useState("50");
  const [maxVol, setMaxVol] = useState("80");
  const [quote, setQuote] = useState<Quote>("ALL");

  const [applied, setApplied] = useState({
    minVolumeUsd: 50_000_000,
    maxRealisedVolPct: 80,
    quote: "ALL" as Quote,
    measuredOnly: true,
    limit: 60,
  });

  const screener = trpc.market.screener.useQuery(applied, { retry: 1 });

  function apply() {
    setApplied({
      minVolumeUsd: Math.max(0, Number(minVolume) || 0) * 1_000_000,
      maxRealisedVolPct: Math.max(1, Number(maxVol) || 80),
      quote,
      measuredOnly: true,
      limit: 60,
    });
  }

  const rows = screener.data?.rows ?? [];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="container flex h-14 items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-1.5">
              <ArrowLeft className="h-4 w-4" />
              Dashboard
            </Button>
          </Link>
          <div className="h-4 w-px bg-border" />
          <h1 className="text-sm font-semibold tracking-tight">Pair Screener</h1>
          <Badge variant="outline" className="ml-auto font-mono text-[10px]">
            Binance perpetuals
          </Badge>
        </div>
      </header>

      <main className="container space-y-6 py-6">
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="vol" className="text-xs">
                Min 24h volume (USD millions)
              </Label>
              <Input
                id="vol"
                inputMode="decimal"
                value={minVolume}
                onChange={e => setMinVolume(e.target.value)}
                className="w-44 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mv" className="text-xs">
                Max realised volatility (% annual)
              </Label>
              <Input
                id="mv"
                inputMode="decimal"
                value={maxVol}
                onChange={e => setMaxVol(e.target.value)}
                className="w-44 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Quote</Label>
              <div className="flex gap-1.5">
                {QUOTES.map(q => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setQuote(q)}
                    className={`rounded-md border px-3 py-2 text-xs transition-colors ${
                      quote === q
                        ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                        : "border-border bg-[var(--panel)] hover:border-[var(--primary)]/40"
                    }`}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
            <Button onClick={apply} disabled={screener.isFetching} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${screener.isFetching ? "animate-spin" : ""}`} />
              Apply
            </Button>
          </div>

          {screener.data && (
            <p className="mt-3 text-xs text-muted-foreground">
              {screener.data.matched} of {screener.data.universeCount} perpetuals match ·
              volatility measured for {screener.data.measuredCount} most-liquid symbols · data{" "}
              {formatUtc(screener.data.generatedAt)} (cached 15 min)
            </p>
          )}
        </section>

        {screener.error && (
          <div className="rounded-lg border border-[var(--short)]/40 bg-[var(--short)]/10 p-4 text-sm text-[var(--short)]">
            {screener.error.message}
          </div>
        )}

        <section className="rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-4 py-3 text-left font-medium">#</th>
                  <th className="px-4 py-3 text-left font-medium">Pair</th>
                  <th className="px-4 py-3 text-right font-medium">24h volume</th>
                  <th className="px-4 py-3 text-right font-medium">Realised vol</th>
                  <th className="px-4 py-3 text-right font-medium">Mean 4H move</th>
                  <th className="px-4 py-3 text-right font-medium">24h range</th>
                  <th className="px-4 py-3 text-right font-medium">24h chg</th>
                  <th className="px-4 py-3 text-right font-medium">Vol / risk</th>
                </tr>
              </thead>
              <tbody>
                {screener.isPending &&
                  Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td colSpan={8} className="px-4 py-2.5">
                        <Skeleton className="h-5 w-full" />
                      </td>
                    </tr>
                  ))}
                {rows.map((r, i) => (
                  <tr
                    key={r.symbol}
                    className="border-b border-border/50 last:border-0 hover:bg-[var(--panel)]/50">
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{i + 1}</td>
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{r.symbol}</span>
                      {r.tracked && (
                        <Badge
                          variant="outline"
                          className="ml-2 border-[var(--primary)]/40 text-[10px] text-[var(--primary)]">
                          tracked
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {usd(r.quoteVolume24h)}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right font-mono tabular-nums ${volClass(
                        r.realisedVolPct,
                      )}`}>
                      {r.realisedVolPct === null ? "—" : `${r.realisedVolPct.toFixed(0)}%`}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                      {r.meanBarMovePct === null ? "—" : `${r.meanBarMovePct.toFixed(2)}%`}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                      {r.range24hPct.toFixed(1)}%
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right font-mono tabular-nums ${
                        r.priceChange24hPct >= 0 ? "text-[var(--long)]" : "text-[var(--short)]"
                      }`}>
                      {r.priceChange24hPct >= 0 ? "+" : ""}
                      {r.priceChange24hPct.toFixed(2)}%
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {r.volumePerVol === null ? "—" : usd(r.volumePerVol)}
                    </td>
                  </tr>
                ))}
                {!screener.isPending && rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No pairs match. Try lowering the volume floor or raising the volatility cap.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card/50 p-5 text-xs leading-relaxed text-muted-foreground">
          <h3 className="mb-2 text-sm font-semibold tracking-tight text-foreground">
            How to read this
          </h3>
          <ul className="list-disc space-y-1.5 pl-4">
            <li>
              <strong className="text-foreground">Realised vol</strong> is annualised from 4H log
              returns over the last ~30 days. Under 40% is calm for crypto perps; over 70% is
              violent.
            </li>
            <li>
              <strong className="text-foreground">Vol / risk</strong> is 24h volume divided by
              realised volatility — the ranking column, since &quot;liquid <em>and</em> calm&quot;
              is a trade-off rather than one number. High volume with low volatility ranks top.
            </li>
            <li>
              Volatility is measured for the 60 most liquid perpetuals plus the six tracked pairs.
              Measuring all ~500 on every page load would hit Binance rate limits, so the rest show
              &quot;—&quot; and are excluded by default.
            </li>
            <li>
              Low volatility is <strong className="text-foreground">not</strong> the same as
              profitable. Smaller moves mean the same trading cost eats a larger share of each
              trade, which raises the accuracy needed to break even. Calm pairs are easier to hold,
              not easier to profit from.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
