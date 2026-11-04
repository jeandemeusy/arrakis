import { route } from '@/lib/api/handler';
import { finishGoogleLogin } from '@/lib/auth/google';

export const dynamic = 'force-dynamic';

export const GET = route(finishGoogleLogin);
