import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 'standalone' emits a self-contained server bundle for the Docker image /
  // long-running host. We rely on a long-lived Node process so the in-process
  // settlement scheduler can run (see DECISIONS.md D3).
  output: 'standalone',
  // `pg` resolves optional native bindings at runtime; keep it out of the
  // bundler so those requires stay intact.
  serverExternalPackages: ['pg'],
  poweredByHeader: false,
};

export default nextConfig;
