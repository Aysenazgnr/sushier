-- Tracks whether a guest reminder email has been sent for a reservation,
-- so api/cron-reminders.js can claim-and-send exactly once per
-- reservation even if the hourly GitHub Actions trigger runs twice in
-- a row (see that endpoint for the atomic UPDATE ... RETURNING claim).
--
-- No new RLS policy is needed: the cron endpoint uses the service_role
-- client (api/_lib/supabase.js), which bypasses RLS entirely, and the
-- existing staff policies in 0003_staff_and_rls.sql are not column-scoped
-- -- js/admin.js's `select('*')` keeps working unchanged, it just gets one
-- more column it doesn't render.
alter table public.reservations
  add column reminder_sent_at timestamptz;

-- The cron job scans "2-4 hours from now" every hour; this partial index
-- keeps that scan limited to reservations that are both unreminded and
-- still active, mirroring the spirit of reservations_date_slot_active_idx
-- (0002_reservations.sql) excluding cancelled rows from the hot-path index
-- itself rather than filtering them out at query time.
create index reservations_reminder_due_idx
  on public.reservations (starts_at)
  where reminder_sent_at is null and status = 'booked';
