# Intervals.icu account connection (RUN-39)

For the canonical mapping contract, supported subset, manual probe payload and
Forerunner 165 verification procedure, see [RUN-40 workout mapping](intervals-workout-mapping.md).

Intervals.icu is the outbound bridge for scheduled structured workouts. Completed Garmin Activities and Health data come directly from the existing Garmin Personal API integration, initiated manually by the owner through Sync now / Import / Resume / Retry. An Intervals.icu account is never required to read or import that data. There is no Intervals.icu activity or wellness ingestion, Cron, or background polling.

## Authentication decision — 2026-11-14

The provider supports OAuth 2.0 and recommends it for multi-user apps. Its current registration process requires an application at <https://intervals.icu/oauth/apply> and provider approval before authorization works. This repository has no registered OAuth client configuration or OAuth credential lifecycle in the RUN-21 vault. RUN-39 therefore implements the ticket's personal API key fallback for this private invite-only MVP, reusing the existing encrypted, owner-scoped vault. This is a deployment choice, not a claim that OAuth is unsupported. Prefer a registered, approved OAuth app before broader distribution.

The provider's [API access guide](https://forum.intervals.icu/t/api-access-to-intervals-icu/609) documents personal API keys, Basic authentication with literal username `API_KEY`, and athlete `0` resolving to the authenticated account. Its [OAuth guide](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759) also confirms personal-key access to a user's own data. The [API terms](https://forum.intervals.icu/t/intervals-icu-api-terms-and-conditions/114087) apply. Each athlete supplies a key from their own account; never configure an app-wide key or a coach's key to address another athlete.

For an eventual OAuth implementation, planned workout publication needs `CALENDAR:WRITE` (which implies calendar read access). The RUN-40 delivery preflight also needs settings access and, when provisioning missing fields, `SETTINGS:WRITE`; the provider [documents this permission for sport-settings updates](https://forum.intervals.icu/t/api-access-to-intervals-icu/609/101). No `ACTIVITY`, `WELLNESS`, `CHATS` or `LIBRARY` access is required. OAuth tokens must be stored encrypted per owner, with state/PKCE protection and provider-side disconnect; OAuth is not implemented here. Personal keys are broader than those scopes. Connect/Test retain a read-only calendar check; the separately invoked delivery preparation uses Run sport settings.

## Athlete setup

1. Sign in to your own Intervals.icu account. In [Settings](https://intervals.icu/settings), find Developer Settings near the bottom and generate/copy your personal API key.
2. In Running Coach Settings → Intervals.icu, select **Connect Intervals.icu** and paste the key. The server checks calendar access before saving it encrypted. A failed replacement leaves the previous key intact. Keys cannot be retrieved through the status API or displayed after saving.
3. Select **Test connection**. `Key saved` becomes `Connected` only after a successful test of the currently saved key. This verifies calendar read access; it does not perform a write or verify Garmin permissions or watch receipt.

   Select **Prepare workout delivery** to verify Run delivery settings. Missing fields are configured automatically with the versioned delivery-only reference; valid existing settings are preserved. No threshold knowledge/input is required. The connection dialog explains that this can affect zones/load estimates in Intervals.icu. Preparation publishes no workout. Errors provide a recovery action before retrying. Each future explicit Publish in RUN-41 must run the preflight again against the current key.

4. In Intervals.icu Settings → Connections → Garmin Connect, connect your **own Garmin Connect account**, enable **Upload planned workouts**, and authorize the matching Garmin planned-workout permission. Check that sport filters include the planned sessions. Activity import is a separate setting; it is not required for this app's outbound delivery or Garmin inbound import.
5. Once publication is available in RUN-41, explicitly select **Publish to Intervals.icu** separately from importing/approving a plan. Connecting, testing, and approving a plan do not publish anything. RUN-39 adds no workout write endpoint.

Intervals.icu documents forwarding approximately the **next seven days** of scheduled workouts automatically. Sessions farther out may wait until they enter that window. This is provider-managed forwarding, independent of manually initiated Running Coach → Intervals.icu publication and Running Coach's manual Garmin Activity/Health import. See the provider's [Garmin setup guide](https://forum.intervals.icu/t/upload-planned-workouts-to-garmin-connect/1521) and [seven-day window confirmation](https://forum.intervals.icu/t/upload-planned-workouts-to-garmin-connect/1521?page=10). Sync the watch with Garmin Connect and inspect the workout on the actual device. Intervals.icu acceptance, `Connected`, and Garmin calendar presence do not prove watch delivery. Real Forerunner 165 verification belongs to RUN-40.

## Test, replace, disconnect and revoke

- Invalid or revoked keys: a provider 401/403 is shown as a rejected key. A rejected saved key becomes `ERROR`; replace it to reconnect. Failed connection/replacement validation does not overwrite a working key.
- Missing/unavailable saved key: reconnect or replace it. Missing encryption configuration produces a separate administrator-facing storage error.
- Rate limit, timeout, malformed/oversized response, Cloudflare challenge/HTML block page or provider outage: show a safe retry message and preserve the saved key/status. Cloudflare's `cf-mitigated: challenge` header and HTML content types are checked before interpreting 401/403 as invalid credentials. No automatic retry or background work is started.
- Replace: generate a new personal key at Intervals.icu and use **Replace Intervals.icu key**. A replacement resets the tested status. A test using an older encrypted nonce cannot change the replacement's status.
- Concurrent connection changes: Connect/Replace captures a server-only version before the provider call. Saving locks the owner/provider connection and checks that version before changing credentials. If another request disconnects, replaces or updates the connection during verification, the old request returns `409 CONNECTION_CHANGED`. Even first-time connection attempts have a credential-free connection row, so Disconnect can invalidate a pending attempt. PostgreSQL's `xmin` row version is used only during this short request, never as a durable ID or browser token; no migration is required.
- Disconnect: confirm **Disconnect Intervals.icu** to delete only your local encrypted credential. It does not revoke the key at the provider, remove already published calendar workouts, or disable Intervals.icu → Garmin forwarding. To revoke provider access, clear/regenerate the key in Intervals.icu Developer Settings. Disable Upload planned workouts there if you want to stop onward forwarding.
- Vault encryption rotation remains the existing [RUN-21 operator procedure](provider-credential-operations.md); no new environment variables or migration are required.

## HTTP contract

All endpoints require a verified current user. Responses use `Cache-Control: private, no-store`; mutations require a matching Origin. No caller can choose a user or athlete ID. The connection status response contains only provider, status and timestamps.

| Method | Path                          | Behavior                                                                                                          |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/integrations/intervals` | Read current owner's connection status                                                                            |
| PUT    | `/api/integrations/intervals` | Strict JSON `{ "apiKey": "..." }`, maximum body 4096 bytes, validate calendar access then encrypt/save or replace |
| POST   | `/api/integrations/intervals` | Test the owner's saved key, update status only for its current credential nonce                                   |
| DELETE | `/api/integrations/intervals` | Disconnect locally; 204, idempotent                                                                               |

Errors: 400 malformed input; 401 no session; 403 unavailable account or wrong Origin; 409 saved credential unavailable or connection changed during verification; 413 oversized body; 415 wrong media type; 422 provider rejected key; 429 provider rate limit; 503 storage/provider temporarily unavailable. Provider response bodies, headers, raw errors and secrets are never returned or logged.

The adapter makes one GET to `https://intervals.icu/api/v1/athlete/0/events?oldest=YYYY-MM-DD&newest=YYYY-MM-DD&category=WORKOUT` for the current UTC date. It uses Basic auth server-side, refuses redirects, times out after 10 seconds and bounds responses to 512 KiB. Calendar records are runtime-validated and discarded, never ingested. This read-only probe cannot establish write permission or Garmin delivery.

## Verification boundaries

RUN-40 adds `GET /api/integrations/intervals/pace` for local metadata and an
authenticated same-origin `POST` for explicit delivery preparation. POST accepts
an empty body or `{}` only (maximum 512 bytes), never an owner, athlete or reference
override. Public status exposes status, provenance source and verification time;
credential bindings remain server-only. Disconnect/replacement clears the local
preflight checkpoint but does not undo previously configured provider settings.
Technical-reference provenance is retained separately for the owner and provider
Run group; a new key must pass preflight again before readiness is restored.
Settings page reloads display the saved local readiness without a provider call.
See [the mapping runbook](intervals-workout-mapping.md) for the tested reference,
readback rules, failure recovery and real watch evidence.

Synthetic tests cover independent USER/ADMIN owners, encrypted storage, replacement/disconnect, stale-key status protection, negative auth and Origin paths, safe provider errors, and UI actions. A local HTTP stand-in exercises request serialization and timeout behavior. PostgreSQL coverage lives in the existing guarded provider-vault integration suite; run `pnpm test:db` only against an isolated test/development database. No live credentials are used by default tests.

Before release, two actual athletes should independently connect/test/disconnect, verify their own Intervals.icu Garmin permission/settings, and confirm rejected-key behavior after provider revocation. Live provider behavior and watch forwarding remain unverified by synthetic tests. No workout publication or watch-delivery claim is made in RUN-39.
