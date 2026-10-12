# rocaBianca · WhatsApp ↔ Claude bridge

1. `npm install`
2. `cp .env.example .env` y completá `ANTHROPIC_API_KEY`, `OPENWA_API_KEY` y `OPENWA_WEBHOOK_SECRET`.
3. En el `.env` de OpenWA agregá `SSRF_ALLOWED_HOSTS=localhost` (si no, rechaza webhooks a localhost) y reiniciá OpenWA.
4. Registrá el webhook en OpenWA apuntando a `http://localhost:3001/webhook` con el mismo secret.
5. `npm run dev` (recarga al guardar) o `npm start`.
6. Cada `message.received` firmado se valida (HMAC, 401 si no coincide) y se responde con Claude Haiku 4.5.
7. Se ignoran mensajes propios, grupos, estados y mensajes sin texto (audio, fotos).
8. Errores 5xx se reintentan a los 500 ms, 1,5 s y 4 s; si Claude no responde se envía un mensaje de fallback.
9. Logs en JSON con tags `[webhook]`, `[claude]`, `[openwa]`, `[error]`. Salud: `GET /health`.
10. La personalidad y las reglas están en `SYSTEM_PROMPT` dentro de `bridge.js`.
