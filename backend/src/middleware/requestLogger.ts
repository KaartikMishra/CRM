import { pinoHttp } from 'pino-http';
import { logger } from '../config/logger.js';

/**
 * Request logging with the noise turned down: health checks are polled
 * constantly by uptime monitors and would otherwise drown the log.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as { id?: string }).id ?? 'unknown',
  autoLogging: {
    ignore: (req) => req.url === '/api/health' || req.url === '/api/health/ready',
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
});
