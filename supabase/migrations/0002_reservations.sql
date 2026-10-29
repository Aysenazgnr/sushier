-- Reservations table. service_date + slot_minute are the source of truth;
-- starts_at is a derived, stored generated column used only for ordering
-- and "is this in the past?" comparisons. A generated column must be
-- immutable, so the Europe/Istanbul literal is hardcoded here rather than
-- read from restaurant_settings.timezone -- if the restaurant ever changes
-- timezone, that is a migration, not a config edit.

create type public.reservation_status as enum ('booked', 'seated', 'no_show', 'cancelled');

create table public.reservations (
  id            uuid primary key default gen_random_uuid(),
  reference     text not null unique
                  check (reference ~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$'),
  service_date  date not null,
  slot_minute   smallint not null check (slot_minute between 0 and 1680),
  starts_at     timestamptz generated always as (
                  ((service_date::timestamp + make_interval(mins => slot_minute))
                    at time zone 'Europe/Istanbul')
                ) stored,
  party_size    smallint not null check (party_size between 1 and 20),
  guest_name    text not null check (char_length(btrim(guest_name)) between 2 and 80),
  guest_phone   text not null check (char_length(guest_phone) between 7 and 24),
  guest_email   text check (guest_email is null or char_length(guest_email) <= 120),
  notes         text check (notes is null or char_length(notes) <= 500),
  status        public.reservation_status not null default 'booked',
  ip_hash       text, -- sha256(ip + server salt); the raw IP is never stored
  user_agent    text check (user_agent is null or char_length(user_agent) <= 300),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  updated_by    uuid references auth.users(id) on delete set null
);

-- Hot path: availability counts for one date. Cancelled reservations are
-- excluded from the index itself, so a cancellation freeing a table is
-- literally the row leaving this index -- no separate bookkeeping needed.
create index reservations_date_slot_active_idx
  on public.reservations (service_date, slot_minute)
  where status <> 'cancelled';

-- Admin list, sorted chronologically.
create index reservations_starts_at_idx on public.reservations (starts_at desc);

-- Rate-limit lookup (per-IP bookings in the last day).
create index reservations_ip_created_idx
  on public.reservations (ip_hash, created_at desc)
  where ip_hash is not null;

create trigger reservations_set_updated_at
  before update on public.reservations
  for each row execute function public.set_updated_at();

alter table public.reservations enable row level security;
