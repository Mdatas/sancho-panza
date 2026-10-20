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
- **Más builds paso a paso**: 36 civs no tienen ningún build específico y casi todo es Arabia/Arena. Tienen que venir de
  fuentes (videos/guías), no inventarse; la extracción automática desde las notas (`tools/condense.js`) cubre una parte.
- **Editor de builds** dentro de la app (crear/duplicar/editar pasos) y compartirlos. Hoy solo se importa JSON.
- **Pre-traducir los perfiles de civs y mapas** a los 6 idiomas en el build (una sola corrida de IA, ~US$5–10) para que en
  otros idiomas no haga falta la key ni el botón Traducir. Pendiente de decidir el gasto.
- **Estadísticas de civs por franja de ELO y refresco automático** (aoestats.io u otra fuente): hoy la tabla es una foto
  por parche. Hay que verificar los términos de uso de la fuente.
- **Las 5 imágenes de mapa que faltan** (Cross, Forest Breach, Snake Forest, Stranded, Twin Forests): no existen en las
  wikis; harían falta capturas propias.
- **Resúmenes por tema y por guía generados por IA** (`tools/themes.js`, `tools/condense.js`): corrida completa pendiente
  de aprobar el gasto (~US$5–6).

## Interfaz
- **Respuesta estructurada** (resumen de 3 líneas + detalle como campos de una herramienta en vez de texto con `---`):
  más robusto que el parser actual, pero cambia un flujo que hoy funciona; evaluar con pruebas reales antes.
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
