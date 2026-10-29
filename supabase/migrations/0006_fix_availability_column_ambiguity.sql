-- Bug fix: the generate_series alias was named `slot_minute`, identical to
-- reservations.slot_minute. Inside the lateral subquery's WHERE clause, the
-- unqualified reference resolved to the inner r.slot_minute instead of the
-- outer series value, making the condition `r.slot_minute > r.slot_minute -
-- span` -- always true -- so every slot counted every active reservation
-- for the date, showing the whole evening as full. Renamed to v_slot to
-- remove the ambiguity.
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
             'time', to_char(make_time(((v_slot / 60) % 24)::int, (v_slot % 60)::int, 0), 'HH24:MI'),
             'slotMinute', v_slot,
             'remaining', greatest(v_settings.tables_per_slot - counts.taken, 0),
             'bookable', (greatest(v_settings.tables_per_slot - counts.taken, 0) > 0)
               and ((p_date::timestamp + make_interval(mins => v_slot)) at time zone v_settings.timezone)
                   >= v_now + make_interval(mins => v_settings.min_lead_minutes)
           ) order by v_slot), '[]'::jsonb)
      into v_slots
    from generate_series(v_settings.open_minute::int, v_settings.last_slot_minute::int, v_settings.slot_minutes::int) as v_slot
    left join lateral (
      select count(*)::int as taken
      from public.reservations r
      where r.service_date = p_date
        and r.status <> 'cancelled'
        and r.slot_minute > v_slot - v_turn_span
        and r.slot_minute < v_slot + v_turn_span
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
