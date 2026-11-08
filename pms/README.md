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
