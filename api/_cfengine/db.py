#!/usr/bin/env python3
"""Supabase REST helper for the Treasury cash-flow staging engine — SERVERLESS.

Vendored variant of the EA tool's db.py. Reads URL + service-role key from the
Vercel environment (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) instead of the local
~/.config file. Service role bypasses RLS — required for an autonomous staging write
from the api/cf-stage.py function (the caller's bearer token is verified separately).
"""
import os
import requests

# URL is public (same value hardcoded in src/supabaseClient.js) — default it so the
# only Vercel env var that MUST be set is the secret service-role key.
URL = (os.environ.get("SUPABASE_URL") or "https://twinoncujgwlvanpsnle.supabase.co").rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
REST = f"{URL}/rest/v1"
_H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}


def select(table, params, profile="public"):
    h = {**_H, "Accept-Profile": profile}
    out, offset, page = [], 0, 1000
    while True:
        p = dict(params)
        p["limit"] = page
        p["offset"] = offset
        r = requests.get(f"{REST}/{table}", headers=h, params=p, timeout=60)
        r.raise_for_status()
        chunk = r.json()
        out.extend(chunk)
        if len(chunk) < page:
            break
        offset += page
    return out


def insert(table, rows, profile="public", upsert=False, on_conflict=None, chunk=500):
    if not rows:
        return 0
    h = {**_H, "Content-Type": "application/json", "Content-Profile": profile,
         "Prefer": "return=minimal" + (",resolution=merge-duplicates" if upsert else "")}
    n = 0
    for i in range(0, len(rows), chunk):
        params = {}
        if on_conflict:
            params["on_conflict"] = on_conflict
        r = requests.post(f"{REST}/{table}", headers=h, params=params,
                          json=rows[i:i + chunk], timeout=120)
        if r.status_code >= 300:
            raise RuntimeError(f"insert {table} {r.status_code}: {r.text[:600]}")
        n += len(rows[i:i + chunk])
    return n


def insert_returning(table, rows, profile="public"):
    h = {**_H, "Content-Type": "application/json", "Content-Profile": profile,
         "Prefer": "return=representation"}
    r = requests.post(f"{REST}/{table}", headers=h, json=rows, timeout=120)
    if r.status_code >= 300:
        raise RuntimeError(f"insert_returning {table} {r.status_code}: {r.text[:600]}")
    return r.json()


def delete(table, params, profile="public"):
    h = {**_H, "Content-Profile": profile, "Prefer": "return=minimal"}
    r = requests.delete(f"{REST}/{table}", headers=h, params=params, timeout=60)
    if r.status_code >= 300:
        raise RuntimeError(f"delete {table} {r.status_code}: {r.text[:300]}")
