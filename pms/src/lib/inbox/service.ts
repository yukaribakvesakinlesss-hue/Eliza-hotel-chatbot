/**
 * Inbox orchestration (server-only): understand a guest message, let the database answer it,
 * then deliver the stored reply through the channel adapter.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Message } from '@/types/database';
import { parseGuestMessage, type RoomTypeHint } from './nlu';
import { adapterFor, type ChannelCode } from './adapters';

type Client = SupabaseClient<Database>;

/** Asks the database for the assistant reply. Returns null when a human has taken over. */
export async function assistantReply(supabase: Client, opts: {
  conversationId: string; token: string | null; text: string; today: string; roomTypes: RoomTypeHint[]; lastAssistantType: string | null;
}): Promise<Message | null> {
  const parsed = parseGuestMessage(opts.text, opts.today, { roomTypes: opts.roomTypes, lastAssistantType: opts.lastAssistantType });
  const { data, error } = await supabase.rpc('inbox_assistant_turn', {
    p_conversation_id: opts.conversationId,
    p_token: opts.token,
    p_intent: parsed.intent,
    p_slots: parsed.slots,
    p_lang: parsed.lang
  });
  if (error) throw new Error(error.message);
  const result = data as { replied?: boolean; message?: Message } | null;
  return result?.replied && result.message ? result.message : null;
}

/** Sends a stored outgoing message through its channel and records the delivery result. */
export async function deliver(supabase: Client, message: Pick<Message, 'id' | 'body' | 'delivery_status'>, channel: ChannelCode, threadId: string, token: string | null,
  env: Record<string, string | undefined> = process.env) {
  if (message.delivery_status !== 'PENDING') return message.delivery_status; // web chat: delivered; demo: never sent
  const adapter = adapterFor(channel, env);
  const result = await adapter.send(threadId, message.body);
  await supabase.rpc('inbox_set_delivery', { p_message_id: message.id, p_status: result.status, p_token: token });
  return result.status;
}

export async function lastAssistantType(supabase: Client, conversationId: string, token: string | null): Promise<string | null> {
  if (token !== null) {
    const { data } = await supabase.rpc('webchat_messages', { p_conversation_id: conversationId, p_token: token, p_after_id: 0 });
    const last = (data ?? []).filter((m) => m.sender === 'AI').at(-1);
    return (last?.payload as { type?: string } | null)?.type ?? null;
  }
  const { data } = await supabase.from('messages').select('payload').eq('conversation_id', conversationId).eq('sender', 'AI').order('id', { ascending: false }).limit(1);
  return ((data?.[0]?.payload ?? null) as { type?: string } | null)?.type ?? null;
}

export type PublicProperty = { property_id: string; name: string; timezone: string; currency: string; room_types: RoomTypeHint[] };

/** Hotel facts readable without login (used by the public chat and webhooks). */
export async function publicProperty(supabase: Client, orgSlug: string, propertyCode: string): Promise<PublicProperty | null> {
  const { data, error } = await supabase.rpc('inbox_public_property', { p_org_slug: orgSlug, p_property_code: propertyCode });
  if (error || !data) return null;
  return data as PublicProperty;
}
