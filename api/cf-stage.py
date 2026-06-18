"""Vercel Python serverless function — Cash Flow Treasury Tool, upload + stage.

POST an area workbook (.xlsx bytes) -> the Phase B engine parses + reconciles it to
the AREA TOTAL and writes an "open run for review" (cf_import_runs + cf_staged_rows +
cf_recon_breaks). NOTHING touches the canonical tables — Push/Publish (RPCs) do that.

Request:  POST application/octet-stream
  headers: Authorization: Bearer <supabase access token>   (verified before doing work)
           X-Filename: <url-encoded original filename>       (drives the per-file maps)
           X-As-Of:    <YYYY-MM-DD>  (optional; defaults to the engine's April-2026 cutover)
  body:    raw .xlsx bytes
Response: application/json  { run_id, area, recon_status, recon_n_breaks, n_actual_rows,
                             n_forecast_rows, n_projects, n_unmatched_labels, proposed_version }

Env required (Vercel project settings — Production scope):
  SUPABASE_SERVICE_ROLE_KEY  (the only required secret — service role, RLS-bypassing
                              staging write). SUPABASE_URL is optional (defaults to the
                              public project URL). NOTE: a function reads these from
                              Vercel's env settings, NOT from a local .env / ~/.config.

The engine lives in api/_cfengine/ (vendored from the EA tool; bundled via vercel.json
includeFiles). One engine, no divergence — the only added entry point is the bytes loader.
"""
import json
import os
import sys
import urllib.parse
import datetime as dt
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "_cfengine"))

SUPABASE_URL = "https://twinoncujgwlvanpsnle.supabase.co"
SUPABASE_ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3aW5vbmN1"
    "amd3bHZhbnBzbmxlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxMjE5NDEsImV4cCI6MjA4MTY5Nzk0MX0."
    "H4w2c3edFA2JOhqz4oAG3f-qL0hntVXQb9mB4pjqL7I"
)


def _verify_bearer(token):
    import requests
    if not token:
        return False
    try:
        r = requests.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": SUPABASE_ANON_KEY},
            timeout=15,
        )
        return r.ok
    except Exception:
        return False


def _proposed_cycle(as_of):
    """The reporting cycle an 'as_of actual' file lands in = the month after cutover."""
    if as_of.month == 12:
        return as_of.year + 1, 1
    return as_of.year, as_of.month + 1


class handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "authorization, content-type, x-filename, x-as-of, x-cycle-year, x-cycle-month")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(200, {})

    def do_POST(self):
        try:
            auth = self.headers.get("Authorization", "")
            if not auth.lower().startswith("bearer "):
                return self._send(401, {"error": "missing bearer token"})
            if not _verify_bearer(auth[7:].strip()):
                return self._send(401, {"error": "invalid token"})

            length = int(self.headers.get("Content-Length", "0") or "0")
            body = self.rfile.read(length) if length else b""
            if not body:
                return self._send(400, {"error": "empty body — expected .xlsx bytes"})

            fn = urllib.parse.unquote(self.headers.get("X-Filename", "upload.xlsx"))
            as_of_h = self.headers.get("X-As-Of")
            cy_h = self.headers.get("X-Cycle-Year")
            cm_h = self.headers.get("X-Cycle-Month")

            import parse_cashflow as pc
            import reconcile_stage as rs
            import db

            as_of = dt.date.fromisoformat(as_of_h) if as_of_h else pc.DEFAULT_AS_OF
            ref = pc.load_ref()
            resolver = pc.Resolver(ref)
            res = rs.reconcile_workbook_bytes(body, fn, resolver, as_of)

            # Cycle/version the user chose for this upload (sent by the UI). The
            # as_of above is the chosen cycle's cutover, so the actual/forecast
            # split honors the cycle, not the file. Fall back to deriving from the
            # cutover only if the headers are absent (legacy/direct callers).
            if cy_h and cm_h:
                cy, cm = int(cy_h), int(cm_h)
            else:
                cy, cm = _proposed_cycle(as_of)
            rs.PROPOSED_CYCLE = (cy, cm)
            rs.PROPOSED_VERSION = f"{cy}-{cm:02d}-PROJ"

            # idempotent re-upload: clear this area's prior OPEN runs (cascade)
            db.delete("cf_import_runs",
                      {"area": f"eq.{res['area']}", "status": "eq.open"})

            run_id = rs.stage(res, ref, created_by=f"upload:{fn}")

            return self._send(200, {
                "run_id": run_id,
                "area": res["area"],
                "currency": res["currency"],
                "recon_status": res["recon_status"],
                "recon_n_breaks": res["n_real_breaks"],
                "n_actual_rows": res["n_actual"],
                "n_forecast_rows": res["n_forecast"],
                "n_projects": res["n_projects"],
                "n_unmatched_labels": len(res["unmatched_labels"]),
                "proposed_version": rs.PROPOSED_VERSION,
            })
        except Exception as e:
            import traceback
            return self._send(500, {
                "error": str(e),
                "trace": traceback.format_exc()[-1800:],
            })
