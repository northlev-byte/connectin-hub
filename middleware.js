import { NextResponse } from 'next/server';

export function middleware(request) {
  const auth = request.cookies.get('ci_auth');
  const { pathname } = request.nextUrl;

  // Allow password page and login API through
  if (pathname === '/password' || pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Redirect to password page if not authenticated
  if (!auth || auth.value !== '1') {
    return NextResponse.redirect(new URL('/password', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|favicon.ico).*)'],
};
