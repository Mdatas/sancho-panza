# AoE2 Coach v0.12: cost, automatic patches, match detection, privacy, UX (2026-10-18)

> **v0.12.1 (stable):** sections 1 and 4 ship **behind Settings → Experimental, OFF by default**. With them off the app behaves exactly like v0.11 (same key field, same single cached prompt). Patch watch is on (it only adds a note and a ⚠). Match detection is opt-in. Log auto-delete is off by default. The smoke test checks the key handling in all modes.

## 1. Cost bug: what changed, expected gain, side effects

**Before.** The rules (~1.7k tokens) and the per-question notes (~3.2k tokens for a typical question) were one system block with a single cache breakpoint. Every question changed that block, so the rules were re-written to the cache each time. The tool results of earlier rounds were resent at full price on every round of the tool loop.

**Now.** There are four cache breakpoints (the maximum per request):
1. The tool definitions (~2.0k tokens). Unchanged; reused across questions.
2. The **static** rules block. Identical for every question: a test (`test/integrations.test.js`) fails if state or notes leak into it. Reused across questions.
3. The **dynamic** block (match state, patch line, retrieved notes). Reused across the 3–5 tool rounds of one question.
4. The last message of each round after the first, so earlier tool results are read from cache instead of resent.

**Expected gain** (Sonnet 5.5 prices, typical 4-round question):
- About $0.0375 → $0.025 of input cost per question, roughly −33%.
- Output cost does not change.
- The real figure is in the logs: every answer records `usage` with `cache_creation_input_tokens` / `cache_read_input_tokens`.

**Problems it can raise**

| Risk | Effect | Mitigation |
|---|---|---|
| Cache TTL is 5 minutes. Questions often come more than 5 minutes apart in a game. | The static block is re-written at 1.25× instead of read at 0.1×. On idle gaps the static part costs about 25% more than with no cache. | Net is still positive because of the within-question rounds. Option: the 1-hour TTL (2× write price) if the API offers it for these models — **verify before turning it on**. Option: a cheap keep-alive is *not* recommended (it costs on every ping). |
| Minimum cacheable prefix (1024 tokens for Sonnet). | Tools plus static rules are about 3.7k tokens, which is fine. | The Haiku extraction call (small prompt) is not cached; this is intended. |
| Message breakpoint on the final round. | It writes at 1.25× something nobody reads. | Small: one tool-result block per question. |
| Changing the rules (prompt edits, app update). | Invalidates the cache once. | Expected. |
| OpenAI-compatible providers. | No explicit cache control. | The static-first ordering still helps providers with automatic prefix caching. |

Further levers, not done:
- Cut the notes budget per question: 7 sections of up to 1.8k characters is the biggest dynamic cost.
- Shorter tool results: they are capped at 12k characters each.
- Make the Haiku extraction optional for messages that are only commands.

## 2. Automatic patch updates

`src/main/patchwatch.js`:
- **When.** On start, at most once per 20 hours (on/off in Settings → Parches, `/parche` to force).
- **What it reads.** The official RSS feed `https://www.ageofempires.com/feed/`. Verified: RSS 2.0 with the full post HTML. It carries only the latest ~10 posts across all AoE games, so the standard WordPress search feed `?s=Definitive+Edition+Update&feed=rss2` is used as a fallback (untested here).
- **What it detects.** Posts titled or linked as "Age of Empires II: Definitive Edition – Update NNNNN" with a build number newer than the patch the notes were reviewed against. That build is the newest entry in `parches_historial.md`, today 185872.
- **What it does with a new patch:**
  1. Saves the official text as `%APPDATA%\AoE2 Coach\knowledge\parches_auto_NNNNN.md`, searchable immediately.
  2. Shows a ⚠ in the header and a toast.
  3. Adds a line to the dynamic prompt ("NEW PATCH … read the official note before quoting numbers").
- **What it cannot do.** Re-check the ~2,700 VIGENCIA blocks; that still needs a review pass. The game data (units, costs, trees) updates separately through the aoe2techtree sync, which lags the patch by days.
- **Failure modes.** Offline, site redesign or feed format change: the check fails silently and is logged, and the app keeps working with the last data. Parsing is regex-based and tolerant; a test covers the real feed shape.

## 3. Match detection (complements, never blocks)

`src/main/matchwatch.js`, opt-in (off by default):
- **Source.** The public JSON API behind aoe2companion.com, a community service, not Microsoft's. Shape verified 2026-10-18:
  - `/api/profiles?search=` returns `profileId`.
  - `/api/matches?profile_ids=` returns `started`, `finished` (null while running), `mapName`, `teams[].players[]` with `civName` and `rating`.
- **Flow:**
  1. Settings → type your AoE2 name → "Soy yo" stores the public `profileId`.
  2. While the window is visible the app polls every ~90 seconds.
  3. A match with `finished = null` that started less than 3 hours ago is **live**.
- **Rules:**
  - It fills only **empty** fields (civ, opponent civ, map) and marks the state "auto".
  - Anything you type or set with `/civ` `/vs` `/mapa` wins and removes the "auto" mark.
  - The coach is told the detected state is "likely but unconfirmed".
  - In team games it records allies and opponents in the notes.
  - Finished matches are only shown (for post-game review), never applied.
  - `/partida` reads now; `/partida usar` replaces civs and map.
- **Without a match / offline / feature off:** nothing changes, everything works as before.

**Risks:**
- It depends on a third-party service, which can change or rate-limit. Failures are silent.
- The match list can lag the real lobby by a minute or two.
- Unranked or private lobbies may not appear.
- The service's robots.txt disallows crawlers. This is one user's own profile polled at a low rate, not crawling, but it is their API: do not lower the interval.

Alternative with no third party: parse the `.aoe2record` header the game writes locally. That needs a recorded-game parser and sample files; it is not done.

## 4. Plain-text URL and "amnesiac" mode

**Is the http:// URL a problem?** Yes, but only when two conditions meet: a key plus `http://` to a host outside your PC or network. Then the key travels unencrypted and anyone on the path can read it. It is not a problem for Ollama on `localhost`, your LAN, or Tailscale (Tailscale encrypts the tunnel).

**Done:**
- The app **refuses** to send a key over `http://` to a public host. Allowed: localhost, 10.x, 192.168.x, 172.16–31.x, Tailscale 100.64/10, `.local`, `.lan`, `.ts.net`.
- Settings shows the reason as you type.

**Amnesiac mode** (Settings → Privacidad, off by default):
- The API key lives only in memory for the session. It is never written to disk and is forgotten on quit, so you paste it each session.
- Switching the mode moves the current key between disk and memory, with nothing left behind.
- What it protects: someone copying your settings file or backups, or a shared PC. With amnesiac mode off, the key is still encrypted with Windows DPAPI, but anyone logged into your Windows account can decrypt it.
- What it does **not** protect: malware running as you while the app is open (it can read the memory) or the logs (which never contain the key).

**Also done:**
- The renderer never receives the key again, only `••••` plus the last 4 characters. A compromised page cannot read it.
- Logs auto-delete after 30 days (7/30/90/forever) and there is a "Borrar logs ahora" button.
- A one-line "what leaves your PC" notice is in Privacidad.

## 5. UI / UX critique and proposals

From the current screens (compact bar, full panel, settings, guide):

1. **Setting the state mid-game is typing-heavy.** `/civ`, `/vs`, `/edad` require the keyboard while you play.
   - Add 4 clickable chips in the compact bar: Mi civ · Rival · Mapa · Edad. Each opens a type-ahead; the age chip cycles Feudal→Castillos→Imperial with one click.
   - With match detection on, civs and map are already filled; only the age is left.
2. **The answer area is too small and the hierarchy is flat.** At 170 px the state line, the build-order line and the answer compete. Proposals:
   - The decision sentence in bold, larger type.
   - Details collapsed.
   - A "large text" option.
   - Auto-expand the bar height for long answers and shrink back after N seconds.
3. **The empty full panel wastes the space** (just a key warning). Use it as a home screen: 4 quick questions ("¿qué abro?", "¿qué me hace el rival?", "¿qué cambió en este parche para mi civ?", "revisá mi última partida"), the detected match card, and the patch status.
4. **Settings is one long scroll in a 470 px window**, and the most important thing (the key) is mixed with expert options. Proposals:
   - A 3-step first-run card: key → test → profile/match detection.
   - Settings split into Básico / Voz y atajos / Privacidad / Avanzado.
5. **Header icons are emoji** (🔊📖⤢×⚠). They render differently per Windows font and are hard to hit. Use one consistent icon set (SVG) with 28 px hit targets.
6. **The guide's "lo que no tiene" list is a wall of red chips** (22 for Franks). Group by building and collapse; lead with what the civ is good at. The WR/pick/tier badge is good: keep it.
7. **Trust signals are missing.** Show under each answer:
   - a META / ANTI-META / MEME chip when the advice is not meta;
   - "fuentes" (note titles with dates);
   - "auto" when the state came from match detection.

   The player should see *why* the advice is unusual or dated.
8. **Feedback.** Replace `/mal` with 👍/👎 on each answer, plus an optional comment.
9. **Cost in the meta line** ("$0.003 (sesión $0.02)") is useful to you but noise for a player. Move it to a tooltip or Settings, and show a monthly total.
10. **Errors** appear as red text. Add a "Reintentar" button and a plain cause ("sin internet", "key inválida", "límite del proveedor").
11. **Voice input.** F10 means typing. Push-to-talk with local Whisper would fit the in-game use best; it is the largest UX gain after match detection.
12. **Accessibility.** Check contrast of the muted text on the dark background (some greys are low). Make all actions keyboard-reachable.

Suggested order:
1. Chips plus the home screen (1, 3).
2. Trust signals and feedback (7, 8).
3. Settings split and onboarding (4).
4. Icons, guide cleanup and errors (5, 6, 10).
5. Push-to-talk (11).
