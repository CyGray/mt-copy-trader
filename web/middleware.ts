import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ADMIN_PATHS = ['/admin'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isAdminRoute = ADMIN_PATHS.some((path) => pathname.startsWith(path));

  if (!isAdminRoute) {
    return NextResponse.next();
  }

  const session = request.cookies.get('bytrader_session')?.value;
  if (!session) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};
