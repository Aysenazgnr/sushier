-- Pin search_path on every SECURITY DEFINER / trigger function so none of
-- them can be hijacked by a role-local search_path change, and narrow who
-- can call is_staff() directly over PostgREST (policies that reference it
-- still work -- the policy-evaluating role just needs EXECUTE, which
-- `authenticated` keeps).

create or replace function public.set_updated_at() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.generate_reservation_reference() returns text
  language plpgsql set search_path = public, pg_temp as $$
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

revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;
