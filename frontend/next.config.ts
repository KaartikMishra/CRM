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
};

export default nextConfig;
