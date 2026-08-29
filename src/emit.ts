/**
 * The handoff bundle: what the reviewer downloads and carries into Attio (#56).
 *
 * `docs/handoff-files.md` is authoritative for the file set, the columns and
 * the byte format. This file is that document, executable.
 *
 * Three rules are enforced by shape here rather than documented:
 *
 * - **The bytes are the contract.** UTF-8 with no BOM, CRLF, comma, RFC-4180
 *   quoting, no trailing newline. Every string that leaves here goes through
 *   `csv()`, so there is one place a delimiter or a line ending can be wrong.
 * - **Held is not exported.** A candidate the reviewer held, and one carrying
 *   an uncleared Stop, is `held` — computed in `candidateState`, never here.
 *   The emitter filters on that one field and re-derives nothing.
 * - **A value is read from where it lives.** A Deal's name and its
 *   participants are resolved from the Company and the People it points at,
 *   at the moment the files are written (ADR-0004). Nothing was copied onto
 *   the Deal earlier that could have gone stale.
 *
 * The files are made **once**, in the `emit` node, and the checkpoint holds
 * their bytes. The download serves those bytes and never regenerates them, so
 * what is imported is provably what was reviewed — and downloading twice costs
 * nothing.
 */

import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import * as z from "zod";
import type {
  CompanyCandidate,
  DealCandidate,
  PersonCandidate,
  Repair,
} from "./candidates.ts";
import { personIdOf } from "./candidates.ts";
import type { BatchFlag, CheckedLedger, Flag } from "./flags.ts";
import type { SourceRow } from "./notion.ts";

/**
 * One file in the bundle, as the checkpoint holds it.
 *
 * `content` is **base64**, not text, because one of these files is a ZIP. One
 * shape for every file means the download route has one path and no branch on
 * which kind of bytes it is about to serve.
 *
 * `fileId` is opaque on the wire (`docs/http-contract.md`) so the file set can
 * change without touching the contract. It is the digest of the bytes it
 * names, which makes it stable across reads — a `GET` that answered a
 * different id each poll would be a moving target for a download link.
 */
export const HandoffFile = z.object({
  fileId: z.string(),
  filename: z.string(),
  content: z.string(),
});
export type HandoffFile = z.infer<typeof HandoffFile>;

const file = (filename: string, bytes: Buffer): HandoffFile => ({
  fileId: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  filename,
  content: bytes.toString("base64"),
});

// ── The byte format (#12) ──────────────────────────────────────────────────

/** Not the intuitive LF. Attio's importer is the reason, not our taste. */
const CRLF = "\r\n";

/**
 * RFC-4180: a field is quoted only when it has to be, and a quote inside a
 * quoted field is doubled. Multi-value cells arrive here already joined with
 * comma-space, so the comma is what quotes them — one field, not two.
 */
const cell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** No trailing newline: `join` puts a separator *between* rows and after none. */
const csv = (header: string[], rows: string[][]): Buffer =>
  Buffer.from(
    [header, ...rows].map((row) => row.map(cell).join(",")).join(CRLF),
    "utf8",
  );

// ── What is in the files ───────────────────────────────────────────────────

/** Multi-value, exactly as Attio's own template shows it. */
const multi = (values: string[]) => values.join(", ");

/** Keeping the working sheet's em dash, per `docs/handoff-files.md`. */
const dealName = (company: string) => `${company} — New business`;

/**
 * `Deal stage` has no Notion column, so it comes from the batch flag the
 * reviewer answered — the proposal `config.dealStage` made, or the value they
 * replaced it with. Read from the flag rather than from configuration, so a
 * changed answer cannot be silently ignored by the emitter.
 *
 * A missing flag **throws** rather than defaulting. `check` raises `P1+P2` on
 * every batch, so its absence is a broken invariant, not a state; and the one
 * thing that must not happen is six Deals reaching Attio under a blank stage,
 * on records that always create and can never be undone. A run that throws
 * here stops at a checkpoint the Reviewer can resume from.
 */
const stageOf = (batchFlags: BatchFlag[]): string => {
  const flag = batchFlags.find((one) => one.rule === "P1+P2");
  if (!flag) throw new Error("The batch flag is missing; no Deal stage.");
  return flag.stage;
};

/**
 * What the bundle carries: every Clear and answered candidate, and no Held one.
 *
 * Exported because the write-back asks the same question of the same
 * candidates — *did this reach Attio?* — and `Imported` overstating is exactly
 * what a second reading of `held` would eventually cause (ADR-0007).
 */
export const sent = <T extends { held: boolean }>(candidates: T[]): T[] =>
  candidates.filter((candidate) => !candidate.held);

/**
 * Everything the files are made from: the ledger once reviewed, plus the three
 * things the notes file needs that no candidate carries — the batch it belongs
 * to, the rows it was read from, and what was repaired on the way.
 */
export type Emittable = CheckedLedger & {
  batch: string;
  sourceRows: SourceRow[];
  repairs: Repair[];
};

/** Every candidate in the ledger, whichever object it becomes. */
const candidatesIn = (ledger: CheckedLedger) => [
  ...ledger.companies,
  ...ledger.people,
  ...ledger.deals,
];

/**
 * The three import files, plus the one that is deliberately not an import file.
 *
 * All three are **always written**, empty of rows or not — a missing file and
 * a file with no rows say different things, and only the first is a bug worth
 * noticing. `1-companies.csv` was once conditional (ADR-0003); ADR-0010
 * reversed that, so a reviewer opening the ZIP finds the same file set every
 * week and a header-only companies file reads as *nothing needed one*, never
 * as *a file went missing*.
 */
export function bundleFiles(state: Emittable): HandoffFile[] {
  const companies = sent(state.companies);
  const people = sent(state.people);
  const deals = sent(state.deals);

  const companyOf = new Map(state.companies.map((one) => [one.id, one]));
  const peopleOn = (companyId: string) =>
    people.filter((person) => person.companyId === companyId);

  const members: { filename: string; bytes: Buffer }[] = [];

  /**
   * A Company candidate is never dropped with its people (ADR-0003). Holding
   * an account's only contact must not silently delete an account that was
   * qualified, so the company travels in a file of its own.
   *
   * Only those companies: one with an exported person already reaches Attio
   * through that person's row, and listing it here as well would offer Attio
   * the same record twice. The *rows* stay conditional — the **file** does
   * not (ADR-0010).
   */
  const withNoExportedPerson = companies.filter(
    (company) => peopleOn(company.id).length === 0,
  );
  members.push({
    filename: "1-companies.csv",
    bytes: csv(
      ["Name", "Domains", "Primary location", "Segment"],
      withNoExportedPerson.map((company) => [
        company.name,
        company.domain,
        company.primaryLocation,
        company.segment,
      ]),
    ),
  });

  members.push({
    filename: "2-people.csv",
    bytes: csv(
      [
        "Person name",
        "Email addresses",
        "Job title",
        "LinkedIn",
        "Lead source",
        "Source ID",
        "Company name",
        "Company domain",
        "Company segment",
        "Company primary location",
      ],
      people.map((person) => {
        const company = companyOf.get(person.companyId);
        return [
          person.name,
          person.email,
          person.jobTitle,
          person.linkedIn,
          person.leadSource,
          person.sourceId,
          company?.name ?? "",
          company?.domain ?? "",
          company?.segment ?? "",
          company?.primaryLocation ?? "",
        ];
      }),
    ),
  });

  const stage = stageOf(state.batchFlags);
  members.push({
    filename: "3-deals.csv",
    bytes: csv(
      [
        "Deal name",
        "Deal owner",
        "Deal stage",
        "Associated company domain",
        "Associated people email addresses",
      ],
      deals.map((deal) => {
        const company = companyOf.get(deal.companyId);
        return [
          dealName(company?.name ?? ""),
          deal.owner,
          stage,
          company?.domain ?? "",
          multi(peopleOn(deal.companyId).map((person) => person.email)),
        ];
      }),
    ),
  });

  // Written last, and handed the import files it is about: the row counts a
  // reviewer reconciles against Attio's import screen are read off the bytes
  // that will actually be in the ZIP, never counted a second way.
  members.push({
    filename: "handoff-notes.md",
    bytes: Buffer.from(
      notes(state, { companies, people, deals }, members),
      "utf8",
    ),
  });

  /**
   * The bundle itself, first, because it is the one thing the reviewer needs.
   * The members are listed beside it so the surface can name what is inside
   * without opening it, and so a reviewer who wants one file can take one.
   */
  return [
    file(`handoff-${state.batch}.zip`, zip(members)),
    ...members.map((member) => file(member.filename, member.bytes)),
  ];
}

// ── `handoff-notes.md` ─────────────────────────────────────────────────────

/**
 * Markdown, and deliberately **never** a CSV: a fourth CSV would be offered to
 * Attio's import screen by an auto-mapper and by a tired human alike.
 *
 * It carries the three things that otherwise live only on the review screen
 * and vanish with the tab — the `Research notes` prose Attio's importer cannot
 * take, the repair log, and every flag with its answer.
 */
function notes(
  state: Emittable,
  bundle: {
    companies: CompanyCandidate[];
    people: PersonCandidate[];
    deals: DealCandidate[];
  },
  importFiles: { filename: string; bytes: Buffer }[],
): string {
  const companyOf = new Map(state.companies.map((one) => [one.id, one]));
  const exported = new Set(bundle.people.map((person) => person.id));

  /** A candidate by the name a person would recognise, never by its id. */
  const named = new Map<string, string>([
    ...state.companies.map((one) => [one.id, one.name] as const),
    ...state.people.map((one) => [one.id, one.name] as const),
    ...state.deals.map(
      (one) =>
        [one.id, dealName(companyOf.get(one.companyId)?.name ?? "")] as const,
    ),
  ]);

  const lines: string[] = [
    `# Handoff notes — batch ${state.batch}`,
    "",
    "Not an import file. Attio never sees this. It is here because Attio cannot",
    "import notes by CSV, so the `Research notes` prose has nowhere else to",
    "travel — and because the repair log and the flag record otherwise live only",
    "on the review screen and vanish with the tab.",
    "",
    `Run \`${state.batch}\` · ${state.sourceRows.length} source rows.`,
    "",
    "---",
    "",
    "## 1. What was handed off",
    "",
    "| file | rows |",
    "| --- | --- |",
    // The candidate counts are deliberately not repeated here. A Company
    // reaches Attio through a person row as often as through a file, so
    // *seven companies* beside a one-row companies file is two numbers a
    // reviewer would try to reconcile and could not. What they can check
    // against Attio's import screen is a row count per file, so that is what
    // this says.
    ...importFiles.map(
      // Rows, not lines: the header is not a row, and there is no trailing
      // newline, so one CRLF is one row.
      (member) =>
        `| \`${member.filename}\` | ${[...member.bytes].filter((byte) => byte === 0x0d).length} |`,
    ),
    "",
    "Import in that order. People must land before Deals, because a deal can",
    "only attach to a company that already exists.",
    "",
    "---",
    "",
    "## 2. Research notes to paste by hand",
    "",
    "Attio takes these only through the UI. Open each person — or the company,",
    "where the person was held — and paste.",
    "",
  ];

  for (const row of state.sourceRows) {
    const note = row["Research notes"];
    if (!note) continue;
    const held = !exported.has(personIdOf(row));
    lines.push(
      `**${row.Account ?? ""} — ${row.Contact ?? ""}**` +
        (held ? " *(held — paste onto the company)*" : ""),
      `> ${note}`,
      "",
    );
  }

  lines.push(
    "---",
    "",
    "## 3. Repair log",
    "",
    "Every silent repair the run made. Silent means the reviewer did not have to",
    "approve it — not that it was hidden. One entry per source row repaired, so a",
    "candidate several rows collapsed onto carries one for each.",
    "",
    "| source row | field | from | to |",
    "| --- | --- | --- | --- |",
  );
  for (const repair of state.repairs) {
    lines.push(
      `| \`${repair.sourceId}\` | ${repair.field} | \`${repair.from}\` | \`${repair.to}\` |`,
    );
  }
  if (state.repairs.length === 0) lines.push("| — | — | — | — |");

  lines.push(
    "",
    "---",
    "",
    "## 4. Flags and how they were answered",
    "",
    "| flag | on | level | answer |",
    "| --- | --- | --- | --- |",
  );

  const answer = (flag: Flag | BatchFlag) =>
    flag.refused
      ? `refused — ${flag.refused}`
      : flag.cleared
        ? "answered"
        : "not answered";

  /**
   * Two answers carry a value, and both are written out: `B1`'s work email —
   * which is now the Person's own, so it is read from where it lives rather
   * than from a copy — and the batch flag's `Deal stage`.
   *
   * Every other answer is `true`, which `docs/http-contract.md` defines as
   * *answered, with nothing to supply*: a Warn read, or a decision taken. For
   * those the word is genuinely the whole of the answer, and the row it
   * changed is in the files beside this.
   */
  const answerOn = (
    candidate: CompanyCandidate | PersonCandidate | DealCandidate,
    flag: Flag,
  ) => {
    // `D1` is the one flag nothing answers: it has no control and is cleared
    // by its account becoming whole (ADR-0005). Reading "not answered" against
    // it would name the Reviewer for something they were never offered.
    if (flag.rule === "D1") {
      return flag.cleared
        ? "cleared — the account is whole"
        : "not cleared — the account is not whole";
    }
    return flag.rule === "B1" && flag.cleared && "email" in candidate
      ? `${answer(flag)} — work email \`${candidate.email}\``
      : answer(flag);
  };

  // Every flag in the batch, on a held candidate as much as on an exported
  // one: a Stop that removed a row from the files is exactly the record this
  // file exists to keep.
  for (const candidate of candidatesIn(state)) {
    for (const flag of candidate.flags) {
      lines.push(
        `| ${flag.rule} | ${named.get(candidate.id) ?? ""} | ${flag.level} | ${answerOn(candidate, flag)} |`,
      );
    }
  }
  for (const flag of state.batchFlags) {
    const detail =
      flag.rule === "P1+P2"
        ? `${answer(flag)} — stage \`${flag.stage}\``
        : answer(flag);
    lines.push(`| ${flag.rule} | the batch | ${flag.level} | ${detail} |`);
  }

  /**
   * Held candidates are named, not merely absent. A row that left the batch
   * without a line saying so is the failure this file exists to prevent.
   */
  const held = candidatesIn(state).filter((candidate) => candidate.held);
  lines.push("", "---", "", "## 5. Held, not handed off", "");
  if (held.length === 0) {
    lines.push(
      "Nothing was held. Every candidate in the batch was handed off.",
    );
  } else {
    lines.push(
      "These stay at `Ready for CRM` in Notion and come back when the batch is",
      "re-run.",
      "",
    );
    for (const candidate of held) {
      lines.push(`- ${named.get(candidate.id) ?? ""}`);
    }
  }

  lines.push(
    "",
    "---",
    "",
    "## 6. After importing",
    "",
    "Return to the app and confirm the batch landed. Only then does the run set",
    "`CRM status` = `Imported` in Notion, and only on the source rows whose",
    "**every** candidate landed — `Imported` means finished, not partly",
    "finished. A held row keeps `Ready for CRM` and comes back when the batch is",
    "re-run.",
    "",
  );

  return lines.join("\n");
}

// ── The ZIP ────────────────────────────────────────────────────────────────

/**
 * One ZIP named for the batch, so a download sitting in a folder for a week
 * still says what it is.
 *
 * Written here rather than taken from a dependency: the archive is four small
 * files and needs no compression, which makes it a header, the bytes, and a
 * directory of the same. **Stored, not deflated**, and stamped with a fixed
 * timestamp, so the same bundle is the same bytes every time it is built —
 * which is what makes "downloading twice returns identical bytes" a property
 * of the format rather than of the storage.
 *
 * ponytail: no ZIP64 and no compression. Four CSVs will not reach 4GB, and a
 * batch that does wants streaming rather than a bigger header.
 */
function zip(members: { filename: string; bytes: Buffer }[]): Buffer {
  // 1980-01-01, the earliest a DOS timestamp can name. A real clock here would
  // make two builds of one bundle differ in bytes for no reader's benefit.
  const TIME = 0;
  const DATE = 0x0021;

  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const name = Buffer.from(member.filename, "utf8");
    const sum = crc32(member.bytes);
    const size = member.bytes.length;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // the filename is UTF-8
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(TIME, 10);
    header.writeUInt16LE(DATE, 12);
    header.writeUInt32LE(sum, 14);
    header.writeUInt32LE(size, 18); // compressed
    header.writeUInt32LE(size, 22); // uncompressed
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // no extra field

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10); // stored
    entry.writeUInt16LE(TIME, 12);
    entry.writeUInt16LE(DATE, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal and external attributes all zero
    entry.writeUInt32LE(offset, 42);

    local.push(header, name, member.bytes);
    central.push(entry, name);
    offset += header.length + name.length + size;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, directory, end]);
}

// ── The export gate ────────────────────────────────────────────────────────

/**
 * The batch refuses to export while any Warn is unanswered
 * (`CONTEXT.md`, *Handoff bundle*).
 *
 * A **Stop** is not in this reading, and that is the design rather than an
 * omission: an uncleared Stop makes its candidate Held, so it removes a
 * candidate from the files instead of blocking them. A Warn excludes nothing,
 * which is exactly why it has to be answered before the files are made — a
 * notice nobody read would otherwise leave in the bundle silently.
 */
export const unansweredWarn = (ledger: CheckedLedger): boolean =>
  [
    ...candidatesIn(ledger).flatMap((candidate) => candidate.flags),
    ...ledger.batchFlags,
  ].some((flag) => flag.level === "warn" && !flag.cleared);
