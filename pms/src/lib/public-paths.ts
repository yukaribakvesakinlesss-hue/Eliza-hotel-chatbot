/**
 * Paths that do not use the staff session: guest web chat, channel webhooks, the cron worker (GET only;
 * its POST is the staff button) and the health check. Each authenticates with its own token, signature
 * or bearer secret, or exposes no data.
 */
export function isPublicPath(p: string, method = 'GET'): boolean {
  return p.startsWith('/chat/') || p.startsWith('/api/webchat') || p.startsWith('/api/webhooks/') || p.startsWith('/api/ota/webhook/')
    || p === '/api/health' || (p === '/api/ota/sync' && method === 'GET');
}
