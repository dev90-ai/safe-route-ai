# Safe Route AI

Security threat reporting and route advisory for humanitarian teams operating in
North Eastern Kenya (Garissa, Wajir, Mandera and the corridors between them).

**The loop:** Report → Analyse (AI) → Verify (human) → Alert → Protect

> **Status: frontend complete, running against an in-app mock backend.**
> Every screen, rule and state transition described below is implemented and
> exercisable today. The Supabase backend is the next phase; the data layer was
> built as a drop-in seam for it (see [Replacing the mock](#replacing-the-mock)).

---

## Quick start

```bash
npm install
npm start          # then press a for Android, i for iOS, w for web
```

```bash
npm test           # 82 assertions over the classifier, seed, fan-out, geo, validation
npm run typecheck  # tsc --noEmit
npm run web        # web build (schematic map instead of native maps)
```

### Demo accounts

The app seeds a deterministic dataset on first launch. All three use the
password `Passw0rd!`, and the sign-in screen lists them behind "Demo accounts".

| Email | Role | What you can do |
|---|---|---|
| `worker@saferoute.ai` | Humanitarian worker | File reports, threat map, Safe Route, SOS, alert feed |
| `officer@saferoute.ai` | Security officer | Verification queue, alert radius, advisories, SOS console |
| `admin@saferoute.ai` | Organisation admin | People, invites, partnerships, analytics, audit log |

### The five-minute tour

1. Sign in as **officer** — the queue has pending reports, including a genuine
   duplicate pair and one report too thin to classify. Verify one and watch the
   recipient count change as you drag the alert radius.
2. Sign in as **worker** — the alert you just issued is in the feed, labelled
   with *why* it reached this person.
3. Open **Settings → Diagnostics → Simulate no signal**, then file a report. It
   lands in the outbox. Turn the switch off and watch it send itself.
4. **Safe route**: Garissa Town → Dadaab Town. Three candidate routes, scored by
   verified incidents within a 2 km buffer of each line.
5. As **officer**, open the SOS tab — there is a live event waiting to be
   acknowledged.

---

## What is implemented

### Roles, and what separates them

The role boundaries are enforced in the API layer (`requireRole`,
`assertOrgVisible`), not by hiding buttons — the same predicates the Postgres RLS
policies will carry.

| | Worker | Officer | Admin |
|---|---|---|---|
| File reports | ✅ | ✅ | — |
| See verified threats | ✅ (reporter anonymised) | ✅ (reporter visible) | ✅ |
| See pending reports | own only | ✅ | ✅ read-only |
| **Verify / dismiss** | — | ✅ | **✗ by design** |
| Set alert radius | — | ✅ | — |
| Issue advisories | — | ✅ | — |
| Trigger SOS | ✅ | ✅ | — |
| Respond to SOS | — | ✅ | — |
| Manage people, invites, partnerships | — | — | ✅ |

**Admins cannot verify reports.** That is deliberate: the account that creates
the officer must not also be able to exercise the officer's authority, or the
verification chain stops being auditable.

### The four fan-out rules

A worker is alerted when **any** of these hold, and the reason is carried into
the notification and shown in the feed:

- same organisation as the report
- a cross-share partner of the reporting organisation
- their last known position is inside the threat's alert radius
- the threat falls inside one of their declared operating regions

Admins are excluded by default — paging them on every incident trains everyone
to ignore alerts. Quiet hours are respected, except for Critical.

### Offline resilience

Not a feature flag — the reason several architectural decisions look the way
they do.

- **The client mints the id** before any network call, and it doubles as the
  server's idempotency key. A queued submission retried after a timeout cannot
  become a second report.
- **SOS jumps the queue** ahead of everything else and fires the instant signal
  returns, surviving app restarts.
- **Per-item capped backoff** with jitter, so one poisoned entry cannot block
  the queue behind it, and a convoy regaining signal together does not stampede.
- **Nothing fails silently.** An item that exhausts its retries moves to a
  `failed` state the Outbox screen surfaces for manual retry.
- **Caches serve stale data with a visible marker** rather than showing a
  spinner or an empty list. A blank threat map in a dead zone reads as "all
  clear", which is the most dangerous thing this app could say.

`Settings → Diagnostics → Simulate no signal` exercises all of it from a desk.

### AI is advisory, and the UI never blurs that

- Classification runs *after* the report is recorded — a worker never waits for
  a model before their report exists.
- Suggestions are written to `ai_suggestions` and **never** to the officer-
  confirmed columns. The two are always separately visible and comparable.
- The verification sheet pre-fills from the model with a visible "AI suggestion"
  marker per field; the marker changes to "AI said X" the moment a field is
  overridden, and the audit log records which fields differed.
- Low confidence and "not enough detail to classify" are stated plainly rather
  than smoothed over.
- **AI agreement rate** is surfaced to officers and admins, and a rate above 92%
  is flagged as a warning — a human step that never changes the answer is not
  adding safety.

### Reporter anonymity

Peers never see who filed a report. Enforced at the data layer in
`redactForPeer`, not by omitting a field in a component: the reporter id is
replaced, the photo is dropped, and the pin is jittered ~250 m — enough to
protect the reporter, far below any alert radius. Organisations that need it can
additionally hide reporters from their own officers.

### Auditability

Every state transition is appended with actor, timestamp, and before/after
values. Report detail shows its own trail; officers and admins get the
organisation-wide log with search and entity filters.

---

## Architecture

```
src/
  api/            The backend seam
    client.ts       request pipeline: latency, offline, rate limits, RLS guards
    db.ts           in-memory store + realtime channels + append-only audit
    seed.ts         deterministic dataset (39 reports, 15 people, 3 orgs)
    cache.ts        stale-while-revalidate + disk persistence + tag invalidation
    rateLimit.ts    token buckets, persisted across restarts
    endpoints/      auth · reports · alerts · sos · routes · org · analytics
  ai/classifier.ts  stand-in for the Grok Edge Function (same contract)
  lib/              geo (PostGIS-equivalent) · offlineQueue · validation ·
                    logger · network · storage · format · haptics
  state/            auth · connectivity+outbox · notifications · toast
  components/ui/    design system primitives
  components/domain/ threat cards, AI panel, verify sheet, maps, charts
  app/              expo-router routes, one group per role
```

### Data flow

```
Worker files a report
  → client mints id, validates with zod
  → offline?  outbox (persisted)  → retries with backoff → same id, no duplicate
  → online?   reports.create      → status: pending, aiStatus: queued
                                  → classifier runs async (never blocks)
                                  → realtime pushes it to the officer queue
Officer verifies
  → requireRole('officer') + org visibility check
  → officer-confirmed columns written; ai_suggestions left untouched
  → audit entry records every field overridden
  → alertsApi.fanOutForReport → four-rule match → notifications + push
Worker receives
  → realtime toast + push + persistent feed row carrying the match reasons
```

### Cross-platform maps

`ThreatMap` has two implementations behind one props contract:
`ThreatMap.tsx` (react-native-maps) on device, and `ThreatMap.web.tsx` — an SVG
schematic with real corridors, place names and an equirectangular projection —
on web, where react-native-maps has no build. Every coordinate, radius and route
on the web version is accurate; it simply has no tiles.

### Design

Dark-first, because this app is used at night and in vehicles, where a bright
screen is both uncomfortable and a way of making yourself visible.

The severity ramp is the load-bearing signal in the product, so it was validated
rather than eyeballed — both schemes pass CVD separation, normal-vision
separation and contrast against their own surface (dark: ΔE 12.9 deutan / 16.3
normal; light: 13.9 / 15.5). Severity is additionally encoded by pin size on the
map and always paired with its word, so the level never rests on colour alone.

---

## Non-functional work

| Concern | Where |
|---|---|
| Validation | `lib/validation.ts` — one zod schema set, used by forms *and* re-checked by every endpoint |
| Rate limiting | `api/rateLimit.ts` — persisted token buckets on sign-in, OTP, reports, SOS, advisories |
| Auth hardening | account lockout, enumeration-safe password reset, single-use hashed OTP, session revocation on password change, 12 h / 30 min idle expiry, keychain-backed tokens |
| Caching | `api/cache.ts` — named policies, SWR, tag invalidation, request dedup, offline fallback |
| Logging / monitoring | `lib/logger.ts` — bounded ring buffer, redaction of secrets and coordinates, perf spans, p50/p95/error rate, all surfaced in Diagnostics |
| Access control | `api/client.ts` — `requireRole` and `assertOrgVisible` on every mutating endpoint; `redactForPeer` at the data layer |
| Accessibility | roles and labels throughout, 44 px touch targets, live regions on toasts, no colour-only encoding |
| UX | skeletons, empty states distinguishing "nothing" from "nothing matches", optimistic writes, haptics, hold-to-confirm SOS |

Verified by `npm run typecheck` (clean), `npx expo lint` (zero errors, zero
warnings — including React Compiler's purity and ref rules) and `npm test`.

### Deliberately deferred to the backend phase

These are real requirements; they are simply not things a client can implement,
and this build does not pretend otherwise:

| Concern | Why it is not here yet | Where it will live |
|---|---|---|
| **Database-level security** | The client-side guards above are the *specification* for the RLS policies, not a substitute — an attacker talks to the API, not to this app. | Postgres RLS on every table |
| **Connection pooling** | No database connection to pool. | Supabase / PgBouncer |
| **Backups** | No durable server state yet; device data is deliberately disposable and resettable from Diagnostics. | Supabase PITR + scheduled dumps |
| **CSP** | A static export cannot set response headers. | Host headers on the web deployment |
| **SEO** | Intentional: this is an authenticated tool for a named set of field staff. It should not be indexed, and the web build exists for review convenience, not reach. | `noindex` at the host |
| **Server-side rate limiting** | The buckets here protect the device and shape the UI; the authoritative limits have to be enforced where the requests actually arrive. | Edge Function middleware |

### Authentication

Complete: sign in · invite-gated sign up · forgot password → **6-digit code** →
verify → reset · change password.

The code is single-use, hashed at rest, expires in 10 minutes, and allows five
attempts before it burns. `requestPasswordCode` returns an identical response
whether or not the account exists, so it cannot enumerate staff.

Because this build has no mail transport, the code that *would* have been
emailed is surfaced in a clearly-labelled amber "Development preview" panel on
the verify screen. Swap that for a real transport and delete the panel — the
rest of the flow is unchanged.

---

## Replacing the mock

`api/client.ts` is the only file that knows there is no server. When Supabase
lands:

1. **Schema + RLS** — the tables in `api/types.ts` map 1:1 to the data model.
   The predicates in `visibleReportsFor`, `requireRole` and `assertOrgVisible`
   are the RLS policies, written out in TypeScript.
2. **`request()`** becomes a thin wrapper over `supabase-js`. Nothing above that
   file changes.
3. **`db.subscribe`** already mirrors a Supabase realtime channel signature.
4. **`ai/classifier.ts`** moves into an Edge Function, called on insert. Its
   output shape is already the contract the UI is built against. The Grok key
   never touches the client.
5. **`routesApi`** swaps synthesised corridors for a Directions API; the risk
   analysis is unchanged, and `distanceToPath` becomes `ST_DWithin`.
6. Push moves from local scheduling to Expo push tokens.

### Not yet built

- Real backend, and therefore real multi-device sync
- Photo upload to storage (attachment is captured and queued; the mock stores a
  local URI)
- Dual-control countersigning for Critical is enforced server-side but has no
  second-officer UI yet
- Background location while the app is fully closed (foreground tracking during
  an active SOS is implemented)

---

## Testing

```bash
npm test
```

82 assertions covering the parts where being wrong is expensive: haversine and
point-to-path geometry against known distances, classifier behaviour on real
report narratives (including duplicate detection and the refusal path), seed
integrity and determinism, demo-account password hashes, the fan-out rules
(including that an unrelated organisation is never reached and admins are never
paged), route risk ordering, and the validation schemas.
