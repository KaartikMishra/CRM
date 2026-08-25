/**
 * The only error type controllers and services should throw deliberately.
 *
 * `code` is a stable, machine-readable string the frontend can branch on
 * (DELAY_REASON_REQUIRED, PRODUCT_LIMIT_REACHED, …); `message` is written for
 * the employee reading it. Anything thrown that is not an AppError is treated
 * as unexpected and reported to the client as a generic 500.
 */

export type ErrorDetail = {
  path: string;
  message: string;
};

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: ErrorDetail[];
  /** Distinguishes "an expected business outcome" from "a bug". */
  readonly isOperational = true;

  constructor(code: string, statusCode: number, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    if (details) {
      this.details = details;
    }
    Error.captureStackTrace(this, AppError);
  }

  static badRequest(code: string, message: string, details?: ErrorDetail[]): AppError {
    return new AppError(code, 400, message, details);
  }

  static unauthorized(message = 'Sign in to continue.'): AppError {
    return new AppError('UNAUTHENTICATED', 401, message);
  }

  static forbidden(message = 'You do not have access to this action.'): AppError {
    return new AppError('FORBIDDEN', 403, message);
  }

  static notFound(code: string, message: string): AppError {
    return new AppError(code, 404, message);
  }

  static conflict(code: string, message: string): AppError {
    return new AppError(code, 409, message);
  }

  static validation(message: string, details?: ErrorDetail[]): AppError {
    return new AppError('VALIDATION_ERROR', 422, message, details);
  }
}
