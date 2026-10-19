#!/usr/bin/env python3
# Usage: python3 tools/audit_kb.py [repo_root] [report_file]   — run after every patch / knowledge import.
"""Knowledge-base integrity audit for AoE2 Coach. Deterministic checks only (no guessing)."""
import re, glob, json, os, sys, collections
ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
K = os.path.join(ROOT, 'data/knowledge'); G = os.path.join(ROOT, 'data/game'); B = os.path.join(ROOT, 'data/build_orders/rtsbuilds')
CURRENT = '185872'
out = []
def P(*a): out.append(' '.join(str(x) for x in a))

# ---------- load knowledge sections like knowledge.js does
secs = []
for f in sorted(glob.glob(K + '/**/*.md', recursive=True)):
    text = open(f, encoding='utf8').read()
    for p in re.split(r'\n(?=#{1,3} )', text):
        m = re.match(r'^#{1,3} (.*)', p); title = m.group(1).strip() if m else os.path.basename(f)
        body = re.sub(r'^#{1,3} .*\n?', '', p).strip()
        if body: secs.append(dict(file=os.path.relpath(f, K), title=title, body=body))
P('== STRUCTURE'); P('files', len(set(s['file'] for s in secs)), 'sections', len(secs))
big = [s for s in secs if len(s['body']) > 1800]
P('raw sections > 1800 chars (the app splits top-level notes at load; civs/ and maps/ profiles are served whole by civ_info):', len(big)); [P('  ', s['file'], '|', s['title'][:90], len(s['body'])) for s in big[:15]]
dup = collections.Counter((s['file'], s['title']) for s in secs); d = [k for k, v in dup.items() if v > 1]
P('duplicate titles within a file:', len(d)); [P('  ', *k) for k in d[:10]]
byfile = collections.Counter(s['file'] for s in secs); P('sections per file:'); [P('  %4d %s' % (v, k)) for k, v in byfile.most_common()]

# ---------- patch history
hist = {}; order = []
for line in open(K + '/parches_historial.md', encoding='utf8'):
    m = re.match(r'- (\d{4}-\d{2}-\d{2}) — (?:Update|Hotfix|Parche|Actualización) (\d{5,6})', line)
    if m: hist[m.group(2)] = m.group(1); order.append((m.group(1), m.group(2)))
P('\n== PATCH HISTORY'); P('entries', len(hist), 'span', order[0] if order else None, '->', order[-1] if order else None)
unsorted = [(a, b) for a, b in zip(order, order[1:]) if b[0] < a[0]]
P('out-of-order entries:', len(unsorted)); [P('  ', a, '->', b) for a, b in unsorted[:10]]
P('current patch in history?', CURRENT in hist, hist.get(CURRENT))
# patch numbers cited in notes
cited = collections.Counter(); citedwhere = collections.defaultdict(set); datepairs = collections.Counter()
for s in secs:
    for m in re.finditer(r'(?:Update|Hotfix|parche|Parche|build|Build|actualización|Actualización)\s*(\d{5,6})(?:\s*[,(]?\s*(\d{4}-\d{2}(?:-\d{2})?|\d{4}))?', s['body'] + ' ' + s['title']):
        n = m.group(1); cited[n] += 1; citedwhere[n].add(s['file'])
        if m.group(2) and len(m.group(2)) >= 7: datepairs[(n, m.group(2)[:7])] += 1
unknown = {n: c for n, c in cited.items() if n not in hist}
P('distinct patch numbers cited in notes:', len(cited), '| cited but NOT in parches_historial:', len(unknown))
for n, c in sorted(unknown.items(), key=lambda x: -x[1])[:25]: P('  ', n, 'x%d' % c, 'in', ', '.join(sorted(citedwhere[n])[:4]))
bad_dates = [(n, ym, c, hist[n][:7]) for (n, ym), c in datepairs.items() if n in hist and hist[n][:7] != ym]
P('patch+date pairs in notes that disagree with parches_historial month:', len(bad_dates)); [P('  ', *x) for x in sorted(bad_dates, key=lambda x: -x[2])[:20]]
# "current patch" claims
cur_claims = collections.Counter(re.findall(r'parche actual[^\d]{0,20}(\d{5,6})', ' '.join(s['body'] for s in secs)))
P('"parche actual" numbers claimed:', dict(cur_claims))
# future dates
fut = [(s['file'], s['title'][:60], d) for s in secs for d in re.findall(r'\b(20\d\d-\d\d-\d\d)\b', s['title'] + s['body']) if d > '2026-10-18']
P('dates after today:', len(fut)); [P('  ', *x) for x in fut[:10]]

# ---------- VIGENCIA coverage
P('\n== VIGENCIA')
dated = [s for s in secs if re.search(r'video publicado|publicado 20\d\d|\(20\d\d(-\d\d)?(-\d\d)?\)|\b(Hera|SotL|TaToH)\s*\(20', s['title'])]
with_vig_file = collections.defaultdict(bool)
for s in secs:
    if re.search(r'VIGENCIA', s['title'] + s['body']): with_vig_file[s['file']] = True
no_vig = [s for s in dated if not re.search(r'VIGENCIA', s['title'] + s['body']) and 'lecciones' in s['title'] and '[ver VIGENCIA]' not in s['title']]
P('dated sections:', len(dated), '| dated lesson sections with no VIGENCIA link:', len(no_vig)); [P('  ', s['file'], '|', s['title'][:90]) for s in no_vig[:10]]
TAGS = ('CAMBIÓ', 'CAMBIO', 'SIGUE IGUAL', 'SIN VERIFICAR', 'IMPACTO', 'NUEVO', 'OJO', 'NOTA')
untagged = 0; vig_bullets = 0; sinver = 0
for s in secs:
    if 'VIGENCIA' not in s['title']: continue
    for l in s['body'].split('\n'):
        if not l.strip().startswith('-'): continue
        vig_bullets += 1
        if not any(t in l for t in TAGS): untagged += 1
        if 'SIN VERIFICAR' in l: sinver += 1
P('VIGENCIA bullets:', vig_bullets, '| without a type tag:', untagged, '| SIN VERIFICAR:', sinver)
sv_files = collections.Counter(s['file'] for s in secs if 'SIN VERIFICAR' in s['body'])
P('files with most SIN VERIFICAR sections:'); [P('  %3d %s' % (v, k)) for k, v in sv_files.most_common(8)]

# ---------- cross-source contradictions (known hot spots)
P('\n== CROSS-SOURCE CLAIMS (count of files asserting each variant)')
def variants(label, pats):
    P(' ', label)
    for name, pat in pats:
        files = sorted({s['file'] for s in secs if re.search(pat, s['body'], re.I)})
        P('    %-28s %2d files: %s' % (name, len(files), ', '.join(files[:5])))
variants('Burgundians eco-tech discount', [('-40%', r'(borgoñ|burgund)[^\n]{0,160}(-|−)?40 ?%[^\n]{0,60}(eco|econ)|(eco|econ)[^\n]{0,80}(-|−)?40 ?%[^\n]{0,120}(borgoñ|burgund)'), ('-33%', r'(borgoñ|burgund)[^\n]{0,160}(-|−)?33 ?%|33 ?%[^\n]{0,120}(borgoñ|burgund)'), ('-50%', r'(borgoñ|burgund)[^\n]{0,120}(-|−)?50 ?%[^\n]{0,40}(eco|tecn)')])
variants('First Crusade serjeants per TC', [('7 por TC', r'(First Crusade|Primera Cruzada)[^\n]{0,120}\b7\b'), ('5 por TC', r'(First Crusade|Primera Cruzada)[^\n]{0,120}\b5\b')])
variants('Malay fish trap', [('+300%', r'(malay|malayo)[^\n]{0,200}\+?300 ?%|trampa[^\n]{0,60}\+?300 ?%'), ('+200%', r'(malay|malayo)[^\n]{0,200}\+?200 ?%|trampa[^\n]{0,60}\+?200 ?%')])
variants('Georgian repair discount', [('-50% / mitad', r'(georgian|georgiano)[^\n]{0,160}(50 ?%|mitad)[^\n]{0,40}repar|repar[^\n]{0,60}(50 ?%|mitad)[^\n]{0,80}georgian'), ('-25%', r'(georgian|georgiano)[^\n]{0,160}25 ?%[^\n]{0,40}repar|repar[^\n]{0,60}25 ?%')])
variants('Georgian cavalry regeneration', [('2/8/14', r'2/8/14'), ('5/10/15', r'5/10/15'), ('15%/min', r'15 ?%[^\n]{0,20}min')])
variants('Sicilian transport bonus', [('gratis/free', r'(sicil)[^\n]{0,120}transport[^\n]{0,40}(grati|free)|transport[^\n]{0,40}(grati|free)[^\n]{0,80}sicil'), ('-50%', r'transport[^\n]{0,60}(-|−)50 ?%')])
variants('Cuman Mercenaries kipchaks per castle', [('5', r'(Cuman Mercenaries|Mercenarios cumanos)[^\n]{0,120}\b5\b'), ('10', r'(Cuman Mercenaries|Mercenarios cumanos)[^\n]{0,120}\b10\b'), ('20', r'(Cuman Mercenaries|Mercenarios cumanos)[^\n]{0,120}\b20\b')])
variants('Inca military food discount', [('-15/20/25/30', r'15/20/25/30'), ('-8/12/16/20', r'8/12/16/20')])
variants('Saxons food from eco buildings', [('+50', r'(saxon|sajon)[^\n]{0,160}\+50[^\n]{0,40}(food|comida|alimento)'), ('+35', r'(saxon|sajon)[^\n]{0,160}\+35[^\n]{0,40}(food|comida|alimento)')])
variants('Goth infantry discount', [('15/20/25/30', r'(goth|godo)[^\n]{0,160}15/20/25/30'), ('20/25/30/35', r'(goth|godo)[^\n]{0,160}20/25/30/35'), ('35%', r'(goth|godo)[^\n]{0,120}35 ?%')])
variants('Siege Tower cost', [('100W/120G', r'100 ?(W|madera)[ /]+120 ?(G|oro)'), ('200W/160G', r'200 ?(W|madera)[ /]+160 ?(G|oro)')])
variants('Market buy 100 food cost', [('150 oro', r'100 (de )?(comida|food)[^\n]{0,60}150 (oro|gold)|150 (oro|gold)[^\n]{0,40}100 (de )?(comida|food)')])

# ---------- naming variants (retrieval consistency)
P('\n== CIV NAME VARIANTS (files using each spelling)')
for grp in [('Drávidas', 'Dravidianos', 'Drávidos'), ('Indostaníes', 'Hindustanis', 'Hindustaníes', 'Indios'), ('Malíes', 'Malienses', 'Malians'), ('Khmer', 'Jemeres'), ('Tupíes', 'Tupi', 'Tupís'), ('Khitanos', 'Khitans', 'Kitán'), ('Jurchens', 'Yurchen', 'Jurchen'), ('Varegos', 'Varangians', 'Varangios'), ('Sajones', 'Saxons', 'Sajón'), ('Mapuches', 'Mapuche'), ('Magiares', 'Magyars', 'Húngaros'), ('Bizantinos', 'Byzantines'), ('Búlgaros', 'Bulgarians')]:
    row = []
    for n in grp:
        c = len({s['file'] for s in secs if re.search(r'(?<![\wáéíóú])' + n + r'(?![\wáéíóú])', s['body'] + ' ' + s['title'])})
        row.append('%s=%d' % (n, c))
    P('  ', ' | '.join(row))

# ---------- build orders
P('\n== BUILD ORDERS (rtsbuilds)')
trees = {os.path.basename(f)[:-5]: json.load(open(f)) for f in glob.glob(G + '/trees/*.json')}
def tree_status(civ):
    t = trees.get(civ.upper().replace(' ', '')); st = {}
    if not t: return None
    for n in t.get('units_techs', []) + t.get('buildings', []): st[n['name']] = n['node_status']
    return st
sum_bad = 0; civ_bad = []; stale = []; nodate = 0; total = 0
for f in sorted(glob.glob(B + '/*.json')):
    try: b = json.load(open(f, encoding='utf8'))
    except Exception as e: P('  BAD JSON', f, e); continue
    total += 1
    if not any(k in b for k in ('date', 'patch', 'version', 'updated')): nodate += 1
    civs = b.get('civilization'); civs = civs if isinstance(civs, list) else [civs]
    for step in b.get('build_order', []):
        r = step.get('resources', {}); tot = sum(v for k, v in r.items() if isinstance(v, (int, float)) and k in ('wood', 'food', 'gold', 'stone', 'builder'))
        vc = step.get('villager_count')
        if isinstance(vc, (int, float)) and vc >= 0 and tot != vc and not any(v < 0 for v in r.values() if isinstance(v, (int, float))): sum_bad += 1; civ_bad.append((os.path.basename(f), vc, tot))
    notes = ' '.join(n for s in b.get('build_order', []) for n in s.get('notes', []))
    names = set(re.findall(r'@[a-z_]+/([A-Za-z0-9_\-]+?)(?:_aoe2DE|_aoe2de|_AoE2DE|AoE2DE|_DE)?\.(?:webp|png|jpg)@', notes))
    for civ in civs:
        if not civ or civ == 'Generic': continue
        st = tree_status(civ)
        if st is None: civ_bad.append((os.path.basename(f), 'unknown civ', civ)); continue
        for nm in names:
            human = nm.replace('_', ' ')
            for k, v in st.items():
                if k.lower() == human.lower() and v == 'NotAvailable': stale.append((os.path.basename(f), civ, k))
P('builds', total, '| without date/patch field:', nodate, '| steps where resource split != villager_count:', sum_bad)
[P('  split mismatch', *x) for x in civ_bad[:12] if x[1] != 'unknown civ']
P('civ-specific builds referencing a unit/tech the civ can NOT get today:', len(stale)); [P('  ', *x) for x in stale[:20]]

# ---------- removed / renamed things still used as current anywhere
P('\n== REMOVED-ITEM MENTIONS (should only appear inside dated notes / VIGENCIA, not as current advice)')
data = json.load(open(G + '/data.json'))
allnames = set()
for cat in ('techs', 'units', 'buildings'):
    for k, v in data.get('data', {}).get(cat, {}).items() if isinstance(data.get('data', {}).get(cat), dict) else []: pass
strings = json.load(open(G + '/strings_en.json'))
en_names = set(str(v) for v in strings.values()) if isinstance(strings, dict) else set()
for item in ['Supplies', 'Bearded Axe', 'Carrack', 'Longboat', 'Gambesons']:
    exists = item in en_names
    files = sorted({s['file'] for s in secs if re.search(r'\b' + re.escape(item) + r'\b', s['body'])})
    nonvig = sorted({s['file'] for s in secs if re.search(r'\b' + re.escape(item) + r'\b', s['body']) and 'VIGENCIA' not in s['title'] and 'publicado' not in s['title'] and '(20' not in s['title']})
    P('  %-12s in current game strings: %-5s | mentioned in %2d files | in undated/current-advice sections of: %s' % (item, exists, len(files), ', '.join(nonvig[:6])))
open(sys.argv[2] if len(sys.argv) > 2 else '/dev/stdout', 'w', encoding='utf8').write('\n'.join(out) + '\n')
