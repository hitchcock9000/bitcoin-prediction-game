/**
 * Next.js instrumentation hook — runs once per server process at startup.
 *
 * This is where the settlement scheduler is started, so settlement is a
 * property of the running server rather than of any particular request.
 */
export async function register(): Promise<void> {
  // Request lifetimes cannot host a reliable interval scheduler on Vercel.
  if (process.env.VERCEL === '1') return;
  // `next build` also loads instrumentation. Booting a scheduler during a build
  // would be pointless and would fail on machines with no database.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  if (!process.env.DATABASE_URL) {
    console.warn('[settlement] DATABASE_URL is not set — settlement scheduler not started.');
    return;
  }

  try {
    const { bootstrapSettlement } = await import('./server/settlement');
    bootstrapSettlement();
  } catch (error) {
    // Loud, but not fatal: the web app still serves the UI and can report the
    // price. Only settlement is degraded, and the health endpoint surfaces it.
    console.error('[settlement] failed to start scheduler:', error);
  }
}
