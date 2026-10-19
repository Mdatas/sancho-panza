'use strict';
/**
 * Patch watcher: once a day, read the official Age of Empires news feed, detect "Age of Empires II: Definitive Edition — Update NNNNN"
 * posts newer than the patch the bundled notes were reviewed against, download the official page, and save its text as a note
 * (<userData>/knowledge/parches_auto_NNNNN.md) so the coach can read it. It never blocks the app: every failure is logged and ignored.
 *
 * What it can and cannot do: it gives the coach the official text and a "there is a newer patch" flag; it does NOT re-check the
 * VIGENCIA blocks of the 2,700 notes (that needs a human/LLM pass — see docs/REVISION_2026-10-18.md, patch-bump routine).
 */
const fs = require('fs');
const path = require('path');

// Main WordPress feed (verified 2026-10-18: RSS 2.0 with full post HTML in content:encoded, ~latest 10 posts of ALL AoE games),
// plus the standard WordPress search feed as a fallback so an AoE2 patch is not missed when AoE4/AoM posts push it out of the main feed.
const FEED_URL = 'https://www.ageofempires.com/feed/';
const FEED_URLS = [FEED_URL, 'https://www.ageofempires.com/?s=Definitive+Edition+Update&feed=rss2'];
const UPDATE_RE = /age-of-empires-ii-definitive-edition-update-(\d{5,6})/i;
const TITLE_RE = /Age of Empires II[^\n]{0,80}?Update\s*(\d{5,6})/i;
const CHECK_EVERY_MS = 20 * 3600 * 1000;
const UA = 'AoE2Coach/patchwatch (+desktop companion; checks the official news feed once a day)';

function decodeEntities(s) {
  return String(s).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#8217;|&rsquo;/g, '’').replace(/&rarr;/g, '→').replace(/&larr;/g, '←').replace(/&times;/g, '×').replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—');
}
function cdata(s) { const m = String(s).match(/<!\[CDATA\[([\s\S]*?)\]\]>/); return decodeEntities(m ? m[1] : s).trim(); }

/** RSS 2.0 → [{ title, link, date }] (regex-based: no XML dependency, tolerant of CDATA). */
function parseFeed(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const pick = (tag) => { const r = it.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>')); return r ? cdata(r[1]) : ''; };
    const title = pick('title'), link = pick('link'), date = pick('pubDate'), html = pick('content:encoded');
    let iso = ''; try { iso = date ? new Date(date).toISOString().slice(0, 10) : ''; } catch { iso = ''; }
    if (title || link) items.push({ title, link, date: iso, html });
  }
  return items;
}

/** Feed items that are AoE2 DE patch notes → [{ build, title, link, date }] sorted by build. */
function findAoe2Updates(items) {
  const out = [];
  for (const it of items) {
    const m = UPDATE_RE.exec(it.link || '') || TITLE_RE.exec(it.title || '');
    if (!m) continue;
    const build = m[1];
    if (!out.some(x => x.build === build)) out.push({ build, title: it.title, link: it.link, date: it.date, html: it.html || '' });
  }
  return out.sort((a, b) => Number(a.build) - Number(b.build));
}

/** Official page HTML → readable text (headings as "## ", bullets as "- "), trimmed to the article body when the page marks it. */
function htmlToText(html) {
  let h = String(html);
  const art = h.match(/<(article|main)[\s>][\s\S]*?<\/\1>/i); if (art) h = art[0];
  h = h.replace(/<footer[\s\S]*$/i, '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<\s*(h[1-4])[^>]*>/gi, '\n\n## ').replace(/<\/h[1-4]\s*>/gi, '\n').replace(/<\s*li[^>]*>/gi, '\n- ').replace(/<\s*(br|\/p|\/div|\/tr|\/ul|\/ol)[^>]*>/gi, '\n').replace(/<\s*(td|th)[^>]*>/gi, ' | ');
  h = h.replace(/<[^>]+>/g, ' ');
  h = decodeEntities(h).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return h;
}

/** The newest build in the bundled patch history = the patch the notes were reviewed against. */
function reviewedBuild(bundledKnowledgeDir) {
  try {
    const t = fs.readFileSync(path.join(bundledKnowledgeDir, 'parches_historial.md'), 'utf8');
    let best = 0; for (const m of t.matchAll(/- \d{4}-\d{2}-\d{2} — (?:Update|Hotfix) (\d{5,6})/g)) best = Math.max(best, Number(m[1]));
    return best ? String(best) : '';
  } catch { return ''; }
}

function noteFor(update, text) {
  const head = `# Parche oficial Update ${update.build} (${update.date || 'fecha no leída'}) — texto oficial leído automáticamente, SIN REVISAR contra las notas\n\n` +
    `Fuente: ${update.link}\nLeído el ${new Date().toISOString().slice(0, 10)}. Este parche es POSTERIOR a la revisión de las notas: cualquier número de unidad, coste o bonus de civ que aparezca acá manda sobre las notas y sobre los datos sincronizados hasta que el dataset se actualice.\n\n`;
  const body = text.split('\n').map(l => (l.startsWith('## ') ? `## Parche ${update.build}: ${l.slice(3)}` : l)).join('\n');
  return head + body + '\n';
}

async function getText(url, timeoutMs = 15000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xml,text/xml,*/*' }, signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

/** State file: { lastCheck, latestBuild, seen: { build: { date, link, file } } } */
function loadState(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { lastCheck: 0, latestBuild: '', seen: {} }; } }

/**
 * Check for new patches. Returns { checked, skipped, reviewed, latest, newBuilds:[...], error }.
 * @param cacheDir      where patchwatch.json lives
 * @param knowledgeDir  user knowledge dir (notes are written here and picked up by Knowledge.load)
 * @param reviewed      build the bundled notes were reviewed against
 */
async function check({ cacheDir, knowledgeDir, reviewed, force = false, now = Date.now(), fetchText = getText, log = () => {} }) {
  const file = path.join(cacheDir, 'patchwatch.json');
  const st = loadState(file);
  const res = { checked: false, skipped: false, reviewed, latest: st.latestBuild || reviewed, newBuilds: [], error: null };
  if (!force && now - (st.lastCheck || 0) < CHECK_EVERY_MS) { res.skipped = true; return res; }
  try {
    let items = [], okFeeds = 0;
    for (const u of FEED_URLS) { try { items = items.concat(parseFeed(await fetchText(u))); okFeeds++; } catch (e) { log('patchwatch: feed failed', u, e.message); } }
    if (!okFeeds) throw new Error('no feed reachable');
    const updates = findAoe2Updates(items);
    res.checked = true; st.lastCheck = now;
    for (const u of updates) {
      if (Number(u.build) <= Number(reviewed || 0) || (st.seen && st.seen[u.build])) continue;
      try {
        // the feed already carries the full post; fetch the page only when it does not
        const text = htmlToText(u.html && u.html.length > 500 ? u.html : await fetchText(u.link));
        if (text.length < 200) throw new Error('page text too short (' + text.length + ')');
        fs.mkdirSync(knowledgeDir, { recursive: true });
        const out = path.join(knowledgeDir, `parches_auto_${u.build}.md`);
        fs.writeFileSync(out, noteFor(u, text));
        st.seen = st.seen || {}; st.seen[u.build] = { date: u.date, link: u.link, file: out };
        res.newBuilds.push({ ...u, file: out });
        log('patchwatch: saved official notes for', u.build, u.date);
      } catch (e) { log('patchwatch: could not read', u.link, e.message); }
    }
    const all = Object.keys(st.seen || {}).map(Number).concat(Number(reviewed || 0)).filter(Boolean);
    st.latestBuild = String(Math.max(...all));
    res.latest = st.latestBuild;
    fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(st, null, 2));
  } catch (e) { res.error = e.message; log('patchwatch: feed check failed', e.message); }
  return res;
}

/** One-line status for the system prompt and the UI. */
function statusLine({ reviewed, latest, seen = {} }) {
  if (!latest || !reviewed || Number(latest) <= Number(reviewed)) return `Notes reviewed against patch ${reviewed || '?'}; no newer patch known.`;
  const s = seen[latest] || {};
  return `NEW PATCH: Update ${latest}${s.date ? ' (' + s.date + ')' : ''} is newer than ${reviewed}, the patch the notes were reviewed against. Its official text is in the note "Parche oficial Update ${latest}" (search_notes). Numbers in older notes may have changed.`;
}

module.exports = { parseFeed, findAoe2Updates, htmlToText, reviewedBuild, check, statusLine, noteFor, FEED_URL, FEED_URLS };
