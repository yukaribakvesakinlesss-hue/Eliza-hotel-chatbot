# AXON PMS

Hotel PMS for AXON: multi-tenant (organization → property), Supabase PostgreSQL + Auth + RLS + Realtime, Next.js 15.

## Phase 1: database and room status engine

| Path | What |
|---|---|
| `supabase/migrations/` | schema, enums, RLS policies, status engine trigger, RPCs, realtime publication |
| `supabase/seed.sql` | demo hotel (Aurelia Boutique Hotel, 24 rooms) |
| `supabase/tests/` | Supabase shim + 38 RLS / business-rule tests (`npm run db:test`) |
| `src/types/database.ts` | the single place for TypeScript database types |
| `src/lib/rooms/rules.ts` | client mirror of the status rules (the database stays the authority) |
| `src/components/RoomBoard.tsx` | room board: three statuses per card, optimistic save, rollback, realtime |

Each room has three independent statuses:

- **Occupancy:** VACANT, RESERVED, OCCUPIED
- **Housekeeping:** CLEAN, DIRTY, IN_PROGRESS, INSPECTION_REQUIRED
- **Maintenance:** OPERATIONAL, OUT_OF_ORDER

Rules, enforced in the database by `app_private.room_status_guard()`:

- An OUT_OF_ORDER room cannot be checked in (`RULE_OUT_OF_ORDER`).
- An OCCUPIED room cannot be set out of order (`RULE_OCCUPIED`).
- Check-out (OCCUPIED → VACANT) automatically sets housekeeping to DIRTY.
- Housekeeping staff can change only the housekeeping status (`FORBIDDEN`).
- Every change is written to `room_status_events` (audit log) together with the user.

## Phase 2: reservation engine and overbooking protection

| Path | What |
|---|---|
| `supabase/migrations/20261108000300_reservation_engine.sql` | `reservations`, `reservation_guests`, idempotency keys, booking RPCs |
| `supabase/tests/20_reservations.sql` | 61 checks: overlap, same-day turnover, cancel, extend, idempotency, roles, tenants |
| `supabase/tests/30_concurrency.sh` | parallel database sessions: 2 and 10 simultaneous bookings, lock wait, parallel retries |
| `src/app/api/reservations/**` | `POST /api/reservations` (needs an `Idempotency-Key` header), `PATCH /api/reservations/:id`, `POST /api/reservations/:id/cancel`, `POST /api/reservations/:id/status` |
| `src/components/reservations/` | Tape chart, quick booking modal, reservation panel |

How double bookings are prevented:

1. **EXCLUDE constraint.** It uses `btree_gist` on `(room_id =, daterange(check_in, check_out, '[)') &&)` and ignores CANCELLED and NO_SHOW bookings. The database refuses an overlap, whatever wrote it.
2. **Locked transactions.** Every write runs in a SECURITY DEFINER function, one transaction per call, and takes `SELECT … FOR UPDATE` on the room. Parallel requests for the same room queue up, and the one that loses gets a Turkish error: `RES_CONFLICT: Oda 101 seçilen tarihlerde dolu…`.
3. **Idempotency keys.** A repeated request with the same `Idempotency-Key` returns the original reservation instead of creating a new one.

The `[)` range means the check-out day is free, so a new guest can check in the same day. Clients cannot write to the reservation tables directly; all writes go through the functions.

## Phase 3: financial engine and folio

| Path | What |
|---|---|
| `supabase/migrations/20261108000400_financial_engine.sql` | folios, append-only `folio_transactions`, chart of accounts, channels and commission rates, dated out-of-order history, night audit |
| `src/lib/finance/metrics.ts` | `calculatePMSMetrics`, the one place where ADR, RevPAR, occupancy, taxes and commissions are computed (in integer cents) |
| `src/app/reports` | date-based KPI dashboard built from database rows |
| `supabase/seed_finance.sql` / `cleanup_demo_finance.sql` | demo history for the demo hotel, and its removal (database owner only) |
| `supabase/tests/40_finance.sql`, `tests/metrics.test.ts`, `tests/db-crosscheck.test.ts` | ledger rules, hand-computed KPIs, and a check of the TypeScript results against independent SQL |

**Ledger rules**

- Room charges, taxes, discounts, extras, payments and refunds are separate transaction types.
- UPDATE, DELETE and TRUNCATE are refused, even for the database owner. Corrections are reversal rows.
- Each account code maps to a USALI-style schedule. This is a mapping structure, not a claim of full USALI compliance.

**KPI definitions**

- ADR = net room revenue / room-nights sold.
- RevPAR = net room revenue / available room-nights.
- Occupancy = room-nights sold / available room-nights × 100.
- Available room-nights exclude out-of-order rooms, using the dated OOO records.
- Cancelled stays never count as revenue.
- No-show and complimentary stays are reported separately and are outside ADR and RevPAR.
- OTA commission = the reservation's net room revenue × the commission rate saved on the reservation at booking. It is reported as a distribution cost.

Tax rates (VAT 10 % on rooms, lodging tax 2 %) are demo defaults stored per property. Confirm them with an accountant.

## Phase 4: housekeeping operations

| Path | What |
|---|---|
| `supabase/migrations/20261108000500_housekeeping.sql` | `hk_tasks`, notes and status history; new role `hk_supervisor` (kat şefi); `require_inspection` property setting; task RPCs |
| `src/app/housekeeping` | mobile-first task screen with large buttons; realtime |
| `supabase/tests/60_housekeeping.sql`, `tests/housekeeping.test.ts` | task flow, inspection rule, roles, tenants; client permission mirror and routes |

**Task flow**

- A task moves DIRTY → IN_PROGRESS → INSPECTION_REQUIRED → CLEAN (or CANCELLED). The room's housekeeping status follows it in the same transaction, so the front desk board updates through realtime.
- A room that becomes dirty gets a task automatically: after a check-out, on the room board, or when a room is inserted dirty.
- If a guest arrives in that room today, the task gets priority 1.

**Inspection setting**

- When `require_inspection` is on, the database refuses CLEAN from housekeeping staff (`RULE_INSPECTION`). Only a supervisor, manager or owner can approve.
- A rejection needs a note and sends the room back to DIRTY.

**Screens by role**

- Housekeeping staff see only `/housekeeping`; the other screens redirect them there.
- The front desk can create tasks and add notes.
- Supervisors and managers assign, inspect and cancel tasks.

## Running it

Demo mode needs no setup: leave the env vars empty and you get sample data. Changes stay in the browser.

```bash
npm install
npm run dev          # http://localhost:3000/rooms
```

Connecting to Supabase:

1. Create a Supabase project.
2. Run the files in `supabase/migrations/` in order in the SQL editor, or use `supabase db push`.
3. Optional: run `seed.sql` to load the demo hotel.
4. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to `.env.local` (or to Vercel). Use only the anon key; never put the service_role key in the app.
5. Create a user under Authentication → Users.
6. On first login the user creates their own hotel at `/onboarding`. To give the user access to the demo hotel instead, run this in the SQL editor:
   `select public.admin_add_member('you@example.com', 'axon-demo', 'owner');`

## Checks

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest: rules + demo data
npm run build        # next build
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres npm run db:test   # migrations x2 + seed x2 + 38 SQL tests
```
