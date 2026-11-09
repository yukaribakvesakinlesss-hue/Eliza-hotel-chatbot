-- =====================================================================
-- AXON PMS · assistant parity fixture: runs the scenarios in
-- tests/assistant_scenarios.json through the database's inbox_assistant_turn
-- (web chat conversations on the demo hotel) and prints one JSON document.
-- tests/assistant-parity.test.ts runs the same scenarios through the browser
-- copy used by the sales demo and requires identical replies.
-- Usage: psql -v scenarios="$(cat tests/assistant_scenarios.json)" -f 55_assistant_parity.sql
-- =====================================================================
\set QUIET on
\pset tuples_only on
\pset format unaligned
create or replace function pg_temp.parity(p_scenarios jsonb) returns jsonb language plpgsql as $$
declare sc jsonb; t jsonb; v_start jsonb; v_out jsonb; v_res jsonb := '{}'::jsonb; v_turns jsonb; v_today date; s jsonb; slots jsonb;
begin
  v_today := (now() at time zone 'Europe/Istanbul')::date;
  for sc in select * from jsonb_array_elements(p_scenarios) loop
    -- a web chat conversation with a session token (created directly: the public start is rate limited)
    v_start := jsonb_build_object('conversation_id', (app_private.upsert_conversation('00000000-0000-4000-a000-000000000101', 'WEBCHAT',
                 'parity-' || md5(random()::text), null, null, false)).id, 'token', md5(random()::text) || md5(random()::text));
    insert into app_private.webchat_sessions (conversation_id, token_hash) values ((v_start->>'conversation_id')::uuid, app_private.sha256(v_start->>'token'));
    v_turns := '[]'::jsonb;
    for t in select * from jsonb_array_elements(sc->'turns') loop
      s := t->'slots';
      slots := jsonb_strip_nulls(jsonb_build_object(
        'check_in', case when s ? 'in' then v_today + (s->>'in')::int end,
        'check_out', case when s ? 'out' then v_today + (s->>'out')::int end,
        'nights', s->'nights', 'adults', s->'adults', 'room_type', s->>'room_type', 'name', s->>'name',
        'email', s->>'email', 'phone', s->>'phone', 'topic', s->>'topic'));
      v_out := public.inbox_assistant_turn((v_start->>'conversation_id')::uuid, v_start->>'token', t->>'intent', slots, t->>'lang');
      v_turns := v_turns || jsonb_build_array(jsonb_build_object('replied', (v_out->>'replied')::boolean,
        'type', v_out->'message'->'payload'->>'type', 'text', regexp_replace(v_out->'message'->>'body', '\(talep no [0-9a-f]{8}\)|\(request [0-9a-f]{8}\)', '(…)')));
    end loop;
    v_res := v_res || jsonb_build_object(sc->>'name', v_turns);
  end loop;
  return jsonb_build_object('today', v_today, 'results', v_res);
end $$;
select pg_temp.parity(:'scenarios'::jsonb);
