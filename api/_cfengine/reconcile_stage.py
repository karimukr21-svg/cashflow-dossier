#!/usr/bin/env python3
"""Phase B — reconciliation + staging for the Treasury cash-flow tool (Session 3).

Builds on parse_cashflow.py (Session 2 parser core). Per workbook:

  RECONCILE  Σ project sheets  vs  the USD AREA-TOTAL / CONSOLIDATED rollup sheet,
             per line per period. Flow lines (Receipts/Payments) drive the verdict;
             balance lines (opening/ending/accumulated) are stocks that do NOT sum
             linearly across projects, so they are reported as memo, not breaks.
             Each cell classified: tie | rounding | real | missing_in_total |
             missing_in_projects.  => the answer to the Tony-vs-Midas pain.

  STAGE      Write the run as an "open run for review" (LifeDB import-run pattern):
             cf_import_runs (1) + cf_staged_rows (the facts) + cf_recon_breaks (the
             detail) + upsert discovered projects into cf_projects. NEVER touches the
             live canonical tables (cf_actuals/cf_forecasts) or cf_versions — that is
             Push/Publish (Sessions 4-5). Area items fold to project_code='_AREA'
             (is_area_item); JV sheets keep their code, tagged is_jv, stored as-extracted.

Usage:
  python reconcile_stage.py "Qatar_Apr_2026_CashFlow_Updated.xlsx"      # reconcile only
  python reconcile_stage.py --all                                        # all 21, report
  python reconcile_stage.py --all --commit                               # + stage to Supabase
  python reconcile_stage.py --all --commit --reset                       # wipe prior open runs first
  python reconcile_stage.py --report recon_report.md --all               # write markdown report
"""
import openpyxl, glob, os, json, datetime, argparse
from collections import defaultdict, Counter

from parse_cashflow import (SRC, AREA_BY_FILE, Resolver, load_ref, parse_sheet,
                            pick_usd_sheets, classify, strip_currency, tight,
                            DEFAULT_AS_OF, MIN_YEAR)

HERE = os.path.dirname(os.path.abspath(__file__))

# Cycle this "April 2026 Actual" upload proposes to land in (matches as_of 2026-04-30).
PROPOSED_CYCLE = (2026, 5)
PROPOSED_VERSION = '2026-05-PROJ'   # project-grain version; materialized at Push (S4)

# --- area-total / Σ-projects rollup sheet to reconcile against, by filename -----
#     None => single-sheet / no clean decomposition => verdict 'no_total'.
TARGET_SHEET = {
    'AREA QATAR CASH FLOW ACTUAL APRIL 2026 & FORECAST - MOA.xlsx': 'PROJECTS TOTAL USD',
    'Qatar_Apr_2026_CashFlow_Updated.xlsx': 'PROJECTS TOTAL USD',
    'Saudi_Apr_2026_CashFlow.xlsx':         'SAR-CONSOLIDATED',
    'UAE_Apr_2026_CashFlow.xlsx':           'CONSOLIDATED AED',
    'Oman_Apr_2026_CashFlow.xlsx':          'CONSOLIDATED OMR',
    'EPSO_Apr_2026_CashFlow.xlsx':          'CONSOLIDATED-USD',
    'Jordan_Apr_2026_CashFlow.xlsx':        'CONSOLIDATED - USD',
    'Astana_Apr_2026_CashFlow.xlsx':        'CONSOLIDATED',
    'BOTSWANA_Apr_2026_CashFlow.xlsx':      'CONSOLIDATED',
    'KAZH_Apr_2026_CashFlow.xlsx':          'CONSOLIDATED',
    'Morganti_Apr_2026_CashFlow.xlsx':      'CONSOLIDATED',
    'Ivory Coast_Apr_2026_CashFlow.xlsx':   'CONSOLIDATED',
    'Libya_Apr_2026_CashFlow.xlsx':         'LIBYA CONSOLIDATED',
    'MOZAMBIQUE_Apr_2026_CashFlow.xlsx':    'new Consolidated ',
    'CCC Rwanda_Apr_2026_CashFlow.xlsx':    'RWANDA CONSOLIDATED - CCC ',
    'Rwanda_NBIA_Apr_2026_CashFlow.xlsx':   'RWANDA CONSOLIDATED - CCC share',
    'Algeria_Morocco_Apr_2026_CashFlow.xlsx': 'CONSOLIDATED',
    'Egypt 2026 Cash flow Consolidated - April 2026-2.xlsx': 'CONSOLIDATED',
    'Iraq_Apr_2026_CashFlow.xlsx':          None,
    'Nigeria_Apr_2026_CashFlow.xlsx':       None,
    'CCUW_Apr_2026_CashFlow.xlsx':          None,
}

# Reconciliation runs in the project sheets' NATIVE currency (the source reality:
# only Qatar publishes per-project USD; UAE=AED, Saudi=SAR, most others local — the
# USD figure exists only at the consolidated level). Σ-projects-vs-area-total is a
# currency-INTERNAL consistency check, so native currency is correct. Converting the
# staged rows to USD is a Push/S4 concern (plan §3.4: derive USD from gacc.fx_rates).
# Detected from each sheet's "Currency XXX" header; this map is a fallback override.
CURRENCY_OVERRIDE = {
    'AREA QATAR CASH FLOW ACTUAL APRIL 2026 & FORECAST - MOA.xlsx': 'USD',
    'Qatar_Apr_2026_CashFlow_Updated.xlsx': 'USD',
    'Nigeria_Apr_2026_CashFlow.xlsx': 'USD',
}
CCY_TOKENS = ('USD', 'SAR', 'AED', 'QAR', 'EUR', 'EGP', 'KZT', 'OMR', 'NGN',
              'XOF', 'JOD', 'MAD', 'BWP', 'RWF', 'GBP', 'TND', 'DZD')

# Sheets that, despite classifying as 'project', are NOT real projects to sum:
# by-project In/Out/NET summaries + sub-rollups that would double-count.
EXCLUDE_SHEETS = {
    'Saudi_Apr_2026_CashFlow.xlsx': {'SAUDI', 'TOTALAREA', 'PROJECTS', 'NEWPROJECTS',
                                     'AREA - 26 TO 28', 'PMV - NET'},
    'UAE_Apr_2026_CashFlow.xlsx': {'UAE'},
    # transfer/receipts helper tabs that would double-count the area total
    'Oman_Apr_2026_CashFlow.xlsx': {'TRANSFER WITHIN GROUP OMAN', 'Receipts - Completed'},
}

# Single-entity areas: no per-project decomposition exists, only an area cash flow.
# Stage that sheet under project_code='_AREA' (verdict 'single_area' — nothing to tie).
MAIN_SHEET = {
    'Iraq_Apr_2026_CashFlow.xlsx': 'CONSOLIDATED',
    'EPSO_Apr_2026_CashFlow.xlsx': 'CONSOLIDATED-USD',
    'Jordan_Apr_2026_CashFlow.xlsx': 'CONSOLIDATED - USD',
    'Astana_Apr_2026_CashFlow.xlsx': 'CONSOLIDATED',
}


def detect_currency(wb, sheets):
    """Majority currency across the project sheets, read from the 'Currency XXX'
    header line (row 1-2). Falls back to '?' if none found."""
    votes = Counter()
    for n in sheets[:8]:
        try:
            ws = wb[n]
        except KeyError:
            continue
        for row in ws.iter_rows(min_row=1, max_row=3, max_col=4, values_only=True):
            for v in row:
                if isinstance(v, str):
                    up = v.upper()
                    if 'CURRENCY' in up or "'000" in up or '"000"' in up:
                        for tok in CCY_TOKENS:
                            if tok in up:
                                votes[tok] += 1
                                break
    return votes.most_common(1)[0][0] if votes else '?'

# Area-item sheet tokens (fold to project_code='_AREA', is_area_item=true) -------
AREA_ITEM_TOKENS = ('PMV', 'CAMP', 'RMPT', 'OVERHEAD', 'RECOVER', 'AREAOH', 'MOEST')

# Lines that are STOCKS (not flows) — reported as memo in reconciliation ----------
BALANCE_LINES = {'opening_balance', 'ending_balance', 'accum_loans', 'accum_od'}


def is_area_item(code):
    t = tight(code)
    return any(t == tok or t.startswith(tok) for tok in AREA_ITEM_TOKENS)


def is_jv_code(code):
    return 'JV' in tight(code)


def classify_diff(diff, total, sum_proj):
    """rounding | real | missing_in_total | missing_in_projects."""
    a = abs(diff)
    tol = max(1.0, 0.01 * abs(total))          # 1 (=$1k) or 1% of the total cell
    if a <= tol:
        return 'rounding'
    if abs(total) <= tol and abs(sum_proj) > tol:
        return 'missing_in_total'
    if abs(sum_proj) <= tol and abs(total) > tol:
        return 'missing_in_projects'
    return 'real'


def parse_target(wb, area, sheet, resolver, as_of):
    rows, meta = parse_sheet(wb[sheet], area, sheet, resolver, as_of)
    agg = defaultdict(float)
    if rows:
        for r in rows:
            agg[(r['line_code'], r['year'], r['month'])] += r['value']
    return agg, (meta or {})


def reconcile_workbook(path, resolver, as_of):
    fn = os.path.basename(path)
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    return _reconcile_with_wb(wb, fn, resolver, as_of)


def reconcile_workbook_bytes(file_bytes, fn, resolver, as_of):
    """Serverless entry point: reconcile an uploaded workbook from raw bytes.
    (Added for the api/cf-stage.py Vercel function — keeps a single engine.)"""
    import io
    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
    return _reconcile_with_wb(wb, fn, resolver, as_of)


def _reconcile_with_wb(wb, fn, resolver, as_of):
    area = AREA_BY_FILE.get(fn, fn.split('_')[0])
    sel = pick_usd_sheets(wb)
    excl = EXCLUDE_SHEETS.get(fn, set())
    sel = [s for s in sel if s.strip() not in {e.strip() for e in excl}]
    currency = CURRENCY_OVERRIDE.get(fn) or detect_currency(wb, sel)

    # parse every selected project sheet, assign project_code + flags
    proj_rows = []            # normalized rows with project_code resolved
    projects = {}             # project_code -> {sheet, is_area_item, is_jv, n}
    unmatched_labels = Counter()
    nat = {L['line_code']: L['nature'] for L in resolver_lines(resolver)}
    for n in sel:
        rows, meta = parse_sheet(wb[n], area, n, resolver, as_of)
        if rows is None:
            continue
        raw_code = meta['project_code']
        area_item = is_area_item(raw_code)
        jv = is_jv_code(raw_code)
        # area items (non-JV) fold to the _AREA bucket
        code = '_AREA' if (area_item and not jv) else raw_code
        for r in rows:
            r = dict(r); r['project_code'] = code
            proj_rows.append(r)
        p = projects.setdefault(code, {'sheets': [], 'is_area_item': False,
                                       'is_jv': False, 'n': 0})
        p['sheets'].append(n)
        p['is_area_item'] = p['is_area_item'] or area_item
        p['is_jv'] = p['is_jv'] or jv
        p['n'] += len(rows)
        for lab, c in meta['unmatched'].items():
            unmatched_labels[lab] += c

    # single-entity areas: no per-project decomposition — stage the area's own
    # cash-flow sheet under _AREA (nothing to reconcile against).
    single_area = False
    if not proj_rows:
        fb = TARGET_SHEET.get(fn) or MAIN_SHEET.get(fn)
        if fb and fb in wb.sheetnames:
            rows, meta = parse_sheet(wb[fb], area, fb, resolver, as_of)
            if rows:
                for r in rows:
                    r = dict(r); r['project_code'] = '_AREA'; proj_rows.append(r)
                projects['_AREA'] = {'sheets': [fb], 'is_area_item': True,
                                     'is_jv': False, 'n': len(rows)}
                for lab, c in (meta['unmatched'] or {}).items():
                    unmatched_labels[lab] += c
                single_area = True

    # aggregate project rows to canonical grain (sum within-run dups, e.g. _AREA)
    agg = defaultdict(float)                    # (proj, line, y, m) -> value (ALL, for staging)
    for r in proj_rows:
        agg[(r['project_code'], r['line_code'], r['year'], r['month'])] += r['value']
    # reconciliation sum EXCLUDES JV projects: area consolidated sheets are
    # equity-accounted (JV cash flows are not line-consolidated) — plan §3.8.
    # JVs are still STAGED as-extracted (is_jv); they just don't enter the tie.
    jv_codes = {c for c, p in projects.items() if p['is_jv']}
    flowsum = defaultdict(float)                # (line, y, m) -> Σ over NON-JV projects
    for (pc, lc, y, m), v in agg.items():
        if pc in jv_codes:
            continue
        flowsum[(lc, y, m)] += v

    # reconcile against the target rollup sheet (skip for single-entity areas)
    MATERIAL = {'real', 'missing_in_total', 'missing_in_projects'}
    target = TARGET_SHEET.get(fn, '__AUTO__')
    breaks = []
    recon_status = 'single_area' if single_area else 'no_total'
    target_used = None
    if target and target in wb.sheetnames and not single_area:
        tgt, _ = parse_target(wb, area, target, resolver, as_of)
        target_used = target
        keys = set(flowsum) | set(tgt)
        material = 0
        for k in sorted(keys):
            lc, y, m = k
            if y < MIN_YEAR:
                continue
            sp = round(flowsum.get(k, 0.0), 4)
            tv = round(tgt.get(k, 0.0), 4)
            diff = round(sp - tv, 4)
            is_bal = lc in BALANCE_LINES
            if abs(diff) < 0.5:
                continue                         # exact tie (incl. balances), skip noise
            cls = 'balance_memo' if is_bal else classify_diff(diff, tv, sp)
            if cls in MATERIAL:
                material += 1
            breaks.append({'line_code': lc, 'nature': nat.get(lc), 'year': y, 'month': m,
                           'sum_projects': sp, 'area_total': tv, 'diff': diff,
                           'classification': cls})
        recon_status = 'tie' if material == 0 else 'break'
    flow_breaks = [b for b in breaks if b['classification'] in MATERIAL]
    max_abs = max((abs(b['diff']) for b in flow_breaks), default=None)
    cat = {L['line_code']: L['category'] for L in resolver_lines(resolver)}
    by_cat = Counter(cat.get(b['line_code'], '?') for b in flow_breaks)
    n_brk_act = sum(1 for b in flow_breaks
                    if datetime.date(b['year'], b['month'], 1) <= as_of)
    n_brk_fc = len(flow_breaks) - n_brk_act

    wb.close()
    # split rows into actual/forecast by period vs as_of
    staged = []
    n_act = n_fc = 0
    for (pc, lc, y, m), v in agg.items():
        if y < MIN_YEAR:
            continue
        kind = 'actual' if datetime.date(y, m, 1) <= as_of else 'forecast'
        if kind == 'actual':
            n_act += 1
        else:
            n_fc += 1
        staged.append({'kind': kind, 'area': area, 'project_code': pc,
                       'line_code': lc, 'year': y, 'month': m, 'value': round(v, 4)})

    return {
        'area': area, 'file': fn, 'currency': currency,
        'as_of': as_of, 'n_sheets': len(sel), 'projects': projects,
        'n_projects': len(projects), 'unmatched_labels': dict(unmatched_labels),
        'recon_status': recon_status, 'recon_target': target_used,
        'n_real_breaks': len(flow_breaks),
        'n_rounding': sum(1 for b in breaks if b['classification'] == 'rounding'),
        'max_abs_diff': max_abs, 'breaks': breaks,
        'breaks_by_category': dict(by_cat),
        'n_breaks_actual': n_brk_act, 'n_breaks_forecast': n_brk_fc,
        'staged': staged, 'n_actual': n_act, 'n_forecast': n_fc,
    }


def resolver_lines(resolver):
    return load_ref()['lines']


# ---- report -----------------------------------------------------------------
def fmt(res, full=False):
    L = []
    v = res['recon_status']
    badge = {'tie': 'TIE ✓', 'break': 'BREAK', 'no_total': 'no area total',
             'single_area': 'single-entity area (no decomposition)',
             'unknown': 'unknown'}.get(v, v)
    L.append(f"=== {res['area']} ({res['file']}) — {badge} ===")
    L.append(f"  currency={res['currency']}  sheets={res['n_sheets']}  projects={res['n_projects']}"
             f"  staged: {res['n_actual']}A/{res['n_forecast']}F"
             f"  unmatched_labels={len(res['unmatched_labels'])}")
    if res['recon_target']:
        L.append(f"  target='{res['recon_target']}'  real_breaks={res['n_real_breaks']}"
                 f"  ({res['n_breaks_actual']} actual / {res['n_breaks_forecast']} forecast)"
                 f"  rounding={res['n_rounding']}  max|Δ|={res['max_abs_diff']}")
        if res['breaks_by_category']:
            L.append("  breaks by category: " + ", ".join(
                f"{c}={n}" for c, n in sorted(res['breaks_by_category'].items(),
                                              key=lambda x: -x[1])))
    ai = [c for c, p in res['projects'].items() if p['is_area_item']]
    jv = [c for c, p in res['projects'].items() if p['is_jv']]
    if ai: L.append(f"  area-items(_AREA): {', '.join(ai)}")
    if jv: L.append(f"  JV: {', '.join(jv)}")
    if res['unmatched_labels']:
        L.append("  UNMATCHED: " + ", ".join(f"{k!r}x{c}" for k, c in res['unmatched_labels'].items()))
    rb = [b for b in res['breaks'] if b['classification'] == 'real']
    if rb:
        L.append(f"  -- real flow breaks ({len(rb)}) --")
        for b in sorted(rb, key=lambda x: -abs(x['diff']))[:(999 if full else 10)]:
            L.append(f"     {b['line_code']:22} {b['year']}-{b['month']:02d}  "
                     f"Σproj={b['sum_projects']:12.1f} total={b['area_total']:12.1f} Δ={b['diff']:11.1f}")
    return "\n".join(L)


# ---- staging (REST writes) --------------------------------------------------
def stage(res, ref, created_by='reconcile_stage.py'):
    import db
    # 1. upsert discovered projects into cf_projects
    gid = ref.get('gacc_id_index', {})
    gidx = ref.get('gacc_index', {})
    projrows = []
    for code, p in res['projects'].items():
        if code == '_AREA':
            continue
        link = gid.get(tight(code))
        projrows.append({'project_code': code, 'area': res['area'],
                         'display_name': (gidx.get(tight(code), {}) or {}).get('abbreviation') or code,
                         'gacc_project_id': link,
                         'is_area_item': p['is_area_item'], 'is_jv': p['is_jv']})
    if projrows:
        db.insert('cf_projects', projrows, upsert=True, on_conflict='project_code')

    # 2. cf_import_runs (the open run)
    summary = {
        'target_sheet': res['recon_target'], 'currency': res['currency'],
        'projects': {c: {'sheets': p['sheets'], 'is_area_item': p['is_area_item'],
                         'is_jv': p['is_jv'], 'rows': p['n']}
                     for c, p in res['projects'].items()},
        'unmatched_labels': res['unmatched_labels'],
        'breaks_by_class': dict(Counter(b['classification'] for b in res['breaks'])),
        'breaks_by_category': res['breaks_by_category'],
        'breaks_actual': res['n_breaks_actual'], 'breaks_forecast': res['n_breaks_forecast'],
    }
    run = db.insert_returning('cf_import_runs', [{
        'area': res['area'], 'source_file': res['file'], 'as_of_date': str(res['as_of']),
        'cycle_year': PROPOSED_CYCLE[0], 'cycle_month': PROPOSED_CYCLE[1],
        'proposed_version': PROPOSED_VERSION, 'currency': res['currency'],
        'status': 'open', 'n_sheets': res['n_sheets'], 'n_projects': res['n_projects'],
        'n_projects_new': len(projrows), 'n_actual_rows': res['n_actual'],
        'n_forecast_rows': res['n_forecast'], 'n_unmatched_labels': len(res['unmatched_labels']),
        'recon_target_sheet': res['recon_target'], 'recon_status': res['recon_status'],
        'recon_n_breaks': res['n_real_breaks'], 'recon_n_rounding': res['n_rounding'],
        'recon_max_abs_diff': res['max_abs_diff'], 'recon_summary': summary,
        'created_by': created_by,
    }])[0]
    run_id = run['run_id']

    # 3. cf_staged_rows
    srows = [{'run_id': run_id, **r} for r in res['staged']]
    db.insert('cf_staged_rows', srows)

    # 4. cf_recon_breaks (skip exact ties; keep classified breaks + balance memo)
    brows = [{'run_id': run_id, **b} for b in res['breaks']]
    if brows:
        db.insert('cf_recon_breaks', brows)
    return run_id


# ---- CLI --------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file', nargs='?')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--as-of', default=None)
    ap.add_argument('--commit', action='store_true', help='write staging to Supabase')
    ap.add_argument('--reset', action='store_true', help='delete prior OPEN runs first')
    ap.add_argument('--report', default=None, help='write a markdown report')
    ap.add_argument('--full', action='store_true', help='list all real breaks')
    args = ap.parse_args()
    as_of = datetime.date.fromisoformat(args.as_of) if args.as_of else DEFAULT_AS_OF
    ref = load_ref()
    resolver = Resolver(ref)

    if args.reset and args.commit:
        import db
        db.delete('cf_import_runs', {'status': 'eq.open'})
        print("reset: deleted prior open runs (+ cascade)\n")

    files = sorted(glob.glob(SRC + '*.xlsx')) if args.all else \
            [args.file if os.path.exists(args.file) else SRC + args.file]
    out_lines, grand = [], []
    for p in files:
        res = reconcile_workbook(p, resolver, as_of)
        block = fmt(res, full=args.full)
        print(block); print()
        out_lines.append(block)
        if args.commit:
            rid = stage(res, ref)
            print(f"   staged run {rid}\n")
        grand.append((res['area'], res['recon_status'], res['n_real_breaks'],
                      res['n_actual'] + res['n_forecast'], len(res['unmatched_labels']),
                      res['n_breaks_actual'], res['n_breaks_forecast'],
                      res['currency'], res['recon_target']))

    print("==== SUMMARY ====")
    for area, st, rb, n, ul, ba, bf, ccy, tgt in grand:
        print(f"  {area:14} {st:11} breaks={rb:<4} staged_rows={n:<6} unmatched={ul}")
    if args.report:
        with open(args.report, 'w') as f:
            f.write("# Phase B — Reconciliation report (Session 3)\n\n")
            f.write("_Σ project sheets vs the area-total / consolidated rollup, per line "
                    "per period, in each area's native currency. JV sheets excluded from "
                    "the tie (equity-accounted, not line-consolidated) but staged "
                    "as-extracted. Balance lines (opening/ending/accum) are stocks → memo, "
                    "not breaks. Cutover 2026-04-30._\n\n")
            f.write("## Verdict summary\n\n")
            f.write("| Area | Verdict | Breaks (act/fcst) | Staged | Currency | Target sheet |\n")
            f.write("|------|---------|-------------------|--------|----------|-------------|\n")
            for area, st, rb, n, ul, ba, bf, ccy, tgt in grand:
                f.write(f"| {area} | {st} | {rb} ({ba}/{bf}) | {n} | {ccy} | "
                        f"{tgt or '—'} |\n")
            f.write("\n## Per-area detail\n\n")
            f.write("\n\n".join(out_lines))
        print("\nWrote", args.report)


if __name__ == '__main__':
    main()
