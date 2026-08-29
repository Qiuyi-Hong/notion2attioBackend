/**
 * The write-back: `CRM status` = `Imported`, on the rows this run handed off
 * (#57). The only place this system mutates anything outside itself.
 *
 * Three rules are enforced by shape here rather than documented (ADR-0007):
 *
 * - **Idempotent against Notion, not against a record of ours.** The node
 *   re-queries `Batch = <batch> AND CRM status = Ready for CRM` and writes only
 *   what is still ready. That is one mechanism doing three jobs — double-submit
 *   safety, crash recovery, and making a retry free — and no bookkeeping of
 *   ours could do any of them, because graph state checkpoints at node
 *   boundaries and so is lost by exactly the failure it would exist to survive.
 * - **`Imported` never overstates.** A row is written only when *every*
 *   candidate it became was exported. A row whose person the reviewer held
 *   keeps `Ready for CRM` and comes back when the batch is re-run (ADR-0005).
 * - **No outcome is an HTTP error.** Every status Notion answers becomes run
 *   state on the run's own surface, `401` included. The reviewer is looking at
 *   the ledger, not at the response to a POST they will never see again.
 *
 * `written` is derived — the handed-off rows minus the failures — rather than
 * accumulated across passes. A row that is no longer `Ready for CRM` was
 * marked, by an earlier pass or by a person, and either way it is written.
 * `allFailed` is the one exception, and it is one because Notion cannot be
 * asked there: with no token, or a token for the wrong workspace, the run's own
 * record of an earlier pass is the only thing that keeps rows which did land
 * out of the list the reviewer takes to Notion to repair by hand.
 */

import * as z from "zod";
import { candidateIdsOf } from "./candidates.ts";
import { sent } from "./emit.ts";
import { ApiError } from "./errors.ts";
import type { CheckedLedger } from "./flags.ts";
import {
  findSharedDataSource,
  markImported,
  PAGE_ID,
  queryBatchRows,
  type SourceRow,
} from "./notion.ts";
import { readConnection } from "./store.ts";

/**
 * Why a row was not marked. A closed list of machine codes, like a flag's
 * `refused`: no prose travels on the wire, and the surface renders a fixed
 * sentence for each.
 *
 * The first three are **batch-wide** — they are true of every remaining row,
 * so the node stops at the first one rather than collecting seven identical
 * errors. Every unwritten row still appears in `failed` under that one cause,
 * because which rows went unflipped is the thing the reviewer needs in order
 * to go and fix Notion by hand.
 */
export const Cause = z.enum([
  // No live Connection, or a live one whose grant reaches no database we can
  // read. Both are the same repair — authorise again, over the database.
  "not_connected",
  "wrong_workspace",
  "unauthorised",
  "rate_limited",
  "notion_unavailable",
  "notion_refused",
]);
export type Cause = z.infer<typeof Cause>;

const BATCH_WIDE: ReadonlySet<Cause> = new Set<Cause>([
  "not_connected",
  "wrong_workspace",
  "unauthorised",
]);

/** What a write-back leaves behind, and the whole of the retry panel's input. */
export const WriteBack = z.object({
  written: z.array(z.string()).default(() => []),
  failed: z
    .array(z.object({ sourceId: z.string(), cause: Cause }))
    .default(() => []),
});
export type WriteBack = z.infer<typeof WriteBack>;

/** The attestation the second pause is answered with (`docs/http-contract.md`). */
export const Confirmation = z.union([
  z.strictObject({ confirmed: z.literal(true) }),
  z.strictObject({ abandoned: z.literal(true) }),
]);
export type Confirmation = z.infer<typeof Confirmation>;

/** Everything the write-back reads, which is the reviewed ledger and its rows. */
export type Writable = CheckedLedger & {
  batch: string;
  sourceRows: SourceRow[];
  workspaceId: string | null;
  /** What an earlier pass left behind, and `null` before the first. */
  writeBack: WriteBack | null;
};

/**
 * One row of the batch, by the two identifiers the write-back needs. The
 * **page id** is what every set here is keyed on, because it is Notion's own
 * and cannot repeat; `sourceId` is what the reviewer reads, and is only ever
 * mapped to at the end.
 */
interface HandedRow {
  sourceId: string;
  pageId: string;
}

const sourceIdOf = (row: HandedRow) => row.sourceId;

/**
 * The rows whose **every** candidate reached the CRM.
 *
 * A source row becomes a Company, a Person and a Deal, and holding any one of
 * them keeps the row out of Attio — a person held under `B1` leaves their
 * company exported alone (ADR-0003), which is not the row landing. So the test
 * is all three.
 *
 * Neither half of it is derived twice. The ids are `candidateIdsOf`'s, which
 * the transform also keys on; *was this exported* is `emit`'s own `sent`, which
 * is what actually decided the CSV rows. Two readings of either could drift,
 * and drift here is `Imported` overstating.
 */
export function handedOff(state: Writable): HandedRow[] {
  const exported = new Set(
    [...sent(state.companies), ...sent(state.people), ...sent(state.deals)].map(
      (candidate) => candidate.id,
    ),
  );
  return state.sourceRows
    .filter((row) => {
      const ids = candidateIdsOf(row);
      return (
        exported.has(ids.companyId) &&
        exported.has(ids.personId) &&
        exported.has(ids.dealId)
      );
    })
    .map((row) => ({
      // Both are always present: `queryBatchRows` drops a result with no page
      // id, and `Source ID` is the source database's own key.
      sourceId: row["Source ID"] ?? "",
      pageId: row[PAGE_ID] ?? "",
    }));
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));

/** ~3 requests per second, which is what #4 measured Notion's average to be. */
const PACE_MS = 334;

/** One attempt, then the two retries a `5xx` gets (ADR-0007). */
const ATTEMPTS = 3;

/**
 * The wait is the header's, honoured as sent. The cap is short on purpose:
 * ADR-0007 rejected following Notion's documented policy verbatim precisely
 * because the reviewer has clicked Confirm and is watching, and ruled that
 * **past a short budget the Retry button is the backoff**. A `Retry-After`
 * longer than this is not waited out in the foreground; the row fails as
 * `rate_limited` and the reviewer decides when to try again.
 */
const RETRY_AFTER_CAP_MS = 5_000;

/** `null` is *longer than the foreground has*, and stops the row's retries. */
const retryAfterMs = (res: Response): number | null => {
  const seconds = Number(res.headers.get("Retry-After"));
  if (!Number.isFinite(seconds)) return PACE_MS;
  const wait = seconds * 1000;
  return wait > RETRY_AFTER_CAP_MS ? null : wait;
};

/**
 * One row marked, with its retry budget. `null` is success.
 *
 * A `429` waits the `Retry-After` it was given and a `5xx` waits the pace; past
 * the budget the node stops and the Retry button is the backoff, which is
 * honest about what is happening in a way a node retrying silently for two
 * minutes is not.
 */
async function writeOne(
  accessToken: string,
  pageId: string,
): Promise<Cause | null> {
  for (let attempt = 1; ; attempt += 1) {
    const res = await markImported(accessToken, pageId);
    if (res.ok) return null;
    // A revoked or reconnected grant fails every remaining write, so retrying
    // this one buys nothing.
    if (res.status === 401) return "unauthorised";
    const rateLimited = res.status === 429;
    if (!rateLimited && res.status < 500) return "notion_refused";
    if (attempt >= ATTEMPTS) {
      return rateLimited ? "rate_limited" : "notion_unavailable";
    }
    const wait = rateLimited ? retryAfterMs(res) : PACE_MS;
    if (wait === null) return "rate_limited";
    await sleep(wait);
  }
}

/**
 * Nothing further can be written, and the one reason is true of every row that
 * still needed writing.
 *
 * This is the **only** place the run's own record of an earlier pass is read,
 * and it is read because Notion cannot be asked: there is either no token or a
 * token for the wrong workspace. Without it a row written on the first pass
 * would be reported as failed on the second, which would send the reviewer to
 * Notion to repair rows that are already `Imported`.
 */
const allFailed = (
  rows: HandedRow[],
  cause: Cause,
  written: ReadonlySet<string>,
): WriteBack => ({
  written: rows.filter((row) => written.has(row.sourceId)).map(sourceIdOf),
  failed: rows
    .filter((row) => !written.has(row.sourceId))
    .map((row) => ({ sourceId: row.sourceId, cause })),
});

/**
 * The node's whole body.
 *
 * The workspace check is kept here **as well as** on the confirm route: a run
 * left `stalled` at this node is re-entered through `POST
 * /api/runs/:runId/continue`, which never passes that route (ADR-0008). The
 * route check is the message; this one is the guard of last resort.
 */
export async function writeBackOf(state: Writable): Promise<WriteBack> {
  const rows = handedOff(state);
  if (rows.length === 0) return { written: [], failed: [] };
  const before = new Set(state.writeBack?.written ?? []);

  const connection = readConnection();
  if (!connection) return allFailed(rows, "not_connected", before);
  if (state.workspaceId && connection.workspace_id !== state.workspaceId) {
    return allFailed(rows, "wrong_workspace", before);
  }

  const { access_token: accessToken } = connection;
  let stillReady: SourceRow[];
  try {
    const dataSourceId = await findSharedDataSource(accessToken);
    // A live grant that reaches no database we can read: the rows cannot be
    // marked through it, and the repair is authorising again over the database
    // — which is what `not_connected` asks for.
    if (!dataSourceId) return allFailed(rows, "not_connected", before);
    stillReady = await queryBatchRows(accessToken, dataSourceId, state.batch);
  } catch (error) {
    // The read side throws `ApiError`, and here it is not one: a write-back
    // outcome is never an HTTP error, so the same two statuses become the same
    // two causes the writes themselves would have produced.
    const expired = error instanceof ApiError && error.code === "not_connected";
    return allFailed(rows, expired ? "unauthorised" : "notion_refused", before);
  }

  const ready = new Set(stillReady.map((row) => row[PAGE_ID]));
  // Anything no longer ready was already marked — by an earlier pass, by the
  // half of a write that survived a process death, or by a person in Notion.
  // That is the re-query answering the question our own record cannot.
  const toWrite = rows.filter((row) => ready.has(row.pageId));

  const failed: { row: HandedRow; cause: Cause }[] = [];
  for (const [index, row] of toWrite.entries()) {
    if (index > 0) await sleep(PACE_MS);
    const cause = await writeOne(accessToken, row.pageId);
    if (!cause) continue;
    if (BATCH_WIDE.has(cause)) {
      failed.push(
        ...toWrite.slice(index).map((rest) => ({ row: rest, cause })),
      );
      break;
    }
    failed.push({ row, cause });
  }

  const unwritten = new Set(failed.map((one) => one.row.pageId));
  return {
    written: rows.filter((row) => !unwritten.has(row.pageId)).map(sourceIdOf),
    failed: failed.map(({ row, cause }) => ({ sourceId: row.sourceId, cause })),
  };
}
