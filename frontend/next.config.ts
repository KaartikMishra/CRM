import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

/*
  §12 — AUTH_SECRET is shared by both tiers, so it must come from one file.
  Next.js resolves .env relative to this package; the workspace keeps a single
  .env at the root, so it is loaded explicitly here rather than duplicated.
*/
loadDotenv({ path: resolve(process.cwd(), '../.env') });

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @rs/shared ships TypeScript-built ESM; Next compiles it with the app.
  transpilePackages: ['@rs/shared'],
  // This tier renders UI and holds the session. It never reaches the database,
  // so nothing here should ever resolve Prisma.
  serverExternalPackages: [],

  /*
    RS Products shows Shopify's own product photography, which is served from
    Shopify's CDN. next/image refuses an unconfigured remote host outright —
    loudly, not silently — so the host is declared here.

    Images only: this grants no credential and reaches no API. The alternative,
    proxying 2,231 images through our backend, would add cost and a failure
    mode for no benefit while Shopify remains the source of truth.
  */
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'cdn.shopify.com', pathname: '/**' }],
  },
};

export default nextConfig;
