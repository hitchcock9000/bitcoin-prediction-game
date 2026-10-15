import { getHandlers } from '@/server/http/runtime';

export const dynamic = 'force-dynamic';

/**
 * Settlement trigger for an external scheduler. Protected by
 * SETTLEMENT_SECRET and disabled when it is not configured.
 */
export async function POST(request: Request): Promise<Response> {
  return getHandlers().handleSettle(request);
}
