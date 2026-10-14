# Inbound system-event regression evidence

Encryption notices (`e2e_notification`, subtype `encrypt`) were mapped to `unknown` and forwarded as empty customer messages, triggering downstream automation. Filter these notices and ciphertext placeholders before persistence, callbacks, and contact enrichment. Also ignore unknown events without text or media.

Optional contact enrichment now has a 1.5-second deadline. Normal text delivery proceeds when enrichment stalls; a late result cannot dispatch a duplicate.

## Repeatable integration check

Run `npm ci` then `node qa/inbound/regression.cjs`. The fixture uses the actual event handler and a localhost HTTP sink with synthetic messages. It writes `artifacts/inbound-regression/result.json`.

Before the patch, the fixture observed nine unwanted webhook dispatches. After the patch, all six checks passed: system inbound/outgoing filtering, empty unknown filtering, normal text, media, bounded contact lookup, and no duplicate after late enrichment.

Additional verification on the patched 0.24.0 build: targeted ESLint, Nest build, and three existing related Jest suites (201 tests) passed. The integration fixture also passed against the compiled Docker handler without production volumes or external network access.

## Live verification

On 14 October 2026, a user-originated text at 15:00:09 WIB was verified in both OpenWA storage and the downstream console storage. This confirms delivery for that new message; it does not establish recovery of previously missing messages or browser rendering.
