/**
 * §52 — the single place failures become responses.
 *
 * Nothing about the internals crosses the wire: no stack traces, no SQL, no
 * connection strings, no Prisma metadata. Unexpected errors are logged in full
 * with the request id and answered with a generic message carrying that id, so
 * a developer can find the detail without the client ever seeing it.
 */

import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@rs/database';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';
import type { ErrorBody } from '../utils/apiResponse.js';
import { toErrorDetails } from './validate.js';

/**
 * Postgres CHECK constraints are the final guarantee behind the business rules
 * (§62). Reaching one means application validation was bypassed or raced, so
 * the response stays friendly while the log records the real cause.
 */
const CONSTRAINT_MESSAGES: Record<string, { code: string; message: string }> = {
  line_no_within_20: {
    code: 'PRODUCT_LIMIT_REACHED',
    message: 'An enquiry can hold at most 20 products.',
  },
  no_vendor_has_reason: {
    code: 'NO_VENDOR_REASON_REQUIRED',
    message: 'Give a reason before marking a product as having no vendor.',
  },
  other_source_specified: {
    code: 'SOURCE_DETAIL_REQUIRED',
    message: 'Specify the source when the enquiry came from "Others".',
  },
  quantity_positive: {
    code: 'INVALID_QUANTITY',
    message: 'Quantity must be at least 1.',
  },
  rate_non_negative: {
    code: 'INVALID_RATE',
    message: 'A vendor rate cannot be negative.',
  },
  delivery_positive: {
    code: 'INVALID_DELIVERY_DAYS',
    message: 'Delivery time must be at least one day.',
  },
};

function matchConstraint(message: string): { code: string; message: string } | undefined {
  const name = Object.keys(CONSTRAINT_MESSAGES).find((key) => message.includes(key));
  return name ? CONSTRAINT_MESSAGES[name] : undefined;
}

function translatePrismaError(error: unknown): AppError | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':
        return AppError.conflict('DUPLICATE_RECORD', 'That record already exists.');
      case 'P2025':
        return AppError.notFound('RECORD_NOT_FOUND', 'That record no longer exists.');
      case 'P2003':
        return AppError.badRequest(
          'RELATED_RECORD_MISSING',
          'One of the linked records could not be found.',
        );
      case 'P2000':
        return AppError.badRequest('VALUE_TOO_LONG', 'One of the values is too long.');
      default:
        break;
    }
  }

  // CHECK-constraint violations surface as raw database errors.
  if (
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientKnownRequestError
  ) {
    const matched = matchConstraint(error.message);
    if (matched) {
      return AppError.conflict(matched.code, matched.message);
    }
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return new AppError(
      'DATABASE_UNAVAILABLE',
      503,
      'The service is temporarily unavailable. Try again in a moment.',
    );
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    // A malformed query is a bug, not a client mistake.
    return undefined;
  }

  return undefined;
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express delegates to the default handler if the response has already begun.
  if (res.headersSent) {
    next(error);
    return;
  }

  // A Zod error escaping a service means validation ran outside the middleware.
  const normalised =
    error instanceof AppError
      ? error
      : error instanceof ZodError
        ? AppError.validation('Some of the details need fixing.', toErrorDetails(error))
        : isJsonParseError(error)
          ? AppError.badRequest('MALFORMED_JSON', 'The request body is not valid JSON.')
          : isCorsError(error)
            ? AppError.forbidden('This origin is not allowed to call the API.')
            : translatePrismaError(error);

  if (normalised) {
    if (normalised.statusCode >= 500) {
      logger.error({ err: error, requestId: String(req.id) }, normalised.message);
    } else {
      logger.warn(
        { requestId: String(req.id), code: normalised.code, path: req.path },
        normalised.message,
      );
    }

    const body: ErrorBody = {
      success: false,
      message: normalised.message,
      code: normalised.code,
      requestId: String(req.id),
    };
    if (normalised.details) {
      body.details = normalised.details;
    }

    res.status(normalised.statusCode).json(body);
    return;
  }

  // Anything reaching here is unexpected: log everything, disclose nothing.
  logger.error(
    { err: error, requestId: String(req.id), method: req.method, path: req.path },
    'Unhandled error',
  );

  const body: ErrorBody = {
    success: false,
    message: 'Something went wrong. Quote the request id if you report this.',
    code: 'INTERNAL_ERROR',
    requestId: String(req.id),
  };

  res.status(500).json(body);
}

function isJsonParseError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    'status' in error &&
    (error as { status?: number }).status === 400 &&
    'body' in error
  );
}

function isCorsError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Not allowed by CORS';
}
