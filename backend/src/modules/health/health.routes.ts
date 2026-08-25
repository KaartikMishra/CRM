import { Router } from 'express';
import { healthCheck, readinessCheck } from './health.controller.js';

export const healthRoutes = Router();

/** Unauthenticated by design — uptime monitors have no credentials. */
healthRoutes.get('/', healthCheck);
healthRoutes.get('/ready', readinessCheck);
