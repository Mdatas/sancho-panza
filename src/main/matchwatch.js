'use strict';
/**
 * Match detection (optional, complements manual input — never required).
 * Source: the public JSON API behind aoe2companion.com (community service, not Microsoft's; verified 2026-10-18):
 *   GET https://data.aoe2companion.com/api/profiles?search=<name>&page=1      → { profiles:[{ profileId, name, country, games, verified }] }
 *   GET https://data.aoe2companion.com/api/matches?profile_ids=<id>&page=1    → { matches:[{ matchId, started, finished|null, leaderboardName,
 *        mapName, teams:[{ teamId, players:[{ profileId, name, civ, civName, rating, won, team }] }] }] }
 * Only the player's own public profile id is sent. Nothing is sent when the feature is off or no profile is set.
 * Rules: a match with finished === null and started < 3 h ago is "live" and may fill EMPTY state fields; a finished match is only
 * offered (for post-game review), never applied. Manual input always wins (see Brain.applyDetected).
 */
const API = 'https://data.aoe2companion.com/api';
const UA = 'AoE2Coach/matchwatch (+desktop companion; polls one profile while the app is open)';
const LIVE_MAX_AGE_MS = 3 * 3600 * 1000;

async function getJson(url, timeoutMs = 10000, fetchImpl = fetch) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function searchProfiles(name, { fetchImpl } = {}) {
  const q = String(name || '').trim(); if (q.length < 2) return [];
  const j = await getJson(`${API}/profiles?search=${encodeURIComponent(q)}&page=1`, 10000, fetchImpl);
  return (j.profiles || []).slice(0, 10).map(p => ({ profileId: p.profileId, name: p.name, country: p.country || '', games: Number(p.games) || 0, verified: !!p.verified }));
}

/** Normalise one API match → { id, live, started, finished, map, mode, me, allies, opponents } (null if the profile is not in it). */
function normalise(m, profileId, now = Date.now()) {
  if (!m || !Array.isArray(m.teams)) return null;
  const players = m.teams.flatMap(t => (t.players || []).map(p => ({ profileId: p.profileId, name: p.name, civ: p.civName || p.civ || '', rating: p.rating || null, team: p.team != null ? p.team : t.teamId, won: p.won })));
  const me = players.find(p => String(p.profileId) === String(profileId));
  if (!me) return null;
  const started = m.started ? Date.parse(m.started) : 0;
  const live = !m.finished && started > 0 && now - started < LIVE_MAX_AGE_MS;
  return {
    id: m.matchId, live, started: m.started || null, finished: m.finished || null,
    map: m.mapName || '', mode: m.leaderboardName || m.gameModeName || '',
    me, allies: players.filter(p => p !== me && p.team === me.team), opponents: players.filter(p => p.team !== me.team),
  };
}

async function latestMatch(profileId, { fetchImpl, now } = {}) {
  if (!profileId) return null;
  const j = await getJson(`${API}/matches?profile_ids=${encodeURIComponent(profileId)}&page=1`, 10000, fetchImpl);
  for (const m of (j.matches || [])) { const n = normalise(m, profileId, now); if (n) return n; }
  return null;
}

/** "Francos (1650) vs Mongoles (1702) · Arabia · RM 1v1" — civ names as given by the API (English). */
function describe(match) {
  if (!match) return '';
  const side = (ps) => ps.map(p => `${p.civ}${p.rating ? ' (' + p.rating + ')' : ''}`).join(' + ');
  return `${side([match.me, ...match.allies])} vs ${side(match.opponents)} · ${match.map}${match.mode ? ' · ' + match.mode : ''}${match.live ? ' · EN CURSO' : ''}`;
}

/**
 * Poller: calls onMatch(match) when a NEW live match appears (by id), at most every intervalMs, only while enabled() is true.
 * Failures are silent (logged); the app keeps working without detection.
 */
function createPoller({ getProfileId, enabled, onMatch, log = () => {}, intervalMs = 90000, fetchImpl, now = () => Date.now() }) {
  let timer = null, lastId = null, busy = false, lastError = null, lastMatch = null;
  async function tick(force = false) {
    if (busy || (!force && !enabled())) return lastMatch;
    const pid = getProfileId(); if (!pid) return null;
    busy = true;
    try {
      const m = await latestMatch(pid, { fetchImpl, now: now() });
      lastError = null; lastMatch = m;
      if (m && m.live && m.id !== lastId) { lastId = m.id; onMatch(m); }
      return m;
    } catch (e) { lastError = e.message; log('matchwatch:', e.message); return null; }
    finally { busy = false; }
  }
  return {
    start() { if (!timer) { timer = setInterval(() => tick(false), intervalMs); setTimeout(() => tick(false), 4000); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    now: () => tick(true),
    status: () => ({ lastError, lastMatch, running: !!timer }),
    forget() { lastId = null; lastMatch = null; },
  };
}

module.exports = { searchProfiles, latestMatch, normalise, describe, createPoller, API };
