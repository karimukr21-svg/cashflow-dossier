"""Who may call the Treasury tool's staging API (cf-stage, cf-restage, cf-templates).

These functions write (or read) with the service-role key, which bypasses row-level security, so the caller must be
checked here first. A valid sign-in is not enough: sign-ups are open, and most accounts have no Treasury access.

Rule: the caller is signed in AND holds the tool's manage role, the same rule the front end uses for the Adjust
screens: has_app_access('cashflow-dossier') returns 'admin' (a super admin, or an admin of the tool) or 'treasury'.
has_app_access runs as the caller (their token), so it answers for them and only them.
"""
import requests

SUPABASE_URL = "https://twinoncujgwlvanpsnle.supabase.co"
SUPABASE_ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3aW5vbmN1"
    "amd3bHZhbnBzbmxlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxMjE5NDEsImV4cCI6MjA4MTY5Nzk0MX0."
    "H4w2c3edFA2JOhqz4oAG3f-qL0hntVXQb9mB4pjqL7I"
)
APP = "cashflow-dossier"
MANAGE_ROLES = ("admin", "treasury")


def authorize(auth_header):
    """Return (None, user) when the caller may use the staging API, else (http_status, message).

    auth_header: the raw Authorization header ("Bearer <access token>").
    """
    if not auth_header or not auth_header.lower().startswith("bearer "):
        return 401, "missing bearer token"
    token = auth_header[7:].strip()
    if not token:
        return 401, "missing bearer token"
    headers = {"Authorization": f"Bearer {token}", "apikey": SUPABASE_ANON_KEY}
    try:
        u = requests.get(f"{SUPABASE_URL}/auth/v1/user", headers=headers, timeout=15)
    except Exception:
        return 503, "could not verify the sign-in"
    if not u.ok:
        return 401, "invalid token"
    try:
        r = requests.post(f"{SUPABASE_URL}/rest/v1/rpc/has_app_access",
                          headers={**headers, "Content-Type": "application/json"},
                          json={"p_app": APP}, timeout=15)
    except Exception:
        return 503, "could not verify Treasury tool access"
    if not r.ok:
        return 403, "could not verify Treasury tool access"
    role = r.json()
    if role not in MANAGE_ROLES:
        return 403, "this account has no Treasury tool manage access"
    return None, (u.json() or {}).get("email")
