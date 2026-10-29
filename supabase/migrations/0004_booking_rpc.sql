-- Reference code generator: 6 characters from a 30-character alphabet with
-- the visually/verbally ambiguous characters removed (0/O, 1/I/L, U), so a
-- code read aloud over the phone can't be misheard. ~729M combinations.
create or replace function public.generate_reservation_reference() returns text
  language plpgsql as $$
declare
  v_alphabet text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_result text := '';
  v_bytes bytea;
  i int;
begin
  v_bytes := gen_random_bytes(6);
  for i in 0..5 loop
    v_result := v_result || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
  end loop;
  return v_result;
end;
$$;

-- Read-only: today's/this date's slot grid with remaining-table counts.
-- No advisory lock -- a count that's stale by milliseconds is fine for
-- display; the authoritative check happens in create_reservation below.
create or replace function public.get_availability(p_date date) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_settings record;
  v_now timestamptz := now();
  v_today date;
  v_closed boolean := false;
  v_reason text := null;
  v_turn_span int;
  v_slots jsonb := '[]'::jsonb;
begin
  select * into v_settings from public.restaurant_settings where id = 1;
  v_today := (v_now at time zone v_settings.timezone)::date;
  v_turn_span := v_settings.turn_slots * v_settings.slot_minutes;

  if p_date < v_today then
    v_closed := true; v_reason := 'past';
  elsif p_date > v_today + v_settings.max_advance_days then
    v_closed := true; v_reason := 'too_far';
  elsif extract(isodow from p_date)::smallint = any(v_settings.closed_weekdays) then
    v_closed := true; v_reason := 'weekly';
  elsif exists (select 1 from public.closed_dates where service_date = p_date) then
    v_closed := true; v_reason := 'holiday';
  end if;

  if not v_closed then
    select coalesce(jsonb_agg(jsonb_build_object(
             'time', to_char(make_time(((slot_minute / 60) % 24)::int, (slot_minute % 60)::int, 0), 'HH24:MI'),
             'slotMinute', slot_minute,
             'remaining', greatest(v_settings.tables_per_slot - counts.taken, 0),
             'bookable', (greatest(v_settings.tables_per_slot - counts.taken, 0) > 0)
               and ((p_date::timestamp + make_interval(mins => slot_minute)) at time zone v_settings.timezone)
                   >= v_now + make_interval(mins => v_settings.min_lead_minutes)
           ) order by slot_minute), '[]'::jsonb)
      into v_slots
    from generate_series(v_settings.open_minute::int, v_settings.last_slot_minute::int, v_settings.slot_minutes::int) as slot_minute
    left join lateral (
      select count(*)::int as taken
      from public.reservations r
      where r.service_date = p_date
        and r.status <> 'cancelled'
        and r.slot_minute > slot_minute - v_turn_span
        and r.slot_minute < slot_minute + v_turn_span
    ) counts on true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'date', p_date,
    'closed', v_closed,
    'reason', v_reason,
    'minPartySize', v_settings.min_party_size,
    'maxPartySize', v_settings.max_party_size,
    'slots', v_slots
  );
end;
$$;

-- The booking write path. Every rule is enforced here, server-side -- the
-- client's copy of these rules is cosmetic only. Business-rule rejections
-- return {ok:false, code:...} rather than raising, so a rejected booking
-- never leaves an aborted transaction behind (the advisory lock below
-- releases cleanly either way, and the pooled connection stays reusable).
-- Genuinely unexpected errors still propagate as real exceptions -> 500.
create or replace function public.create_reservation(
  p_date date,
  p_slot_minute int,
  p_party_size int,
  p_name text,
  p_phone text,
  p_email text,
  p_notes text,
  p_ip_hash text,
  p_user_agent text
) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_settings record;
  v_now timestamptz := now();
  v_today date;
  v_starts_at timestamptz;
  v_turn_span int;
  v_taken int;
  v_reference text;
  v_id uuid;
  v_attempt int := 0;
begin
  select * into v_settings from public.restaurant_settings where id = 1;

  if p_party_size is null or p_party_size < v_settings.min_party_size or p_party_size > v_settings.max_party_size then
    return jsonb_build_object('ok', false, 'code', 'party_size_out_of_range');
  end if;

  if p_slot_minute is null
     or p_slot_minute < v_settings.open_minute
     or p_slot_minute > v_settings.last_slot_minute
     or (p_slot_minute - v_settings.open_minute) % v_settings.slot_minutes <> 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_slot');
  end if;

  if extract(isodow from p_date)::smallint = any(v_settings.closed_weekdays) then
    return jsonb_build_object('ok', false, 'code', 'date_closed');
  end if;

  if exists (select 1 from public.closed_dates where service_date = p_date) then
    return jsonb_build_object('ok', false, 'code', 'date_closed');
  end if;

  v_today := (v_now at time zone v_settings.timezone)::date;
  if p_date > v_today + v_settings.max_advance_days then
    return jsonb_build_object('ok', false, 'code', 'too_far_ahead');
  end if;

  -- Computed from the database's own clock, not the client's -- this single
  -- check subsumes both "no past dates" and the minimum lead time.
  v_starts_at := (p_date::timestamp + make_interval(mins => p_slot_minute)) at time zone v_settings.timezone;
  if v_starts_at < v_now + make_interval(mins => v_settings.min_lead_minutes) then
    return jsonb_build_object('ok', false, 'code', 'slot_in_past');
  end if;

  if p_ip_hash is not null then
    if (select count(*) from public.reservations
         where ip_hash = p_ip_hash
           and created_at > v_now - interval '1 day') >= v_settings.max_per_ip_per_day then
      return jsonb_build_object('ok', false, 'code', 'rate_limited');
    end if;
  end if;

  -- Advisory lock on this (date, slot) pair, held until commit. Prevents the
  -- classic check-then-act race: under READ COMMITTED, two concurrent
  -- transactions could each see e.g. 11/12 taken and both insert, overselling
  -- the slot. pg_advisory_xact_lock serializes bookings for this exact slot
  -- only (a hash collision with another slot is harmless -- it just makes
  -- two unrelated slots briefly wait on each other) and auto-releases on
  -- commit, rollback or connection death, so a crashed invocation can never
  -- wedge a slot shut.
  perform pg_advisory_xact_lock(hashtextextended(p_date::text || ':' || p_slot_minute::text, 0));

  -- A table is held for turn_slots * slot_minutes minutes (default 90), so
  -- a booking at 18:00 also occupies the 18:30 and 19:00 slots. This counts
  -- any active reservation starting within that window on either side.
  v_turn_span := v_settings.turn_slots * v_settings.slot_minutes;
  select count(*) into v_taken
    from public.reservations
   where service_date = p_date
     and status <> 'cancelled'
     and slot_minute > p_slot_minute - v_turn_span
     and slot_minute < p_slot_minute + v_turn_span;

  if v_taken >= v_settings.tables_per_slot then
    return jsonb_build_object('ok', false, 'code', 'slot_full');
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_reference := public.generate_reservation_reference();
    begin
      insert into public.reservations (
        reference, service_date, slot_minute, party_size,
        guest_name, guest_phone, guest_email, notes,
        ip_hash, user_agent
      ) values (
        v_reference, p_date, p_slot_minute, p_party_size,
        btrim(p_name), btrim(p_phone), p_email, p_notes,
        p_ip_hash, p_user_agent
      )
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'reference', v_reference,
    'date', p_date,
    'slotMinute', p_slot_minute
  );
end;
$$;

revoke all on function public.create_reservation(date, int, int, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_reservation(date, int, int, text, text, text, text, text, text) to service_role;

revoke all on function public.get_availability(date) from public, anon, authenticated;
grant execute on function public.get_availability(date) to service_role;

revoke all on function public.generate_reservation_reference() from public, anon, authenticated;
