# rana-v3

Rana v3 — signal hunter. Finds Baghdad businesses with marketing budget signals from social sources (Meta Ad Library, Instagram, agency portfolios). Writes qualified leads to the v2 Supabase `leads` table for Lara to contact.

## Endpoints

```
GET  /health       → service status, env check, last run
POST /run-now      → kick off a full pipeline run (async, returns run_id)
GET  /stats        → recent runs, lead counts, cost tracking
GET  /runs/:id     → status of a specific run
```

Auth: `x-rana-v3-auth: <token>` header required on POST /run-now.

## Sources

- **Source 1 (Phase 1):** Meta Ad Library — businesses running active Facebook/Instagram ads in Iraq
- **Source 2 (Phase 2):** Instagram audit — content quality + follower/engagement scoring
- **Source 3 (Phase 3):** Agency portfolio mining — clients of competing Baghdad agencies
- **Source 4 (Phase 4):** Hashtag/comment scraping

## Deployment

```bash
npm install
railway up --service rana-v3-production --detach
```

See CLAUDE.md for agent instructions and output contract.
