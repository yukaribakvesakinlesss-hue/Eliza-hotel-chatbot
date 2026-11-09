-- =====================================================================
-- AXON Hotel PMS · Phase 6 fix · web chat flood protection in the database
-- The API's per-IP limiter lives in one server instance's memory; on Vercel
-- requests spread over many instances, so it did not hold in production
-- (measured: 45 rapid requests, none limited). The database now caps new
-- public web chat sessions per hotel: at most 30 per minute.
-- Idempotent: safe to run more than once.
-- =====================================================================
create index if not exists conversations_webchat_recent_idx on public.conversations (property_id, created_at) where channel = 'WEBCHAT';

create or replace function public.webchat_start(p_org_slug text, p_property_code text, p_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prop public.properties; v_conn public.channel_connections; v_conv public.conversations; v_token text;
begin
  select p.* into v_prop from public.properties p join public.organizations o on o.id = p.organization_id
   where o.slug = p_org_slug and p.code = upper(p_property_code);
  select * into v_conn from public.channel_connections where property_id = v_prop.id and channel = 'WEBCHAT';
  if v_prop.id is null or v_conn.id is null then
    raise exception 'INBOX_NOT_FOUND: Otel bulunamadı.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.conversations
       where property_id = v_prop.id and channel = 'WEBCHAT' and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'INBOX_RATE_LIMIT: Şu anda çok fazla sohbet başlatılıyor; lütfen bir dakika sonra tekrar deneyin.' using errcode = 'P0001';
  end if;
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  v_conv := app_private.upsert_conversation(v_prop.id, 'WEBCHAT', 'web-' || encode(extensions.gen_random_bytes(8), 'hex'),
                                            left(p_name, 120), null, false);
  insert into app_private.webchat_sessions (conversation_id, token_hash) values (v_conv.id, app_private.sha256(v_token));
  return jsonb_build_object('conversation_id', v_conv.id, 'token', v_token, 'property_name', v_prop.name);
end $$;
revoke all on function public.webchat_start(text, text, text) from public;
grant execute on function public.webchat_start(text, text, text) to anon, authenticated;
