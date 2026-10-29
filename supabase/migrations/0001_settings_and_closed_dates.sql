-- Restaurant-wide configuration (single row) and closed-date overrides.
--
-- Times are stored as minutes-from-midnight integers, never as a `time`
-- close value. A close time of 00:00 cannot be compared with `<` against a
-- `time` type ('00:00'::time < '18:00'::time is true), which would silently
-- zero out every slot query. Minutes-from-midnight has no midnight wrap
-- problem: a 23:30 last seating is 1410, a hypothetical 00:30 seating the
-- next calendar morning would be 1470, and both still belong to the same
-- `service_date` (the operating night, not the wall-clock date).

create table public.restaurant_settings (
  id                  smallint primary key default 1 check (id = 1),
  timezone            text not null default 'Europe/Istanbul',
  tables_per_slot     smallint not null default 12 check (tables_per_slot between 1 and 200),
  slot_minutes        smallint not null default 30 check (slot_minutes in (15, 30, 60)),
  open_minute         smallint not null default 1080 check (open_minute between 0 and 1439), -- 18:00
  last_slot_minute    smallint not null default 1410 check (last_slot_minute between 0 and 1680), -- 23:30
  closed_weekdays     smallint[] not null default '{1}', -- ISO dow, 1 = Monday
  max_party_size      smallint not null default 6 check (max_party_size between 1 and 20),
  min_party_size      smallint not null default 1 check (min_party_size between 1 and 20),
  turn_slots          smallint not null default 3 check (turn_slots between 1 and 8), -- 3 * 30min = 90min table hold
  min_lead_minutes    integer not null default 120 check (min_lead_minutes >= 0),
  max_advance_days    smallint not null default 30 check (max_advance_days between 1 and 365),
  max_per_ip_per_day  smallint not null default 4 check (max_per_ip_per_day >= 1),
  updated_at          timestamptz not null default now(),
  constraint party_size_order check (min_party_size <= max_party_size),
  constraint slot_window_order check (open_minute <= last_slot_minute)
);

insert into public.restaurant_settings (id) values (1);

create table public.closed_dates (
  service_date date primary key,
  reason       text check (reason is null or char_length(reason) <= 120),
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id) on delete set null
);

-- Shared updated_at trigger, reused by restaurant_settings and reservations.
create function public.set_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger restaurant_settings_set_updated_at
  before update on public.restaurant_settings
  for each row execute function public.set_updated_at();

alter table public.restaurant_settings enable row level security;
alter table public.closed_dates enable row level security;
