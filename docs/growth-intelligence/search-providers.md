# Web search provider: comparison and recommendation (Phase 2)

Decision 4 (2026-11-13): compare two or three providers with current prices and terms, and recommend one before
any signup. Prices below were checked on 2026-11-14 from the sources listed; confirm them on the provider's own page
when signing up.

## Expected use

The starter campaign plans up to **20 searches a day** (the campaign's "searches per day" limit), only on business
days, so about **440 a month**. Raising the limit to 40 gives about 880.

## Options

| | Brave Search API (Search plan) | Serper (Google results) | Google Places API, Text Search |
|---|---|---|---|
| What it is | Brave's own independent web index, official API | A third-party API that returns Google search results | Google Maps business listings |
| Price | $5 per 1,000 queries | $1.00 per 1,000 (50,000 credits for $50), down to $0.30 at volume | Website and phone fields are billed at the Enterprise rate: about $35 per 1,000 |
| Free allowance | $5 credit every month (about 1,000 queries) | 2,500 queries once, at signup | About 1,000 Enterprise calls a month |
| Our monthly cost (440 to 880 queries) | **$0**: covered by the monthly credit | $0 for the first few months, then a $50 prepaid pack that expires after 6 months | $0 to about $1 |
| Finds buying intent (posts, RFPs, "looking for a web designer") | Yes | Yes | No: listings only |
| Finds prospects (local businesses with websites) | Yes | Yes | Yes, very well |
| Terms risk | Low: its own index and published API terms. Storing results needs a custom plan; GIE stores only the result URL and title, and reads each page itself | Higher: it resells Google results, and Google's terms forbid automated querying | Low, but the Maps terms limit storing and caching content outside Maps |

## Recommendation: Brave Search API, Search plan

- It covers **both** signal types the owner asked for (buying intent and prospecting) with one adapter.
- At our volume it costs **nothing**: the $5 monthly credit covers about 1,000 queries, which is more than the
  campaign's limit allows. GIE still records each query at list price ($0.005) against the $50 cap, so the cap is
  never understated.
- It is a first-party API over the provider's own index, so there is no question about whether we may use the
  results. Serper is cheaper per query, but it sits on Google results that Google's terms do not allow to be
  collected this way.
- Google Places is a good **later** addition for prospecting (verified business listings with website and phone), but
  it cannot find buying intent, and its Enterprise fields cost about seven times more per call. The adapter interface
  (`src/lib/providers/search/types.ts`) leaves room to add it as a second provider.

## Sources

- [Brave Search API](https://brave.com/search/api/): plans, prices, free credit, rate limits, and storage rights
- [Serper pricing, 2026](https://websearchapi.space/blog/serper-pricing): prepaid packs and expiry
- [What Google Places API actually costs in 2026](https://openplacesapi.com/blog/google-places-api-pricing): SKU tiers and free usage
