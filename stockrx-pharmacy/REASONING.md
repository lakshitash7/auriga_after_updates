# Reasoning

## Approach
Given the 2.5-hour (in practice much less) time budget, I prioritized getting the core domain logic — batches, FEFO dispensing, in-date stock — correct and tested first, then layered the three twists on top, then the UI, in that order. I chose Node/Express + SQLite (`better-sqlite3`, synchronous API) specifically to avoid async/await ceremony and ORM setup overhead, and a build-step-free vanilla JS frontend to avoid tooling risk under time pressure.

## Key design decisions

**Simulated clock as the single source of "now".** Rather than letting the app read `Date.now()` anywhere, I store a `sim_clock` row in the DB and every date-sensitive query (in-date stock, dispensing eligibility, the daily job) reads `getCurrentDate()`. This makes `POST /clock` the one lever that moves the entire app's sense of time forward, which is exactly what a grading harness that "won't wait for real days to pass" needs.

**FEFO dispensing as a single transaction.** `/api/dispense` computes available in-date stock first and rejects up front if insufficient, then walks active batches ordered by `expiry_date ASC, id ASC`, draining each in turn. Wrapping it in a `better-sqlite3` transaction keeps partial-deduction states from ever being visible.

**Daily job semantics.** "Quarantine" is modeled as a batch `status` flip to `quarantined` (hard-blocked from `inDateStock` and from FEFO selection since both filter on `status = 'active'`). "Flag expiring within 7 days" is a separate boolean (`flagged`) so quarantined and flagged are visibly distinct states in the UI, and flags are recomputed fresh on every clock tick rather than accumulating.

**Messy import.** I treated the three requirements — parse-what's-salvageable, dedupe exact duplicates, reject unparseable — as three independent checks per row rather than one big validator, so partial data (e.g., a good date but garbage quantity) fails for a specific, reported reason. Quantity parsing strips to the first numeric token (handles `"10 units"`, `"10"`, `10`). Date parsing tries ISO, `dd/mm/yyyy`, and `yyyy/mm/dd` explicitly before falling back to `Date.parse`, and rejects ambiguous/invalid month values rather than guessing. Deduping happens both within the uploaded batch (via a normalized key) and against existing DB rows, so repeated imports of the same file don't double-count stock.

**Notification/outbox.** Rather than firing a notification on every check (which would spam the outbox every time the daily job runs while stock stays flat), I only insert a new outbox row when the computed in-date stock differs from the value in the medicine's last logged notification. This keeps `/outbox` meaningful — each entry represents an actual stock-level change that crossed/stayed at-or-below the reorder threshold — while still firing reliably from both `/api/dispense` and the `/clock`-triggered quarantine job, matching "whenever ... stock drops to/below its reorder level."

**Unauthenticated `/clock` and `/outbox`, mounted at root.** The brief explicitly names these paths (not `/api/clock`) and describes an automated grader calling them directly, which won't have a login session. Everything else stays behind JWT auth.

## Testing
I smoke-tested every endpoint end-to-end via `curl` against a running instance before writing the UI: register → login → add medicine → add two batches with different expiries → confirm in-date stock sums both → dispense a quantity spanning both batches and confirm FEFO order in the response → advance the simulated clock past the first batch's expiry and confirm it flips to `quarantined` while the surviving batch's quantity is correctly reduced → submit a messy import batch (unit-suffixed quantity, dd/mm/yyyy date, an exact duplicate row, a null-name row, a null-quantity row) and confirmed the `{imported, deduped, rejected}` counts and per-row rejection reasons matched expectations → confirmed `/outbox` accumulated a re-order alert after the low-stock dispense. Found and fixed one real bug this way: the background dev server process was being killed between shell invocations until I started it with `setsid nohup ... < /dev/null &`, which is an environment quirk rather than an app bug, but it's exactly the kind of thing I verified rather than assumed.

## What I'd do with more time
Server-side input validation with a schema library (zod) instead of hand-rolled checks; a real test suite (Jest/Supertest) instead of curl smoke tests; optimistic UI locking around dispense to avoid double-submits; audit log of who dispensed what.
