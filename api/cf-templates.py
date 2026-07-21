"""Vercel Python serverless function — Cash Flow Treasury Tool, SUBMISSION TEMPLATES.

Generates the locked, pre-filled coordinator workbooks for a cycle. This is the INPUT
side of the pipeline: cf-stage.py reads files coming back in, this one writes the files
going out. The engine (api/_cfengine/build_template.py) derives every workbook from
published canonical data, so what comes back next cycle matches what the DB generated.

Request:  POST application/json
  headers: Authorization: Bearer <supabase access token>   (verified before doing work)
  body:    { "version": "JUN2026-ORIG",
             "as_of_ym": 202606,
             "areas": ["Oman"] | [] ,          # [] or omitted = every area in the version
             "cycle_label": "June 2026 Cycle"  # optional, printed on the letterhead
             "list": true }                    # optional: return the area list only

Response:
  list mode        -> application/json  { areas: [...] }
  one area         -> .xlsx bytes,  Content-Disposition: attachment
  many areas       -> .zip bytes,   one workbook per area

NOTHING is written to the database — this endpoint is read-only by construction.

Env required (Vercel project settings — Production scope):
  SUPABASE_SERVICE_ROLE_KEY. SUPABASE_URL optional (defaults to the public project URL).

NOTE: /api functions do not run under plain `vite dev` (no proxy configured) — this is
only reachable on a Vercel deployment.
"""
import io
import json
import os
import sys
import zipfile
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "_cfengine"))

SUPABASE_URL = "https://twinoncujgwlvanpsnle.supabase.co"
SUPABASE_ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3aW5vbmN1"
    "amd3bHZhbnBzbmxlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxMjE5NDEsImV4cCI6MjA4MTY5Nzk0MX0."
    "H4w2c3edFA2JOhqz4oAG3f-qL0hntVXQb9mB4pjqL7I"
)

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


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
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_binary(self, data, filename, mime):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self._cors()
        self.send_header("Access-Control-Expose-Headers", "content-disposition")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        """Health check — proves the _cfengine bundle and env are actually wired.

        The POST path imports the engine only AFTER the auth gate, so a 401 tells you
        nothing about whether build_template.py shipped. This does: it imports the
        engine and confirms the service-role key is present. No data, no secrets."""
        try:
            import build_template as bt
            self._send(200, {
                "ok": True,
                "engine": "build_template",
                "template_version": bt.TEMPLATE_VERSION,
                "service_key": bool(os.environ.get("SUPABASE_SERVICE_ROLE_KEY")),
            })
        except Exception as e:
            self._send(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    def do_POST(self):
        try:
            auth = self.headers.get("Authorization", "")
            if not auth.lower().startswith("bearer "):
                return self._send(401, {"error": "missing bearer token"})
            if not _verify_bearer(auth[7:].strip()):
                return self._send(401, {"error": "invalid token"})

            length = int(self.headers.get("Content-Length", "0") or "0")
            req = json.loads(self.rfile.read(length) or b"{}") if length else {}

            import build_template as bt

            version = (req.get("version") or "").strip()
            if not version:
                return self._send(400, {"error": "version is required"})

            if req.get("list"):
                return self._send(200, {"areas": bt.list_areas(version)})

            try:
                as_of_ym = int(req.get("as_of_ym") or 0)
            except (TypeError, ValueError):
                as_of_ym = 0
            if not (200001 <= as_of_ym <= 299912) or not (1 <= as_of_ym % 100 <= 12):
                return self._send(400, {"error": "as_of_ym must be YYYYMM"})

            cycle_label = req.get("cycle_label") or None
            areas = req.get("areas") or bt.list_areas(version)
            if not areas:
                return self._send(404, {"error": f"no areas found for version {version}"})

            if len(areas) == 1:
                fn, data = bt.build_area_template(areas[0], version, as_of_ym, cycle_label)
                return self._send_binary(data, fn, XLSX_MIME)

            buf = io.BytesIO()
            failed = []
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                for area in areas:
                    try:
                        fn, data = bt.build_area_template(area, version, as_of_ym, cycle_label)
                        z.writestr(fn, data)
                    except Exception as e:
                        # One bad area must not sink the batch — record it in the zip.
                        failed.append(f"{area}: {e}")
                if failed:
                    z.writestr("_FAILED.txt", "\n".join(failed))
            return self._send_binary(
                buf.getvalue(), f"CashFlow-Templates-{as_of_ym}.zip", "application/zip")

        except Exception as e:
            return self._send(500, {"error": f"{type(e).__name__}: {e}"})
