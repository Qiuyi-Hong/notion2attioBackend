import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../errors.ts";

/**
 * Every failure leaves in the one shape `docs/http-contract.md` fixes. A code
 * outside its closed list means we threw something we did not plan for, which
 * is a `500` and a stack trace in the log rather than a contract error.
 */
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  void next;
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      },
    });
    return;
  }
  console.error(err);
  res.status(500).json({
    error: { code: "internal_error", message: "Internal Server Error" },
  });
};
