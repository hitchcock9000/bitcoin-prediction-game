import { getHandlers } from '@/server/http/runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return getHandlers().handleHealth(request);
}
