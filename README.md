# Sancho Panza · AOE2 Squier

**An AI coach that sits next to you while you play Age of Empires II: Definitive Edition.**
You type (or ask) what is happening in your game — "I'm Franks vs Mongols in Castle Age and he makes Mangudai" — and it answers in a few seconds with what to do in the next two minutes, based on current game data, ~1,000 videos and guides from top players, and duel maths. It can read the answer aloud.

Read this in: **English** · [Español](README.es.md)

| | |
|---|---|
| **Windows** | [Latest release](https://github.com/Mdatas/sancho-panza/releases/latest) → `AoE2Coach-…-setup.zip` → unzip → `Instalar.bat` |
| **Mac** (Apple chip or Intel) | [Latest release](https://github.com/Mdatas/sancho-panza/releases/latest) → `SanchoPanza-…-mac-arm64.zip` (M1–M4) or `…-mac-x64.zip` (Intel) |
| **Web / Android / iPhone** | https://mdatas.github.io/sancho-panza/ → browser menu → "Add to Home screen" |
| **Languages** | Español · English · Deutsch · Português · 中文 · Tiếng Việt · 한국어 |
| **License** | Non-commercial, share-alike, fair-play — see [LICENSE](LICENSE) |

---

## Why it exists

This was made **out of curiosity about what can be done with AI — purely for joy and intellectual curiosity.**
The question was simple: how far can one person get, talking to an AI, building a real tool that helps people enjoy and understand a 25-year-old strategy game better? Everything here — code, research, data checks, translations, this page — was built in conversation with Claude (Anthropic), with a human deciding what to build and checking the results.

It is free, it has no ads, it collects nothing, and it will stay non-commercial.

## What it is not

* **Not a cheat or a bot.** It never reads the game's memory, network traffic or screen, and never clicks or types in the game. It only answers what *you* tell it. The license forbids using it for cheating or any unfair play.
* **Not affiliated** with Microsoft, World's Edge, Forgotten Empires or any creator credited below.
* **Not always right.** It is an AI: numbers come from game data tools, but advice can be wrong. It tells you when a tip is old, off-meta or a meme.

---

## How it works

```
 you ──(text or voice)──► app ──► 1. extracts the match facts (civs, age, map, armies, constraints)
                                  2. picks the relevant knowledge (civ & map profiles, notes, team counters)
                                  3. asks the AI with tools: counters, civ info, unit stats, eco plan, build orders, note search
                                  4. answer = 3-line summary + short detail, read aloud
```

* **Game data** (all civs, units, techs, bonuses, costs, armour classes) comes from the official game files as published by [SiegeEngineers/aoe2techtree](https://github.com/SiegeEngineers/aoe2techtree), updated every patch. The AI is told never to quote numbers from memory: it must ask the tools.
* **Duel maths**: an own engine simulates stand-and-fight duels with attack/armour classes, bonus damage, upgrades and cost, and ranks the best answers your civ has against a unit (with a kiting correction for ranged vs melee).
* **Knowledge base**: ~3,100 sections of notes in Spanish, summarised from ~1,000 videos and guides (see Sources). Every note has its **publish date** and a **VIGENCIA** (validity) block checked against the full patch history up to the current patch (185872): what changed since the video and what is true today.
* **Meta / anti-meta / meme**: every strategy is tagged. META = standard, high win rate at your level. ANTI-META = works under conditions (map, civ, ELO, surprise). MEME = cheese for fun or to learn how to stop it. The coach says the tier and never sells a meme as the standard plan.
* **Patches**: on start (once a day) the desktop app reads the official news feed of ageofempires.com; if a new AoE2 patch appears it saves the official text as a note and the coach reads it before quoting numbers.

## Features

**Chat coach**
* Compact overlay that stays on top of the game (borderless window), or a full window.
* Answers start with a **3-line summary** (decision · what to make, with numbers · the key fact), then a short detail.
* **Voice**: natural neural voices (Microsoft Edge, free) in each language — Elena (Argentina) by default; offline fallback to the system voice. A 🔊 button inside every answer re-reads it.
* Remembers the match state for the session and asks only what it needs ("To refine: your ELO?").
* Friendly explanations when the API key fails (missing, invalid, no credit, rate limit, offline).

**4 vs 4 team bar**
* Set your civ, up to 3 allies and up to 4 enemies (click a slot, type `/allies` `/enemies`, or just say it).
* For each enemy civ it computes their likely main units at your age (unique unit + signature lines) and **your best counters** to each, with icons.

**Build orders**
* 41 step-by-step builds (Hera, Morley Games, DauT, TaToH…) that advance with F7/F8 and can be read aloud.
* ~640 build/strategy guides from videos, browsable as cards with filters: civ, type (Scouts, Archers, Drush, Fast Castle, Towers, TC drop, Castle drop, Water, Boom…), source, and meta/anti-meta/meme. Each opens with what it teaches and what changed since.
* Import your own builds (buildorderguide.com / RTS Overlay JSON).

**Visual guide** (📖)
* 56 civs with icons: units by building, what they lack, strong ages, win rates.
* 129 maps with profiles.
* "What beats…?" counter calculator with unit stats.
* Meta table (win rate and pick rate per civ, current patch).
* Full-text search over all notes.
* The interface is translated into all 7 languages. Civ/map profiles and notes are written in Spanish: in any other language a 🌐 *Translate* button on each section translates it with your own AI key (a fraction of a cent per section, cached on your device).

**Optional match detection**
* Off by default. If you set your public AoE2 profile, it reads your current match (civs, map, teams) from the community service aoe2companion and fills what you have not typed. Your own input always wins.

**Your choice of AI**
* Claude (Anthropic) by default — the one it was built and tested with.
* Also OpenAI, Google Gemini, Groq, OpenRouter, NVIDIA NIM, local models (Ollama / LM Studio / llama.cpp / Hermes) or any OpenAI-compatible endpoint. Some have free tiers.

**Privacy**
* The app ships with **no API key**. Each user brings their own; it stays on their device (encrypted on desktop; in the browser's local storage on the web version).
* What leaves your device: your questions and the relevant notes go to the AI provider you chose; answer text goes to Microsoft only if you use the Edge voice; your profile id goes to aoe2companion only if you turn on match detection. Nothing is sent to the author.
* Conversation logs stay on your computer, with optional automatic deletion.

## Versions

| | Windows | Mac | Web (PWA) |
|---|---|---|---|
| Overlay on top of the game | ✅ | ✅ (also over full-screen) | — (use the phone as a second screen) |
| Global hotkeys F6–F10 | ✅ | ✅ (with `fn` or "standard function keys") | — |
| Voice | Edge neural + Windows SAPI | Edge neural + macOS `say` | browser / system voice |
| Chat, team bar, build orders, guide | ✅ | ✅ | ✅ |
| Patch watch | ✅ | ✅ | notes reviewed up to the release |
| Install | unzip + `Instalar.bat` | unzip → Applications → *Privacy & Security* → "Open Anyway" (app is not notarised) | open the link → "Add to Home screen" |

**Commands** (or just say it in your question): `/civ franks` · `/vs mongols` · `/age castle` · `/map arabia` · `/elo 1100` · `/allies mayans, britons` · `/enemies mongols, aztecs` · `/counters` · `/bo scouts` · `/n` `/p` · `/guide` · `/repeat` · `/match` · `/patch` · `/new` · `/help`

---

## Sources of information

Every source is credited inside the notes, video by video, with its link and publish date. Strategies and ideas belong to their creators; the notes are summaries, not copies. Creators who prefer not to be included can open an issue.

**Game data and build orders**
* [SiegeEngineers/aoe2techtree](https://github.com/SiegeEngineers/aoe2techtree) — civs, units, techs, stats and icons from the game files (MIT).
* [CraftySalamander/rtsbuilds](https://github.com/CraftySalamander/rtsbuilds) — step-by-step build orders by Hera, Morley Games, DauT, TaToH and others (GPL-3.0, authors credited in each file).
* Official patch notes and news — [ageofempires.com](https://www.ageofempires.com/) and [forums.ageofempires.com](https://forums.ageofempires.com/); complete patch history 2019–2026 cross-checked with [ageofempires.fandom.com](https://ageofempires.fandom.com/).

**Videos (YouTube), summarised from their captions**
* **Hera** — "So You Want To Play" (34 civ guides), "AoE2 Coaching" (69 game reviews), "New Player Friendly" (16), "Build Orders" (10), "Ultimate Guide To 2k" (2021, 9 episodes), "Hera's Guide To 2k" (2025).
* **Spirit Of The Law** — ~264 videos: every civ, every unique unit, game mechanics and maths.
* **TaToH** — "0 a 2000" (7) and "Aprendamos 2026" (16), in Spanish.
* **El Biry** — "Curso Age of Empires 2" and "Aprendiendo a robar y explorar" (15), in Spanish.
* **aoe2matchup** — unit-vs-unit combat simulations (34 videos) and [aoe2matchup.com](https://aoe2matchup.com).
* **Resonance22** — "Aoe2: Break the Meta" (24 classic cheese strategies, pre-DE).
* **Poop Lord** — "every unique strategy" (362 of 408 videos), "Book of Memes", "Ultimate AOE2 Meme Guide", "5 Fun Meme Strats", "Slow and Clean Team Game Strat", "New 2025", "New 2026", "Legend of the game!" (26) — tagged as meme/anti-meta.

**Websites and data**
* [aoecoach.com](https://aoecoach.com) — guides for new civs, naval meta and how to play/counter ~50 civs.
* [ageofnotes.com](https://ageofnotes.com/stats/) — civ and map win rates for the current patch (unofficial ladder data).
* [aoe2insights.com](https://www.aoe2insights.com), [aoe2db.com](https://aoe2db.com), [aoestats.io](https://aoestats.io), [aoe2recs.com](https://aoe2recs.com), [guildorder.com](https://guildorder.com), the Age of Empires substack and other community references cited in the notes (each fact carries its URL).
* aoe2companion public API (`data.aoe2companion.com`) — optional match detection.
* A strategy guide by *Alexander the Conqueror* contributed by the author.
* Free-tier comparison of AI APIs (October 2026) — dev.to/tariqnasser, cited in the app.

---

## How it was made

Built in 2026 by **M** **in conversation with Claude (Anthropic)**, inside the Claude app with its agentic tools: Claude wrote and tested the code, researched sources, ran parallel research agents and checked its own data; M decided what to build, tested it in real games and corrected course.

**Research pipeline.** Agents opened each YouTube video in a real Chrome browser (Claude in Chrome), read the captions, and wrote a Spanish note per video with date, lessons and the build order if any. A second pass checked every balance-dependent claim against the patch history and the current game data, writing the VIGENCIA block. Videos without captions were skipped and logged, never guessed. An audit script checks the whole knowledge base for contradictions (e.g. items removed from the game still given as advice).

**Tools, and why these instead of the alternatives**

| Need | Chosen | Why (vs. alternatives) |
|---|---|---|
| Desktop app for Windows **and** Mac with an overlay on top of the game and global hotkeys | **Electron** | One JavaScript codebase for both systems and reusable on the web. Tauri would be lighter but needs a Rust toolchain and behaves differently per OS webview; WPF/.NET is Windows-only; Python + Qt is harder to package and to reuse in a browser. |
| UI | Plain HTML/CSS/JS | No framework, no build step for desktop, easy to read and to port. |
| The "brain" | **Claude API** (tool use) by default, any OpenAI-compatible provider optional | Claude used the coach's tools (counters, civ info, builds) most reliably in tests; free/local options keep it accessible. |
| Truth about numbers | aoe2techtree game data + own duel engine | Patches change numbers constantly; models' memory is outdated, so numbers must come from data. |
| Voice | Microsoft Edge neural TTS (via `msedge-tts`), SAPI / `say` offline, browser speech on web | Natural voices in every language for free, with an offline fallback. |
| Web / phones | Same renderer + a browser shim, bundled with **esbuild**, hosted on **GitHub Pages** as a PWA | One codebase, no server, no cost, installable on Android and iOS. |
| Packaging | electron-builder; Windows installer downloads the Electron runtime and checks its SHA-256; Mac apps ad-hoc signed with `rcodesign` | Small downloads; no paid certificates needed. |
| Tests | Node test scripts + a headless smoke test of the real app (Electron + xvfb), Playwright for the web version | Every release is checked before shipping, including a scan that no API key is inside any package. |

## Build from source

```bash
npm install
npm test                 # engine, knowledge, integrations, strategy, brain, team tests
npm start                # run the desktop app
bash scripts/package-win.sh   # Windows package → out/
bash scripts/package-mac.sh   # Mac packages → out/ (ad-hoc signed)
npm run build:web        # web version → docs/ (GitHub Pages)
```

**Releases are automatic:** when the `version` in `package.json` changes on `main`, `.github/workflows/release.yml` tests the app, builds Windows and Mac on GitHub's servers and publishes release `v<version>` with the text in `release-notes/v<version>.md`.

Repository layout: `src/main` (engine, AI brain, voice, data sync), `src/renderer` (UI and translations), `data` (game data, build orders, knowledge notes, icons), `web` (browser version), `docs` (published web app), `installer` (Windows installer), `test`.

## Contributing

Corrections are very welcome — especially translations (made with AI) and outdated strategy notes. Open an issue or a pull request. Under the [license](LICENSE), any modified version must be published, credit this project and stay non-commercial.

## Credits

Idea, testing and direction: **M** ([Mdatas](https://github.com/Mdatas)). Built with **Claude** (Anthropic).
Thanks to every creator listed in *Sources* — this tool only exists because they share their knowledge for free.
Age of Empires II: Definitive Edition © Microsoft Corporation. Sancho Panza · AOE2 Squier was created under Microsoft's "Game Content Usage Rules" using assets from Age of Empires II. It is not endorsed by or affiliated with Microsoft.
