# Cycle Dossier

Read-only browsable cycle view for the GACC workbench. One canonical area at a time, with primary + (optional) compare cycle, project list, area items, project drill, and a Summary tab that rolls up net contribution per area / per group.

Standalone webapp behind the Access Console (`public.app_access`, slug `cycle-dossier`) so coordinators / leadership can be granted view-only access without exposing the workbench's edit surface.

## Stack

- Vite + React 18 + TypeScript
- Supabase (`gacc` schema for live cycle data; `public.has_app_access('cycle-dossier')` for the access gate)
- Auth pattern lifted from Cyprus ROU — `RequireAuth` → `has_app_access` RPC → route gate on `/`

## Local dev

```
cp .env.example .env       # then fill VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

Sign in as a user with `public.app_users.is_super_admin = true` OR an active row in `public.app_access` for `app = 'cycle-dossier'`.

## Build sessions

- **S1** — DB row + scaffold + auth shell. Home renders placeholder when authenticated.
- **S2** — Port the existing dossier renderer (currently in `EA/projects/ccc/documents/cycle-dossier/generate.py` as baked HTML+JS) to React components. Wire live `gacc.*` queries.
- **S3** — Vercel deploy, Agora launcher tile, non-admin verify, decide fate of the static `cycle-dossier` library slug.

## Architecture notes

- All data reads from `gacc.*` schema via the user's authenticated session — RLS controls who sees what.
- No service-role key in the browser. The doc-library version of this dossier baked the data server-side; this app does live fetches.
- The 5 cycles currently in the baked version (`forecast-2026-jun-bod`, `p2026-v2-ex-ccmisr`, `p2026-v1`, `actual-2025-v1`, `f2025-dec-bod`) become "all active cycles" pulled from `gacc.cycles` at runtime. Cycle dropdowns are populated dynamically.

## Roles

`available_roles` = `['admin','viewer']`. Read-only enforcement via the schema's existing RLS — any granted access currently grants the same SELECT view. Split into SELECT-only vs full ALL policies when non-admin grants land.
