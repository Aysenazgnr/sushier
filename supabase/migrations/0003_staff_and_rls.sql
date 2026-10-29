-- Staff gate: "logged in" != "staff". Any authenticated Supabase user who
-- is not also a row in public.staff can see nothing on any table below.
create table public.staff (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

alter table public.staff enable row level security;

-- security definer is required here: without it, a policy that calls
-- is_staff() would recurse into staff's own RLS and never resolve.
create function public.is_staff() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.staff where user_id = auth.uid());
$$;

-- No policy at all is created for `anon` on any table below. With RLS
-- enabled and zero matching policies, every anon query returns empty --
-- the public site never talks to Supabase directly, only through the two
-- serverless API functions using the service_role key, which bypasses RLS
-- entirely.

-- staff: a user can see their own staff row (used by the admin UI to
-- confirm staff status after sign-in), nothing else.
create policy staff_select_own on public.staff
  for select to authenticated
  using (user_id = auth.uid());

-- restaurant_settings: staff can read and update; no insert/delete (the
-- single row is created by migration, never by the app).
create policy restaurant_settings_select_staff on public.restaurant_settings
  for select to authenticated
  using (public.is_staff());

create policy restaurant_settings_update_staff on public.restaurant_settings
  for update to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- closed_dates: full staff CRUD.
create policy closed_dates_select_staff on public.closed_dates
  for select to authenticated
  using (public.is_staff());

create policy closed_dates_insert_staff on public.closed_dates
  for insert to authenticated
  with check (public.is_staff());

create policy closed_dates_update_staff on public.closed_dates
  for update to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create policy closed_dates_delete_staff on public.closed_dates
  for delete to authenticated
  using (public.is_staff());

-- reservations: staff can read and update (cancel / seated / no_show /
-- reopen). No insert (bookings are only created through create_reservation
-- via service_role) and no delete for anyone, ever -- cancellation is a
-- status change, preserving the audit trail.
create policy reservations_select_staff on public.reservations
  for select to authenticated
  using (public.is_staff());

create policy reservations_update_staff on public.reservations
  for update to authenticated
  using (public.is_staff())
  with check (public.is_staff());
