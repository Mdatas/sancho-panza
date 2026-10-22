# Ideas a considerar en próximas versiones

Registro de lo que se revisó y **no** se aplicó (todavía). No son compromisos ni un orden de trabajo: son cosas a
considerar cuando toque. Viene de la revisión completa de la v0.18 → v0.19 (octubre 2026). Cuando algo de acá se haga,
se borra de esta lista y queda en las notas de la versión.

## Análisis de las partidas del jugador
- **Leer replays (`.aoe2record`)**: hoy las partidas propias no alimentan nada. Con un parser abierto (p. ej. `mgz`) se
  podría sacar tiempo de subida a cada edad, aldeanos a los 10/14/20 min, TC ocioso, recursos flotando, primer militar y qué
  hizo el rival, y compararlo con los benchmarks por build. Es la mejora grande (1–2 semanas); primero post-partida, después
  tal vez en vivo. Requiere un parser en JS o empaquetar Python.
- **Historial del rival** (aoe2companion): avisar "este rival abre scouts el 70 % de las veces". Depende de endpoints que
  todavía no se verificaron.
- **Map pool ranked actual**: priorizar en la Guía y en los builds los mapas de la rotación vigente. Mismo problema de
  endpoint.

## Contenido
- **Más builds paso a paso**: muchas civs no tienen ningún build específico y casi todo es Arabia/Arena. Tienen que venir
  de fuentes (videos/guías), no inventarse; la extracción automática desde las notas (`tools/condense.js`, v0.20) sacó 25
  builds de las ~640 notas (el resto no enuncia una secuencia con asignación de aldeanos). Lo que falta son más fuentes.
- **Editor de builds** dentro de la app (crear/duplicar/editar pasos) y compartirlos. Hoy solo se importa JSON.
- **Pre-traducir los perfiles de civs y mapas** a los 6 idiomas en el build (una sola corrida de IA, ~US$5–10) para que en
  otros idiomas no haga falta la key ni el botón Traducir. Pendiente de decidir el gasto.
- **Estadísticas de civs por franja de ELO y refresco automático** (aoestats.io u otra fuente): hoy la tabla es una foto
  por parche. Hay que verificar los términos de uso de la fuente.
- **Las 5 imágenes de mapa que faltan** (Cross, Forest Breach, Snake Forest, Stranded, Twin Forests): no existen en las
  wikis; harían falta capturas propias.
- **Regenerar los resúmenes por tema y por guía** (`tools/themes.js`, `tools/condense.js`, hechos en v0.20) cuando se
  sumen notas nuevas o cambie el parche: los scripts son idempotentes (saltean lo ya resumido por hash), pero una corrida
  completa cuesta ~US$8–9 en API, así que conviene correrlos por lotes (`--only`, `--tier`).

## Interfaz
- **Respuesta libre como campos de una herramienta** (resumen de 3 líneas + detalle estructurados en vez de texto con `---`):
  más robusto que el parser actual, pero cambia un flujo que hoy funciona; evaluar con pruebas reales antes. (La **ficha de
  partida** de la v0.22 ya cubre el caso determinista; esto es para el modo libre.)
- **Entrada por voz** (hablarle al coach en vez de escribir): hotkey push-to-talk → Groq Whisper (gratis, ~1 s) o Whisper
  local; el texto reconocido entra como un mensaje más. Pendiente de decidir el proveedor y la privacidad del audio.
- **Lectura de pantalla (v0.22–0.23) — siguientes pasos**: el motor local (Tesseract, v0.23) se afinó sólo con capturas
  sintéticas del HUD a 1080p y 864p; falta validarlo con **capturas reales** (1080p/1440p/4K, escala de HUD 100 % y
  distinta, modos de UI del juego, mods de HUD) y ajustar umbral/segmentación con ellas — pedirle al jugador 3–4 capturas.
  Después: leer la barra de edad/tiempo cuando está separada; detectar el panel de aldeanos ociosos; versión web con
  `getDisplayMedia`; cortar el ciclo cuando la app está en segundo plano mucho tiempo; probar el motor IA con proveedores
  gratuitos (Groq/Gemini: sin key acá, no se probó).
- **Modos de respuesta (v0.23) — siguientes pasos**: un **proveedor por tarea** (uno gratis/local para interpretar el
  mensaje y el OCR, Claude para el consejo); mejorar el lector local de palabras clave con las frases que fallen en uso
  real (hoy cubre civs/mapas/unidades es+en, roles «soy/vs/aliados», edad, ELO, ejército rival).
- **Ficha de partida (v0.22) — siguientes pasos**: mostrar la ficha en la pestaña Guía (hoy vive en el chat); builds
  sugeridos por rival (hoy: civ + mapa + apertura del perfil); más builds paso a paso de agua, Nomad e híbridos en el
  catálogo (hoy hay pocos y la ficha cae en guías); contraste de la ficha con el replay cuando exista el lector de replays.
- **Build orders (v0.23) — siguientes pasos**: probar la tarjeta del paso en partidas reales (tamaño de letra en el
  overlay a 1440p/4K); un filtro «sólo los que encajan» además del grupo «Para tu partida»; recordar el último build por
  civ+mapa.
- **Atajos por defecto**: F10 es el menú del juego en AoE2 DE. Hoy se avisa del choque en Ajustes; cambiar los valores
  por defecto afectaría la costumbre de quien ya los usa.
- **Claves i18n semánticas** (`g.h.p.6` → `guide.pickCiv`): 418 claves × 7 idiomas; mucho riesgo de romper textos para
  poco beneficio ahora.
- **Carga de la web en un Worker** (parsear las notas fuera del hilo principal): hoy se minimizó y dividió el bundle; el
  Worker sería el siguiente paso si los celulares viejos siguen tardando.

## Infraestructura (acciones del dueño del repo o con costo)
- **Dominio propio** para la web (hoy `mdatas.github.io` es un origen compartido con cualquier otra página del usuario).
- **Firma de código** Windows/Mac (SmartScreen/Gatekeeper dejan de avisar): Azure Trusted Signing ~US$10/mes o certificado
  OV; notarización en Mac.
- **Publicar GitHub Pages desde un artefacto de CI** en vez de commitear `docs/` (19 MB por versión): hay que cambiar la
  configuración de Pages en el repo.
- **Reemplazar `msedge-tts`** (endpoint no documentado de Microsoft, puede romperse) por una alternativa estable o por la
  voz del sistema como principal.

## Datos del juego
- **Tasas de recolección y economía** están fijas en el código (revisadas para el parche 185872); no hay fuente estructurada
  que las publique por parche. Revisarlas a mano en cada parche grande.
- **Chequeo de VIGENCIA automático**: cuando sale un parche, listar las notas que mencionan unidades/civs tocadas (diff de
  los datos de aoe2techtree entre commits) para revisarlas primero. Hoy el parche se lee pero las notas se revisan a mano.
