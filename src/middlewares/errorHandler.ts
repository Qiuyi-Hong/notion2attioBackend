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
  // Body-parser's own failure, before any route sees the request. Malformed
  // JSON is the first line of the contract's structural list, and it is
  // `invalid_payload` wherever it arrives rather than on one route's say-so.
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({
      error: { code: "invalid_payload", message: "Malformed JSON." },
    });
    return;
  }
  console.error(err);
  res.status(500).json({
    error: { code: "internal_error", message: "Internal Server Error" },
  });
};
