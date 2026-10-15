import { getHandlers } from '@/server/http/runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return getHandlers().handleCreatePrediction(request);
}
