# Recorded games (recs) and rec / stats sources: overview

Research date: 2026-10-16. Current patch: Update 185872, "Balance Patch 22.09.2026", released with The Viking Sagas DLC.
Rules: every fact below has a source URL. **UNVERIFIED** marks anything I could not read directly. Nothing is invented.

## 1. aoe2recs.com: NOT READABLE

| Check | Result | Source |
|---|---|---|
| Home page | Returns only `<title>Spectator Dashboard</title>` and a viewport meta tag. No body text, so it is a client-rendered JS app. No rec list, tags, civs, maps, ELO or players were visible. | https://aoe2recs.com/ |
| `/dashboard`, `/recs` | Same empty "Spectator Dashboard" shell. | https://aoe2recs.com/dashboard , https://aoe2recs.com/recs |
| robots.txt | `User-agent: *` / `Disallow: /api` / `Disallow: /dashboard/api`. The JSON API behind it is off-limits to crawlers, and WebFetch refused `/api/matches` (ROBOTS_DISALLOWED). I did not try to get around this. | https://aoe2recs.com/robots.txt |
| Web search for "aoe2recs.com" | No independent pages describe it. Results only return Guild Order's unrelated "Rec Library" plugin. | WebSearch, 2026-10-16 |

**Conclusion:** the site's name ("Spectator Dashboard") and its robots.txt suggest a spectator/live-match dashboard backed by an `/api`. That reading is **UNVERIFIED**: what it actually hosts (rec tags, civs, maps, ELO, build timings) could not be read. To use it, someone has to open it in a real browser, or ask the owner for permission or an API key. Its robots.txt disallows `/api` for crawlers.

## 2. Other rec / replay / stats sources that were reachable

| Source | What it offers (as read) | Status / caveats | URL |
|---|---|---|---|
| AoE2Insights | Over 3,094,000 player profiles "with detailed play style analysis and full match histories". Leaderboards: RM 1v1 top rating 3,040, RM Team 2,294, EW 1v1 2,113, EW Team 1,829 (as shown 2026-10-16). Also "Match analytics", a "Current Meta Statistics" section and civ pages. | `/statistics/` failed to fetch (client error). Meta numbers not read. | https://www.aoe2insights.com/ |
| aoestats.io | Civ win rate, play rate and pick counts. Filters: ladder ("1v1 Random Map") and rating ("ALL"). | **STALE**: the default view showed patch **162286** (Khitans/Jurchens 0 picks), not 185872. Example values from that old patch: Romans 54.14%, Bulgarians 53.41%, Vikings 52.46%. Do not use them as current. `/openings/` failed. | https://aoestats.io/ |
| AoE2 Coach (aoe2coach.net) | Free replay analyser launched about July 2026 by "huszardo". You enter an in-game name or upload a replay. It compares you with winners at the same ELO and map, using "about 46,000 parsed ranked games". Metrics: age-up timings, economy, army composition, TC idle time. It identifies the "decisive moment". | No benchmark numbers are published on the site or in the thread. Directly comparable to the coach app being built. | https://aoe2coach.net/ ; https://forums.ageofempires.com/t/aoe2-coach-aoe2coach-net-data-based-replay-analysis-tool-and-chatbot-that-compares-you-to-winners-at-your-elo/287451.md |
| aoe2viewer.com (forum announcement) | One-click replay launch of any followed player's recent games, with no manual download or copy into the replay folder. Also lists casters streaming a followed player's important match and lets you join as spectator. | How replays are indexed is not described. | https://forums.ageofempires.com/t/i-created-a-one-click-replay-launcher/286157.md |
| Guild Order "Rec Library" plugin | Guild-internal review queue. A member submits a rec link, the matchup and a question, and an officer leaves a coaching note. Files are not hosted. | Not a pro rec source. | https://guildorder.com/plugins/aoe2-rec-library |
| aocrecs.com | — | ROBOTS_DISALLOWED, not read. | https://aocrecs.com/ |
| Forum consensus (older thread) | Pro recs are not auto-uploaded anywhere. Tournament recs appear sometimes on aoezone.net and aocrecs.com. Otherwise pros' YouTube/Twitch casts (T90, Memb, Viper, Hera), and some streamers' Twitch-sub Discords share recs. | Thread predates 2026. | https://forums.ageofempires.com/t/where-can-i-find-the-recorded-games-of-expert-players/69555 |

## 3. Usable aggregate data on the new patch (Viking Sagas civs)

From Spirit of the Law, "How strong are the new DLC civs? (fresh AoE2 stats!)". Transcript page dated 2026-09-29. Data he cites: "Empire stats" and Awestats.net. Source: https://sozai.app/transcript/strong-new-dlc-civs-aoe2-stats/index.md

| Civ | Rated games | Win rate | Rank / 56 | Most common openings (counts) | ELO / length trend |
|---|---|---|---|---|---|
| Danes | ~9,000 | ~47.5% | ~50th | ~1,960 fast castle (straight or fish boom); >2,200 men-at-arms + follow-ups; <300 archers; few scouts | Peak in 20–30 min games; fall off at 30+ min. Better at low ELO than high. |
| Saxons | ~9,000 | ~48% (low–high 48% depending on site) | 40th–45th | >2,900 FC; ~1,300 archers; ~1,600 MAA; ~200 tower rush | Weak in 5–20 min games, better in Castle and late game. Only 1900+ looks good, from just ~500 games. |
| Varangians | ~13,000 (most played) | 45–47% | 51st–54th | Mostly scouts. Varangian scouts win 49% vs Franks' scouts 56%. | Low ELO does fine, high ELO struggles. "Gold is cheap in the early game, and food bonuses are king." |

## 4. What a coach app can realistically take from recs

- Per-rec facts that need a parser are **UNVERIFIED** here, because no rec file was read: civ, map, ELO, opening type, Feudal/Castle click times, TC idle time. AoE2 Coach says it parses exactly these (age-ups, economy, army composition, TC idle) from replays (source above).
- Population/time benchmarks you can use **without** recs are Cicero's graded A+..E tables (see build_orders_current.md). Source: https://johsaoe2debuildorderreference.site44.com/
