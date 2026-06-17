# `_cfengine` — vendored Cash Flow Treasury parser/reconciler

These files are **vendored copies** of the Phase B engine that lives in the EA repo at
`EA/projects/ccc/cashflow-treasury-tool/`. They are bundled into the `api/cf-stage.py`
Vercel Python function so an uploaded area workbook is parsed + reconciled + staged by
the **same** engine that the local CLI uses (one engine, no divergence).

| File | Source of truth | Local edits |
|------|-----------------|-------------|
| `parse_cashflow.py` | EA tool | none (faithful copy) |
| `reconcile_stage.py` | EA tool | + `reconcile_workbook_bytes()` / `_reconcile_with_wb()` — a bytes entry point so the function can load from an upload instead of a path |
| `db.py` | EA tool | reads `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the env instead of `~/.config` |
| `ref_data.json` | snapshot of `cf_lines` + `cf_line_aliases` + `gacc.projects` | regenerate with the EA `gen_ref_data_live.py` when the line catalog changes |

**Keep in sync:** if the EA parser changes, re-copy `parse_cashflow.py` and re-apply the
two `reconcile_stage.py` edits. The function requires **one** Vercel env var —
`SUPABASE_SERVICE_ROLE_KEY` (service role — staging write bypasses RLS; the caller's
bearer token is verified first). `SUPABASE_URL` is optional (defaults to the public
project URL). These are read from Vercel's project env settings, **not** from a local
`.env` or `~/.config` file.
