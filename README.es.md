# Sancho Panza · AOE2 Squier

**Un coach con IA que se sienta al lado tuyo mientras jugás Age of Empires II: Definitive Edition.**
Escribís (o preguntás) qué está pasando en tu partida — "Soy francos vs mongoles en Edad de los Castillos y él hace Mangudai" — y en pocos segundos te responde qué hacer en los próximos dos minutos, en base a datos actuales del juego, ~1.000 videos y guías de jugadores top, y matemática de duelos. Puede leerte la respuesta en voz alta.

Leelo en: [English](README.md) · **Español**

| | |
|---|---|
| **Windows** | [Última versión](https://github.com/Mdatas/sancho-panza/releases/latest) → `AoE2Coach-…-setup.zip` → descomprimí → `Instalar.bat` |
| **Mac** (chip Apple o Intel) | [Última versión](https://github.com/Mdatas/sancho-panza/releases/latest) → `SanchoPanza-…-mac-arm64.zip` (M1–M4) o `…-mac-x64.zip` (Intel) |
| **Web / Android / iPhone** | https://mdatas.github.io/sancho-panza/ → menú del navegador → "Agregar a la pantalla principal" |
| **Idiomas** | Español · English · Deutsch · Português · 中文 · Tiếng Việt · 한국어 |
| **Licencia** | No comercial, compartir igual, juego limpio — ver [LICENSE](LICENSE) |

---

## Por qué existe

Esto se hizo **por curiosidad sobre lo que se puede hacer con IA — puramente por gusto y curiosidad intelectual.**
La pregunta era simple: ¿hasta dónde puede llegar una persona, hablando con una IA, construyendo una herramienta real que ayude a la gente a disfrutar y entender mejor un juego de estrategia de 25 años? Todo lo que hay acá — código, investigación, chequeo de datos, traducciones, esta página — se construyó conversando con Claude (Anthropic), con un humano decidiendo qué construir y revisando los resultados.

Es gratis, no tiene publicidad, no recolecta nada y va a seguir siendo no comercial.

## Lo que no es

* **No es un cheat ni un bot.** Nunca lee la memoria del juego, el tráfico de red ni la pantalla, y nunca hace clic ni escribe en el juego. Solo responde lo que *vos* le contás. La licencia prohíbe usarlo para hacer trampa o cualquier juego desleal.
* **No está afiliado** a Microsoft, World's Edge, Forgotten Empires ni a ningún creador de los que se acreditan más abajo.
* **No siempre tiene razón.** Es una IA: los números salen de herramientas con datos del juego, pero los consejos pueden estar mal. Te avisa cuando un tip es viejo, está fuera del meta o es un meme.

---

## Cómo funciona

```
 you ──(text or voice)──► app ──► 1. extracts the match facts (civs, age, map, armies, constraints)
                                  2. picks the relevant knowledge (civ & map profiles, notes, team counters)
                                  3. asks the AI with tools: counters, civ info, unit stats, eco plan, build orders, note search
                                  4. answer = 3-line summary + short detail, read aloud
```

* **Datos del juego** (todas las civs, unidades, tecnologías, bonus, costos, clases de armadura) salen de los archivos oficiales del juego tal como los publica [SiegeEngineers/aoe2techtree](https://github.com/SiegeEngineers/aoe2techtree), actualizados en cada parche. A la IA se le indica que nunca cite números de memoria: tiene que consultar las herramientas.
* **Matemática de duelos**: un motor propio simula duelos cuerpo a cuerpo a pie firme con clases de ataque/armadura, daño bonus, mejoras y costo, y rankea las mejores respuestas que tiene tu civ contra una unidad (con una corrección por kiteo para unidades a distancia vs cuerpo a cuerpo).
* **Base de conocimiento**: ~3.100 secciones de notas en castellano, resumidas de ~1.000 videos y guías (ver Fuentes). Cada nota tiene su **fecha de publicación** y un bloque de **VIGENCIA** chequeado contra el historial completo de parches hasta el parche actual (185872): qué cambió desde el video y qué es cierto hoy.
* **Meta / anti-meta / meme**: cada estrategia está etiquetada. META = estándar, alto porcentaje de victorias en tu nivel. ANTI-META = funciona bajo ciertas condiciones (mapa, civ, ELO, sorpresa). MEME = cheese para divertirse o para aprender a frenarlo. El coach dice el nivel y nunca vende un meme como el plan estándar.
* **Parches**: al iniciar (una vez por día) la app de escritorio lee el feed oficial de noticias de ageofempires.com; si aparece un parche nuevo de AoE2, guarda el texto oficial como nota y el coach lo lee antes de citar números.

## Funciones

**Coach por chat**
* Overlay compacto que queda arriba del juego (ventana sin bordes), o ventana completa.
* Las respuestas arrancan con un **resumen de 3 líneas** (decisión · qué hacer, con números · el dato clave), y después un detalle corto.
* **Voz**: voces neuronales naturales (Microsoft Edge, gratis) en cada idioma — Elena (Argentina) por defecto; sin conexión usa la voz del sistema. Un botón 🔊 en cada respuesta la vuelve a leer.
* Recuerda el estado de la partida durante la sesión y pregunta solo lo que necesita ("Para afinar: ¿tu ELO?").
* Explicaciones amigables cuando falla la API key (falta, inválida, sin crédito, límite de uso, sin conexión).

**Barra de equipo 4 vs 4**
* Configurá tu civ, hasta 3 aliados y hasta 4 enemigos (hacé clic en un casillero, escribí `/allies` `/enemies`, o simplemente decilo).
* Para cada civ enemiga calcula sus unidades principales probables en tu edad (unidad única + líneas características) y **tus mejores counters** para cada una, con íconos.

**Build orders**
* 41 builds paso a paso (Hera, Morley Games, DauT, TaToH…) que avanzan con F7/F8 y se pueden leer en voz alta.
* ~640 guías de builds/estrategia sacadas de videos, navegables como tarjetas con filtros: civ, tipo (Scouts, Arqueros, Drush, Fast Castle, Torres, TC drop, Castle drop, Agua, Boom…), fuente y meta/anti-meta/meme. Cada una se abre con lo que enseña y lo que cambió desde entonces.
* Importá tus propios builds (buildorderguide.com / RTS Overlay JSON).

**Guía visual** (📖)
* 56 civs con íconos: unidades por edificio, qué les falta, edades fuertes, porcentaje de victorias.
* 129 mapas con perfiles.
* Calculadora de counters "¿Qué le gana a…?" con stats de unidades.
* Tabla del meta (porcentaje de victorias y de elección por civ, parche actual).
* Búsqueda de texto completo en todas las notas.

**Detección de partida opcional**
* Desactivada por defecto. Si configurás tu perfil público de AoE2, lee tu partida actual (civs, mapa, equipos) desde el servicio comunitario aoe2companion y completa lo que no escribiste. Lo que vos ingresás siempre tiene prioridad.

**La IA que elijas**
* Claude (Anthropic) por defecto — con la que se construyó y se probó.
* También OpenAI, Google Gemini, Groq, OpenRouter, NVIDIA NIM, modelos locales (Ollama / LM Studio / llama.cpp / Hermes) o cualquier endpoint compatible con OpenAI. Algunos tienen planes gratuitos.

**Privacidad**
* La app viene **sin API key**. Cada usuario trae la suya; queda en su dispositivo (cifrada en escritorio; en el almacenamiento local del navegador en la versión web).
* Lo que sale de tu dispositivo: tus preguntas y las notas relevantes van al proveedor de IA que elegiste; el texto de las respuestas va a Microsoft solo si usás la voz de Edge; tu id de perfil va a aoe2companion solo si activás la detección de partida. No se le envía nada al autor.
* Los registros de conversación quedan en tu computadora, con borrado automático opcional.

## Versiones

| | Windows | Mac | Web (PWA) |
|---|---|---|---|
| Overlay arriba del juego | ✅ | ✅ (también sobre pantalla completa) | — (usá el celular como segunda pantalla) |
| Atajos globales F6–F10 | ✅ | ✅ (con `fn` o "teclas de función estándar") | — |
| Voz | Edge neuronal + Windows SAPI | Edge neuronal + macOS `say` | voz del navegador / sistema |
| Chat, barra de equipo, build orders, guía | ✅ | ✅ | ✅ |
| Seguimiento de parches | ✅ | ✅ | notas revisadas hasta la versión publicada |
| Instalación | descomprimí + `Instalar.bat` | descomprimí → Aplicaciones → *Privacidad y seguridad* → "Abrir de todos modos" (la app no está notarizada) | abrí el link → "Agregar a la pantalla principal" |

**Comandos** (o simplemente decilo en tu pregunta): `/civ franks` · `/vs mongols` · `/age castle` · `/map arabia` · `/elo 1100` · `/allies mayans, britons` · `/enemies mongols, aztecs` · `/counters` · `/bo scouts` · `/n` `/p` · `/guide` · `/repeat` · `/match` · `/patch` · `/new` · `/help`
(en castellano también: `/civ francos` · `/vs mongoles` · `/edad castillos` · `/mapa arabia` · `/aliados` · `/rivales` · `/repetir` · `/partida` · `/parche` · `/nueva` · `/ayuda`)

---

## Fuentes de información

Cada fuente está acreditada dentro de las notas, video por video, con su link y fecha de publicación. Las estrategias e ideas son de sus creadores; las notas son resúmenes, no copias. Los creadores que prefieran no ser incluidos pueden abrir un issue.

**Datos del juego y build orders**
* [SiegeEngineers/aoe2techtree](https://github.com/SiegeEngineers/aoe2techtree) — civs, unidades, tecnologías, stats e íconos de los archivos del juego (MIT).
* [CraftySalamander/rtsbuilds](https://github.com/CraftySalamander/rtsbuilds) — build orders paso a paso de Hera, Morley Games, DauT, TaToH y otros (GPL-3.0, autores acreditados en cada archivo).
* Notas de parche y noticias oficiales — [ageofempires.com](https://www.ageofempires.com/) y [forums.ageofempires.com](https://forums.ageofempires.com/); historial completo de parches 2019–2026 contrastado con [ageofempires.fandom.com](https://ageofempires.fandom.com/).

**Videos (YouTube), resumidos a partir de sus subtítulos**
* **Hera** — "So You Want To Play" (34 guías de civs), "AoE2 Coaching" (69 análisis de partidas), "New Player Friendly" (16), "Build Orders" (10), "Ultimate Guide To 2k" (2021, 9 episodios), "Hera's Guide To 2k" (2025).
* **Spirit Of The Law** — ~264 videos: todas las civs, todas las unidades únicas, mecánicas del juego y matemática.
* **TaToH** — "0 a 2000" (7) y "Aprendamos 2026" (16), en castellano.
* **El Biry** — "Curso Age of Empires 2" y "Aprendiendo a robar y explorar" (15), en castellano.
* **aoe2matchup** — simulaciones de combate unidad contra unidad (34 videos) y [aoe2matchup.com](https://aoe2matchup.com).
* **Resonance22** — "Aoe2: Break the Meta" (24 estrategias cheese clásicas, pre-DE).
* **Poop Lord** — "every unique strategy" (362 de 408 videos), "Book of Memes", "Ultimate AOE2 Meme Guide", "5 Fun Meme Strats", "Slow and Clean Team Game Strat", "New 2025", "New 2026", "Legend of the game!" (26) — etiquetados como meme/anti-meta.

**Sitios web y datos**
* [aoecoach.com](https://aoecoach.com) — guías para civs nuevas, meta naval y cómo jugar/counterear ~50 civs.
* [ageofnotes.com](https://ageofnotes.com/stats/) — porcentaje de victorias por civ y por mapa en el parche actual (datos no oficiales del ladder).
* [aoe2insights.com](https://www.aoe2insights.com), [aoe2db.com](https://aoe2db.com), [aoestats.io](https://aoestats.io), [aoe2recs.com](https://aoe2recs.com), [guildorder.com](https://guildorder.com), el substack de Age of Empires y otras referencias de la comunidad citadas en las notas (cada dato lleva su URL).
* API pública de aoe2companion (`data.aoe2companion.com`) — detección de partida opcional.
* Una guía de estrategia de *Alexander the Conqueror* aportada por el autor.
* Comparación de planes gratuitos de APIs de IA (octubre de 2026) — dev.to/tariqnasser, citada en la app.

---

## Cómo se hizo

Construido en 2026 por **M** **conversando con Claude (Anthropic)**, dentro de la app de Claude con sus herramientas agénticas: Claude escribió y probó el código, investigó fuentes, corrió agentes de investigación en paralelo y chequeó sus propios datos; M decidió qué construir, lo probó en partidas reales y corrigió el rumbo.

**Pipeline de investigación.** Los agentes abrieron cada video de YouTube en un navegador Chrome real (Claude in Chrome), leyeron los subtítulos y escribieron una nota en castellano por video con fecha, lecciones y el build order si lo había. Una segunda pasada chequeó cada afirmación que depende del balance contra el historial de parches y los datos actuales del juego, escribiendo el bloque de VIGENCIA. Los videos sin subtítulos se saltearon y quedaron registrados, nunca se adivinaron. Un script de auditoría revisa toda la base de conocimiento en busca de contradicciones (por ejemplo, elementos eliminados del juego que se siguen dando como consejo).

**Herramientas, y por qué estas en lugar de las alternativas**

| Necesidad | Elegida | Por qué (vs. alternativas) |
|---|---|---|
| App de escritorio para Windows **y** Mac con un overlay arriba del juego y atajos globales | **Electron** | Una sola base de código JavaScript para ambos sistemas y reutilizable en la web. Tauri sería más liviano pero necesita un toolchain de Rust y se comporta distinto según el webview de cada sistema operativo; WPF/.NET es solo para Windows; Python + Qt es más difícil de empaquetar y de reutilizar en un navegador. |
| Interfaz | HTML/CSS/JS puro | Sin framework, sin paso de build para escritorio, fácil de leer y de portar. |
| El "cerebro" | **Claude API** (tool use) por defecto, cualquier proveedor compatible con OpenAI como opción | En las pruebas, Claude fue el que usó de forma más confiable las herramientas del coach (counters, info de civs, builds); las opciones gratuitas/locales lo mantienen accesible. |
| La verdad sobre los números | Datos del juego de aoe2techtree + motor de duelos propio | Los parches cambian los números todo el tiempo; la memoria de los modelos está desactualizada, así que los números tienen que salir de los datos. |
| Voz | TTS neuronal de Microsoft Edge (vía `msedge-tts`), SAPI / `say` sin conexión, voz del navegador en la web | Voces naturales en todos los idiomas gratis, con alternativa sin conexión. |
| Web / celulares | El mismo renderer + un shim para navegador, empaquetado con **esbuild**, alojado en **GitHub Pages** como PWA | Una sola base de código, sin servidor, sin costo, instalable en Android e iOS. |
| Empaquetado | electron-builder; el instalador de Windows descarga el runtime de Electron y verifica su SHA-256; apps de Mac con firma ad-hoc usando `rcodesign` | Descargas chicas; no hacen falta certificados pagos. |
| Tests | Scripts de test en Node + un smoke test headless de la app real (Electron + xvfb), Playwright para la versión web | Cada versión se chequea antes de publicarse, incluido un escaneo de que no haya ninguna API key dentro de ningún paquete. |

## Compilar desde el código fuente

```bash
npm install
npm test                 # engine, knowledge, integrations, strategy, brain, team tests
npm start                # run the desktop app
npm run dist:win         # Windows build (zip)
npx electron-builder --mac zip --arm64 --x64   # Mac build
npm run build:web        # web version → docs/ (GitHub Pages)
```

Estructura del repositorio: `src/main` (motor, cerebro de IA, voz, sincronización de datos), `src/renderer` (interfaz y traducciones), `data` (datos del juego, build orders, notas de conocimiento, íconos), `web` (versión para navegador), `docs` (app web publicada), `installer` (instalador de Windows), `test`.

## Contribuir

Las correcciones son muy bienvenidas — sobre todo de traducciones (hechas con IA) y de notas de estrategia desactualizadas. Abrí un issue o un pull request. Según la [licencia](LICENSE), cualquier versión modificada tiene que publicarse, darle crédito a este proyecto y seguir siendo no comercial.

## Créditos

Idea, pruebas y dirección: **M** ([Mdatas](https://github.com/Mdatas)). Construido con **Claude** (Anthropic).
Gracias a cada creador listado en *Fuentes* — esta herramienta existe solo porque ellos comparten su conocimiento gratis.
Age of Empires II: Definitive Edition © Microsoft Corporation. Sancho Panza · AOE2 Squier se creó bajo las "Game Content Usage Rules" de Microsoft usando recursos de Age of Empires II. No está respaldado por Microsoft ni afiliado a Microsoft.
