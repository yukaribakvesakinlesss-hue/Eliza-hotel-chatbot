import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { SUPABASE_ANON_KEY, SUPABASE_URL, isDemoMode } from '@/lib/config';
import { isPublicPath } from '@/lib/public-paths';

/** Refreshes the Supabase session cookie and keeps signed-out users on /login. */
export async function middleware(request: NextRequest) {
  if (isDemoMode()) return NextResponse.next();
  // public: guest web chat, channel webhooks, the cron worker and the health check
  // (each authenticates with its own token / signature / bearer secret, or exposes no data)
  const p = request.nextUrl.pathname;
  if (isPublicPath(p, request.method)) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      }
    }
  });

  const {
    data: { user }
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  if (!user && path.startsWith('/api/')) {
    return NextResponse.json({ error: { code: 'AUTH_REQUIRED', message: 'Oturum açmanız gerekiyor.' } }, { status: 401 });
  }
  if (!user && path !== '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  if (user && path === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/rooms';
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)']
};
