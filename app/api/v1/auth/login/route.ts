import { route } from '@/lib/api/handler';
import { startGoogleLogin } from '@/lib/auth/google';

export const dynamic = 'force-dynamic';

/** Starts a full-page redirect; password login is no longer supported. */
export const GET = route(startGoogleLogin);
