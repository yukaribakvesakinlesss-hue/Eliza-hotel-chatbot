import type { Instrumentation } from 'next';
import { log } from '@/lib/log';

export function register() {}

/** Every uncaught server error (pages, route handlers, server actions) becomes one structured log line. */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const e = err as Error & { digest?: string };
  log('error', 'request_error', {
    method: request.method,
    path: request.path.split('?')[0],
    routeType: context.routeType,
    route: context.routePath,
    message: e?.message?.slice(0, 300),
    digest: e?.digest
  });
};
