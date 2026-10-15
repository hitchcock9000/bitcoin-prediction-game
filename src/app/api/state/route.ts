import { getHandlers } from '@/server/http/runtime';

// Game state is per-player and changes constantly; never statically cached.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return getHandlers().handleState(request);
}
