import { WebChat } from '@/components/inbox/WebChat';

export const dynamic = 'force-dynamic';

export default async function ChatPage({ params }: { params: Promise<{ org: string; code: string }> }) {
  const { org, code } = await params;
  return <WebChat org={org.toLowerCase()} code={code.toUpperCase()} />;
}
