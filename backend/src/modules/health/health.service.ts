import { pingDatabase, type DatabaseHealth } from '../../config/database.js';
import { env } from '../../config/env.js';

export type LivenessReport = {
  status: 'ok';
  service: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
};

export type ReadinessReport = LivenessReport & {
  database: DatabaseHealth;
  ready: boolean;
};

const SERVICE_NAME = 'royalstuffs-crm-api';

function baseReport(): LivenessReport {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/** Liveness: is the process running? Deliberately touches nothing external. */
export function getLiveness(): LivenessReport {
  return baseReport();
}

/** Readiness: can the process actually serve traffic? Includes the database. */
export async function getReadiness(): Promise<ReadinessReport> {
  const database = await pingDatabase();
  return { ...baseReport(), database, ready: database.status === 'up' };
}
