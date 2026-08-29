/**
 * The one error shape `docs/http-contract.md` fixes, and its closed list of
 * codes:
 *
 *   { "error": { "code": "...", "message": "...", "details": {...} } }
 */

export type ErrorCode =
  | "not_connected"
  | "wrong_workspace"
  | "no_such_run"
  | "no_such_file"
  | "wrong_stage"
  | "batch_in_progress"
  | "invalid_payload"
  | "notion_failed";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
