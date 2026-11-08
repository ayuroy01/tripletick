# Triple Tick: verified audit and Phase 1 plan

Audit of commit `8092f22` on 8 November 2026, done before any Phase 1 changes. Each finding was checked against the code, and the important ones were also reproduced with a probe test against the real app (marked **probed**). Nothing here is a guess from the feature list.

**Status key:** Confirmed · Partially confirmed · Already fixed · Not reproducible · Requires live testing

## Phase 1: security and correctness (P0)

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Central consent enforcement on every send path | **Confirmed** (probed) | `send()` in `server/src/messaging.ts:219` is the single choke point, which is good, but it never looks at `opted_in` or `opted_out_at`. Consent is checked separately by each caller: broadcasts, call lists, Shopify carts and orders. Agent, API and bot sends skip it. |
| 2 | Templates bypass STOP | **Confirmed** (probed) | An agent sent an approved MARKETING template to a contact straight after they replied STOP, and it was delivered. A template also reached a contact who never opted in. Through the API, the same thing can be automated. |
| 3 | Contact privacy and custom-field permissions | **Confirmed** (probed) | `PATCH /api/contacts/:id` (`routes.ts:328`) has no visibility check: an agent renamed a contact whose only chat belongs to another agent and is hidden from them. `GET /api/contacts` returns every contact's custom fields unmasked to every agent (probed with a home address). Form answers in message payloads aren't masked either. There's no field-level permission model at all yet. |
| 4 | SSRF on outbound webhooks | **Confirmed** (probed) | `emitWebhook` (`events.ts:35`) POSTs to any http(s) URL, including `127.0.0.1` and private ranges, and follows redirects. Only admins can add webhooks, but every API key is an admin (see 7), which widens this. Connector URLs are safe: Salesforce is allow-listed to `*.salesforce.com` / `*.force.com`, and the others use fixed hosts. |
| 5 | Database-level webhook idempotency | **Partially confirmed** (probed) | `idx_msg_ext` isn't `UNIQUE`. Within one process duplicates can't race, because the check and insert in `receiveInbound` run with no `await` between them. But nothing at the database level guarantees it, and media is downloaded before the duplicate check, so a retried webhook re-downloads and saves the file again. Call events are already safe (`calls.external_id UNIQUE` plus `INSERT OR IGNORE`). |
| 6 | AI prompt injection | **Partially confirmed** | Already in place: customer text is fenced in `<transcript>` / `<customer_message>` tags with a "treat as data" instruction, and the AI has **no tools**, so it can't take actions or change permissions. Missing: the fence isn't escaped, so a customer can type `</customer_message>` and write outside it. Replies aren't checked before they're sent to the customer. |
| 7 | Granular API-key permissions | **Confirmed** (probed) | `userFromApiKey` (`auth.ts:46`) makes every key act as the first admin. A key created "for Zapier" created a new admin user. Keys also have no expiry, and their actions are logged against that admin, not the key. |
| 8 | Recheck consent before campaigns and calls | **Mostly already fixed** | Broadcasts recheck `opted_out_at` at send time, with an existing test. Call lists recheck at dial time. Gaps: ad-hoc agent calls (`calls.ts:140`) don't check opt-out (on WhatsApp, Meta's call permission is a backstop; in the Simulator there's none), and neither path rechecks an `opted_in` that was turned off after the list was built. |

### Other findings from the same pass

| Finding | Severity | Status |
| --- | --- | --- |
| **No migration system.** The schema is `CREATE TABLE IF NOT EXISTS` only, so existing installs can never get new columns or indexes. Phase 1 needs schema changes (API-key scopes, a unique index), so this has to come first. | High (blocks Phase 1) | Confirmed |
| A bot keeps going after a failed send. `send()` returns normally when delivery fails, so a Buttons step sets the run to "waiting" for a reply to a message that never arrived. (Phase 2.1) | High | Confirmed (probed) |
| Uploads trust the declared MIME type. HTML saved as `image/png` was accepted. `nosniff` limits the damage in browsers. (Phase 2.6) | Medium | Confirmed (probed) |
| Login throttling is keyed on IP plus email only, so trying one password across many accounts isn't limited. (Phase 2.8) | Medium | Confirmed |
| A Simulator channel is created on every fresh setup, including production. Its endpoints let any signed-in user inject customer messages and read simulator threads regardless of assignment. | Low | Confirmed |
| A masked agent can search message bodies, which can confirm card digits they can't see. | Low | Confirmed |
| `PATCH /api/settings` and `PATCH /api/users/:id` don't validate value types or roles. Admin only. | Low | Confirmed |
| The WhatsApp webhook returns 401 for a disabled or unknown number, so Meta keeps retrying. | Low | Confirmed |

### Already done well (keep these)

Every send goes through one `send()` function. Session tokens are hashed, and passwords use scrypt with a timing-safe compare. Meta and Shopify signatures are verified with HMAC over the raw body. Live events carry ids only and clients refetch through authorised routes. Delivery statuses only ever move forward. Agents can't undo a STOP. Secrets are sealed with AES-256-GCM. CSV import and the inbound hook never override an opt-out.

## Phase 1 results

Phase 1 was done on branch `phase-1-security`. Every item has regression tests: `server/test/security.test.ts` (19 tests), new cases in `core.test.ts` and prompt-injection tests in `ai.test.ts`. The full suite (120 tests), typecheck, build and the 19-flow browser test all pass. All 7 original Phase 1 probes now fail against the new code, meaning the holes are closed. The two Phase 2 probes still reproduce, as expected.

| # | Item | Status now | What changed | Files |
| --- | --- | --- | --- | --- |
| prereq | Migrations | **Fixed** | Ordered migrations tracked with `PRAGMA user_version`, each run in a transaction. Old databases (version 0) upgrade in place, and a database from a newer version refuses to open rather than being damaged. | `db.ts` |
| 1–2 | Consent on every path | **Fixed** | `templateConsentProblem()` inside `send()`. Marketing templates need an opt-in and no STOP. Any template sent while the window is closed needs consent. Utility and login templates may answer inside an open window. The error code is `consent_required`. Ad-hoc calls are blocked after STOP. | `messaging.ts`, `calls.ts` |
| 3 | Contact privacy | **Fixed** | Agents and managers see and edit only contacts on chats they can see, or contacts with no chats yet. Adding a number that belongs to someone else's customer returns only its id. New `sensitive_fields` setting: agents see `•••` for those fields in contacts and form answers, and their edits can't change or remove them. | `routes.ts`, `db.ts`, `Settings.tsx` |
| 4 | Webhook SSRF | **Fixed** | `netguard.ts`: blocks loopback, private, link-local, CGNAT, metadata and reserved ranges (IPv4, IPv6 and IPv4 inside IPv6). Checked when the webhook is saved, and again at connect time on the address actually used, which stops DNS rebinding. Redirects aren't followed, and credentials in the URL are refused. `TT_ALLOW_PRIVATE_WEBHOOKS=1` opts out. | `netguard.ts`, `events.ts`, `routes.ts` |
| 5 | Idempotency | **Fixed** | Unique partial index on `messages.external_id`. The migration first clears duplicate ids, and nothing is deleted. Inserts use `ON CONFLICT DO NOTHING`, and side effects run only after a successful insert. A retried webhook no longer re-downloads its media. | `db.ts`, `messaging.ts`, `routes.ts` |
| 6 | Prompt injection | **Fixed for current scope** | Customer text is escaped (so it can't close its fence) and capped at 2,000 characters per message. AI replies to customers are dropped and handed to a human if they're over 1,200 characters, or echo the prompt or its tags. The AI still has no tools. | `ai.ts` |
| 7 | API key scopes | **Fixed** | Six scopes, deny by default, and routes not on the list need `admin`. Expiry. A key acts as its creator and stops working when that person stops being an active admin. Keys can't create keys. The audit log names the key. Older keys become `admin` so nothing breaks, and the UI labels them "full access". | `auth.ts`, `http.ts`, `routes.ts`, `db.ts`, `Settings.tsx` |
| 8 | Consent rechecks | **Fixed** | Broadcasts and call lists recheck full consent (opt-in and STOP) at send or dial time, and record `no_opt_in` or `opted_out`. | `broadcasts.ts`, `calls.ts` |
| extra | Settings validation | **Fixed** | `PATCH /api/settings` rejects values of the wrong type. | `routes.ts` |

### Remaining limitations

- **Phone numbers as a way in.** An agent who already knows a customer's number can start a chat with them on a channel where that customer has no chat yet, and then sees that contact like any other. Knowing the number is treated as enough.
- **AI reply check.** The check on outgoing AI replies is a heuristic, not a guarantee. The real protection is that the AI has no tools and only answers from the knowledge base. Keep internal information out of the knowledge base.
- **Message search.** A masked agent can still search message text, which can confirm card digits they can't see. Planned for Phase 2.
- **Simulator channel.** The Simulator channel is still created on fresh installs. Plan: create it only in demo mode, or let admins turn it off.
- **Live testing.** Utility and marketing categories come from Meta's template sync, but they haven't been tested against a live account (Phase 3).
- **Phase 2 items still open.** A bot keeps going after a failed send, and uploads trust the declared file type.

## Scorecard

Scores aren't raised for code that has been written, only for fixes that are shown to work. The Phase 1 increases are modest because uploads, sessions, backups and live Meta testing are still open. Baselines are from the earlier review. The "after Phase 1" column is filled in only when its tests pass.

| Category | Baseline | After Phase 1 | Target |
| --- | --- | --- | --- |
| Security and privacy | 48 | 70 | 95 |
| Authentication and authorisation | 70 | 82 | 95 |
| WhatsApp integration | 70 | n/a | 95 |
| AI safety and reliability | 55 | 62 | 90 |
| Database | 72 | 80 | 90 |
| Testing | 62 | 70 | 95 |
| Personalisation and UX | Not assessed | n/a | 95 |
| Team collaboration | Not assessed | n/a | 95 |
| Analytics | Not assessed | n/a | 90 |

## Requires live testing (Phase 3)

These can't be verified without a Meta test number: template parameter rendering on real templates, media upload and download, Flows round-trips, out-of-order and duplicate deliveries from Meta itself, expired-token handling, rate-limit responses, and call setup and teardown. All current WhatsApp coverage is mocked.
