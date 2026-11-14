# Business Web Express — Growth Intelligence Engine

Discovers business opportunities, recommends the day's most valuable actions, reviews what got done, and measures
whether the business is actually growing.

**Status:** Phase 1 (app setup and multi-tenant foundation) merged and on staging. Phase 2 (discovery and scoring) merged. Phase 3 first slice (daily actions, drafts, approval, follow-ups) merged; second slice (sending and reply detection) in review.

- Plan and decisions: [`docs/growth-intelligence-discovery.md`](docs/growth-intelligence-discovery.md)
- Setting up staging: [`docs/setup.md`](docs/setup.md)
- How discovery and the Opportunity Score work: [`docs/growth-intelligence/discovery.md`](docs/growth-intelligence/discovery.md)
- Search provider comparison: [`docs/growth-intelligence/search-providers.md`](docs/growth-intelligence/search-providers.md)
- Working on the code: [`CLAUDE.md`](CLAUDE.md)

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server (needs `.dev.vars`, see `docs/setup.md`) |
| `npm run typecheck` / `npm test` | Type check / unit tests |
| `npm run test:db` | Tenant-isolation tests against a throwaway local Postgres |
| `npm run build` | Production build (`CLOUDFLARE_ENV=staging` for staging) |
| `npm run migrate:render -- <file> --split` | Render a migration for staging and production |
