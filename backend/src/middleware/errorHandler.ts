/**
 * Centralized error handling for the Express app.
 */
import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';

/** A known, expected application error carrying an HTTP status code. */
export class AppError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'AppError';
  }
}

/**
 * Express error-handling middleware. Must be registered after all routes.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Map known Prisma errors to meaningful HTTP statuses instead of a blanket 500.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'A record with these unique values already exists' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'The requested record was not found' });
      return;
    }
  }

  // eslint-disable-next-line no-console
  console.error('Unexpected error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
