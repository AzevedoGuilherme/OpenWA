# rocaBianca · WhatsApp ↔ Claude bridge

1. `npm install`
2. `cp .env.example .env` y completá `ANTHROPIC_API_KEY`, `OPENWA_API_KEY` y `OPENWA_WEBHOOK_SECRET`.
3. En el `.env` de OpenWA agregá `SSRF_ALLOWED_HOSTS=localhost` (en Docker: `host.docker.internal`) y reiniciá OpenWA.
4. Registrá el webhook con el mismo secret en `http://localhost:3001/webhook` (en Docker: `http://host.docker.internal:3001/webhook`).
5. `npm run dev` (recarga al guardar) o `npm start`.
6. Cada `message.received` firmado se valida (HMAC, 401 si no coincide) y se responde con Claude Haiku 4.5.
7. Se ignoran mensajes propios, grupos, estados y mensajes sin texto (audio, fotos).
8. Errores 5xx se reintentan a los 500 ms, 1,5 s y 4 s; si Claude no responde se envía un mensaje de fallback.
9. Logs en JSON con tags `[webhook]`, `[claude]`, `[openwa]`, `[error]`. Salud: `GET /health`.
10. La personalidad y las reglas están en `SYSTEM_PROMPT` dentro de `bridge.js`.

## Asistente rocaBianca

- **Contexto:** antes de responder se leen los últimos 12 mensajes del chat desde OpenWA (`GET /api/sessions/{id}/messages?chatId=`), así Claude no vuelve a pedir datos ya dados.
- **Bajas:** `isOptOutMessage()` detecta pedidos de baja ("baja", "stop", "no me escriban más"…), responde una sola vez y bloquea el chat. Se guarda en `data/optouts.json` y sobrevive reinicios. Un saludo no reactiva el chat: hace falta un pedido explícito ("quiero retomar mi consulta"). Una misma persona puede aparecer con dos `chatId` (`@c.us` y `@lid`); la baja aplica al `chatId` que la pidió.
- **Ritmo de envío:** cada respuesta espera 5-15 s (+1 s cada 100 caracteres por encima de 200), y nunca salen dos respuestas al mismo chat en menos de 30 s. Esto se suma a la pausa "escribiendo…" de OpenWA (`SIMULATE_TYPING`).
- **Pausa nocturna:** `NIGHT_PAUSE_START`/`NIGHT_PAUSE_END` en `TZ`. Solo frena mensajes proactivos; las respuestas a clientes salen igual. Hoy el bridge no envía proactivos.
- **Derivación:** cuando Claude responde "Te paso con nuestro equipo…" se registra `[handoff]`. No avisa a nadie por sí solo: alguien tiene que mirar esos logs o el chat.

## Operación responsable del número

OpenWA usa una integración no oficial de WhatsApp. Nada de lo que hace este bridge garantiza que el número no sea restringido o bloqueado; son medidas operativas y de cumplimiento.

- Usá un número dedicado al negocio, no uno personal.
- Empezá con poco volumen y priorizá conversaciones que el cliente inició.
- No hagas envíos masivos ni escribas a listas sin consentimiento.
- Revisá reportes, bloqueos y bajas con frecuencia.
- Subí el volumen solo cuando haya actividad legítima que lo justifique.
- OpenWA trae un límite diario progresivo opcional (`SEND_PACING_*`, apagado por defecto). Este bridge no lo activa ni agrega uno propio.
