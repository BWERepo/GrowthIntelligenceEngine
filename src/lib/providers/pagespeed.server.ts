// Google PageSpeed Insights (free with an API key): a verified, third-party
// measurement of a prospect's existing website, used for prospecting signals.
import { z } from "zod";
import { ProviderError } from "./search/types";

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

const Psi = z.object({
  lighthouseResult: z.object({
    fetchTime: z.string().optional(),
    categories: z.record(z.string(), z.object({ score: z.number().nullable() })).default({}),
    audits: z
      .record(z.string(), z.object({ numericValue: z.number().optional(), displayValue: z.string().optional() }))
      .default({}),
  }),
});

export type PageSpeedMetrics = {
  strategy: "mobile";
  performance: number | null; // 0-100
  accessibility: number | null;
  seo: number | null;
  bestPractices: number | null;
  largestContentfulPaintMs: number | null;
  cumulativeLayoutShift: number | null;
  fetchedAt: string | null;
};

export function parsePageSpeed(json: unknown): PageSpeedMetrics {
  const parsed = Psi.safeParse(json);
  if (!parsed.success) throw new ProviderError("pagespeed", null, "unexpected response shape");
  const { categories, audits, fetchTime } = parsed.data.lighthouseResult;
  const pct = (k: string) => {
    const s = categories[k]?.score;
    return typeof s === "number" ? Math.round(s * 100) : null;
  };
  const num = (k: string) => {
    const v = audits[k]?.numericValue;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  return {
    strategy: "mobile",
    performance: pct("performance"),
    accessibility: pct("accessibility"),
    seo: pct("seo"),
    bestPractices: pct("best-practices"),
    largestContentfulPaintMs: num("largest-contentful-paint"),
    cumulativeLayoutShift: num("cumulative-layout-shift"),
    fetchedAt: fetchTime ?? null,
  };
}

export async function runPageSpeed(apiKey: string, pageUrl: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<PageSpeedMetrics> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("url", pageUrl);
  url.searchParams.set("strategy", "mobile");
  for (const c of ["performance", "accessibility", "seo", "best-practices"]) url.searchParams.append("category", c);
  url.searchParams.set("key", apiKey);
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new ProviderError("pagespeed", res.status, `HTTP ${res.status}`);
  return parsePageSpeed(await res.json());
}
