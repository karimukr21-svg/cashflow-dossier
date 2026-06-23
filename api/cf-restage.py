"""Vercel Python serverless function — Cash Flow Treasury Tool, RE-PARSE in place.

POST { "run_id": "<uuid>" } -> fetch the run's stored workbook, re-run the engine
(picking up any line aliases added since the last parse), and OVERWRITE the SAME run's
staged rows + reconciliation summary — KEEPING the user's Included/Ignored sheet
selection. Used by the "Re-apply mappings" button: a mapping only changes extraction
on a re-parse, since unmatched rows are dropped at parse time.

NOTHING touches the canonical tables (Push/Publish do that). Only the open run is
rewritten in place; the run_id is unchanged.

Request:  POST application/json  { "run_id": "<uuid>" }
  headers: Authorization: Bearer <supabase access token>   (verified before doing work)
Response: application/json  { run_id, area, recon_status, recon_n_breaks, n_rows,
                             n_projects, n_unmatched_labels }

Env required (Vercel Production scope): SUPABASE_SERVICE_ROLE_KEY (the only secret).
The engine + storage helpers live in api/_cfengine/ (bundled via vercel.json).
"""
import json
import os
import sys
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


class handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
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
            raw = self.rfile.read(length) if length else b"{}"
            try:
                req = json.loads(raw or b"{}")
            except Exception:
                req = {}
            run_id = (req or {}).get("run_id")
            if not run_id:
                return self._send(400, {"error": "run_id is required"})

            import parse_cashflow as pc
            import reconcile_stage as rs
            import db

            # the run + its stored source file
            runs = db.select("cf_import_runs",
                             {"select": "run_id,status,source_file", "run_id": f"eq.{run_id}"})
            if not runs:
                return self._send(404, {"error": "run not found"})
            if runs[0].get("status") != "open":
                return self._send(409, {"error": "only an open (unassigned) run can be re-parsed"})

            file_bytes = db.storage_get(f"{run_id}.xlsx")
            if not file_bytes:
                return self._send(409, {
                    "error": "no stored source file for this run — re-upload it once "
                             "to enable Re-apply mappings"})

            fn = runs[0].get("source_file") or "upload.xlsx"
            ref = pc.load_ref()            # live-merges cf_lines + cf_line_aliases
            resolver = pc.Resolver(ref)
            res = rs.reconcile_workbook_bytes(file_bytes, fn, resolver, pc.DEFAULT_AS_OF)
            rs.restage_in_place(run_id, res, ref)

            return self._send(200, {
                "run_id": run_id,
                "area": res["area"],
                "currency": res["currency"],
                "recon_status": res["recon_status"],
                "recon_n_breaks": res["n_real_breaks"],
                "n_rows": res["n_actual"] + res["n_forecast"],
                "n_projects": res["n_projects"],
                "n_unmatched_labels": len(res["unmatched_labels"]),
            })
        except Exception as e:
            import traceback
            return self._send(500, {"error": str(e), "trace": traceback.format_exc()[-1800:]})
