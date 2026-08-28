# Human-in-the-loop in current LangGraph.js — research for issue #3

**Researched:** 2026-08-29. **Verified against:** npm registry (live), the published `@langchain/langgraph@1.4.13` tarball's own `.d.ts` / `dist` files, `docs.langchain.com/oss/javascript/*`, and `github.com/langchain-ai/langgraphjs`.

Everything marked **[verified by running it]** was executed locally in a throwaway project (`/tmp/lgtest`, Node v24.14.1, ESM) against the exact versions below. Nothing was installed into this repo.

> **Read this first — my training data was stale and probably yours is too.** LangGraph.js is on **1.x**, not 0.2/0.3. The docs and examples now use `new StateSchema({...})` with Zod, not `Annotation.Root({...})`. `Annotation` is still exported and still works, but every current doc example uses `StateSchema`. `streamEvents(..., { version: "v3" })` is a new typed-projection API that did not exist in 0.x. There is a native `encoding: "text/event-stream"` option that emits SSE bytes directly.

---

## 0. TL;DR for the architecture tickets

| Question | Answer |
|---|---|
| Current pause/resume API | `interrupt(value)` inside a node + `graph.invoke(new Command({ resume }), config)`. Not superseded. |
| Can resume carry edited row data? | **Yes.** Any JSON-serializable value, including an array of row objects. **[verified by running it]** |
| How is a run addressed across requests? | `config.configurable.thread_id`. That string is the entire cross-request handle. |
| What must be persisted? | Only the checkpointer's own tables. The graph state (all 50 rows) lives inside the checkpoint. You persist nothing yourself except the `thread_id` you hand the browser. |
| Minimum that survives a page reload | `MemorySaver` (in-process RAM) survives a page reload but **not** a server restart / `tsx watch` reload. |
| Minimum that survives a server restart | `SqliteSaver` — one file, no `.setup()` call needed, no daemon. **Recommended for this demo.** |
| LangGraph Platform / Agent Server required? | **No.** Embed the compiled graph in Express and call `.invoke()` / `.stream()`. |
| Streaming worth wiring? | **No** for the three-node graph, with one cheap exception (see §7). |
| Biggest gotcha | The interrupted node **re-runs from the top** on resume. Second biggest: **no concurrency control** — two simultaneous resumes on one thread both succeed. **[verified by running it]** |

---

## 1. Packages and versions (verified live on npm, 2026-08-29)

```
@langchain/langgraph                      1.4.13   (published 2026-08-26)
@langchain/langgraph-checkpoint           1.1.5    (transitive dep of the above)
@langchain/langgraph-checkpoint-sqlite    1.0.4
@langchain/langgraph-checkpoint-postgres  1.0.5
@langchain/langgraph-checkpoint-redis     1.0.11
@langchain/langgraph-checkpoint-mongodb   1.4.1
@langchain/core                           1.2.9
langchain                                 1.5.10   (NOT needed for this)
@langchain/langgraph-sdk                  1.10.0   (client for a LangGraph *server* — NOT needed)
@langchain/langgraph-cli                  1.4.5    (Platform tooling — NOT needed)
@langchain/langgraph-api                  1.4.5    (Platform tooling — NOT needed)
```

Source: `npm view <pkg> version` against the live registry.

### Peer/engine constraints (from the 1.4.13 `package.json`)

```jsonc
"peerDependencies": {
  "@langchain/core": "^1.1.48",
  "zod": "^3.25.32 || ^4.2.0"          // required, not optional (no peerDependenciesMeta)
},
"dependencies": {
  "@langchain/protocol": "^0.0.18",
  "@standard-schema/spec": "1.1.0",
  "@langchain/langgraph-checkpoint": "^1.1.5",
  "@langchain/langgraph-sdk": "~1.10.0"
},
"engines": { "node": ">=18" }
```

Note `@langchain/langgraph-sdk` is a hard dependency of the core package — it ships regardless; you don't install or use it.

### Install for this project

```bash
npm install @langchain/langgraph @langchain/core zod
npm install @langchain/langgraph-checkpoint-sqlite     # for the durable checkpointer
```

The README's canonical install line is `npm install @langchain/langgraph @langchain/core` — <https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/README.md>.

**[verified by running it]** The above installs cleanly into an ESM (`"type": "module"`) Node 24 project and resolves to `zod@4.5.1`, `better-sqlite3@12.11.1` (a prebuilt binary — no compile step was needed on darwin/arm64).

### Do we need LangGraph Platform / Agent Server? No.

- `libs/langgraph-core/README.md`: *"While LangGraph can be used standalone, it also integrates seamlessly with any LangChain product…"* and *"LangGraph is built by LangChain Inc, the creators of LangChain, but can be used without LangChain."* — <https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/README.md>
- The checkpointers doc frames the server as the *alternative* to doing it yourself: *"**Agent Server handles checkpointing automatically.** When using the Agent Server, you do not need to implement or configure checkpointers manually."* — <https://docs.langchain.com/oss/javascript/langgraph/checkpointers>. The corollary is explicit: when you are *not* on the server, you configure a checkpointer yourself, which is exactly what we do.
- Every JS example in the interrupts, checkpointers and event-streaming docs calls `graph.invoke(...)` / `graph.stream(...)` in-process. There is no server in any of them.

`@langchain/langgraph-cli`, `@langchain/langgraph-api` and `@langchain/langgraph-sdk` are the Platform path (a `langgraph.json`, a dev server, an HTTP client). We use none of them. **Decision: embed the compiled graph in the Express process.**

---

## 2. The interrupt / resume API as it exists today

### 2.1 Type signatures, straight from the published `.d.ts`

`@langchain/langgraph@1.4.13/dist/interrupt.d.ts`:

```ts
declare function interrupt<I = unknown, R = any>(value: I): R;
```

`.../dist/constants.d.ts`:

```ts
declare const INTERRUPT = "__interrupt__";

type Interrupt<Value = any> = { id?: string; value?: Value };

declare function isInterrupted<Value = unknown>(
  values: unknown
): values is { [INTERRUPT]: Interrupt<Value>[] };

type CommandParams<Resume = unknown, Update = Record<string, unknown>, Nodes extends string = string> = {
  lg_name?: "Command";
  resume?: Resume;            // "Value to resume execution with. To be used together with interrupt."
  graph?: string;
  update?: Update | [string, unknown][];
  goto?: Nodes | SendInterface<Nodes> | (Nodes | SendInterface<Nodes>)[];
};
```

Note the `Interrupt` shape is now just `{ id?, value? }`. Older versions carried `when` / `resumable` / `ns` fields; **they are gone in 1.x**. If you remember reading `interrupt.resumable`, that memory is stale.

`.../dist/pregel/types.d.ts`:

```ts
interface PregelTaskDescription {
  readonly id: string;
  readonly name: string;
  readonly error?: unknown;
  readonly interrupts: Interrupt[];     // <-- tasks[].interrupts
  readonly state?: LangGraphRunnableConfig | StateSnapshot;
  readonly path?: TaskPath;
  readonly result?: unknown;
}

interface StateSnapshot {
  readonly values: Record<string, any> | any;
  readonly next: Array<string>;          // [] means finished
  readonly config: RunnableConfig;       // contains thread_id / checkpoint_ns / checkpoint_id
  readonly metadata?: CheckpointMetadata;
  readonly createdAt?: string;
  readonly parentConfig?: RunnableConfig | undefined;
  readonly tasks: PregelTaskDescription[];
}
```

`.../dist/pregel/index.d.ts`:

```ts
getState(config: RunnableConfig, options?: GetStateOptions): Promise<StateSnapshot>;
getStateHistory(config: RunnableConfig, options?: CheckpointListOptions): AsyncIterableIterator<StateSnapshot>;
updateState(inputConfig: LangGraphRunnableConfig, values: Record<string, unknown> | unknown, asNode?: keyof Nodes | string): Promise<RunnableConfig>;
invoke(input: InputType | CommandType | null, options?: ...): Promise<OutputType>;
```

### 2.2 Runnable TypeScript — our actual shape

This is the four-node version of our pipeline. **It type-checks under `tsc --strict` with `module: NodeNext`, and it runs.** **[verified by running it]**

```ts
// graph.ts
import {
  StateGraph, StateSchema, START, END,
  interrupt, Command, isInterrupted, INTERRUPT,
  type GraphNode, type StateSnapshot,
} from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import * as z from "zod";

const RowSchema = z.object({ id: z.string(), name: z.string(), domain: z.string() });
export type Row = z.infer<typeof RowSchema>;

export const State = new StateSchema({
  rows:       z.array(RowSchema).default(() => []),
  flaggedIds: z.array(z.string()).default(() => []),
  csv:        z.string().nullable().default(() => null),
});

const transform: GraphNode<typeof State> = (s) => ({
  rows: s.rows.map((r) => ({ ...r, name: r.name.trim() })),
});

const check: GraphNode<typeof State> = (s) => ({
  flaggedIds: s.rows.filter((r) => !r.domain.includes(".")).map((r) => r.id),
});

// The HITL node.
const review: GraphNode<typeof State> = (s) => {
  if (s.flaggedIds.length === 0) return {};           // nothing flagged -> no pause

  // I = what the browser is shown. R = what the browser sends back.
  const edited = interrupt<{ kind: "review_rows"; rows: Row[] }, Row[]>({
    kind: "review_rows",
    rows: s.rows.filter((r) => s.flaggedIds.includes(r.id)),
  });

  const byId = new Map(edited.map((r) => [r.id, r]));
  return { rows: s.rows.map((r) => byId.get(r.id) ?? r) };
};

const emit: GraphNode<typeof State> = (s) => ({
  csv: "id,name,domain\n" + s.rows.map((r) => `${r.id},${r.name},${r.domain}`).join("\n"),
});

export const checkpointer = SqliteSaver.fromConnString("./data/checkpoints.sqlite");

export const graph = new StateGraph(State)
  .addNode("transform", transform)
  .addNode("check", check)
  .addNode("review", review)
  .addNode("emit", emit)
  .addEdge(START, "transform")
  .addEdge("transform", "check")
  .addEdge("check", "review")
  .addEdge("review", "emit")
  .addEdge("emit", END)
  .compile({ checkpointer });
```

Driving it:

```ts
const config = { configurable: { thread_id: "T1" } };

// --- request 1: start ---
const res = await graph.invoke({ rows: incomingRows }, config);

if (isInterrupted<{ kind: string; rows: Row[] }>(res)) {
  const payload = res[INTERRUPT][0].value;   // { kind: "review_rows", rows: [...] }
  // hand payload + thread_id to the browser
}

// --- request 2 (a completely separate process is fine): inspect ---
const snap: StateSnapshot = await graph.getState(config);
snap.next;                       // ["review"]  -> [] when finished
snap.tasks[0].interrupts;        // [{ id: "8c34...", value: { kind: "review_rows", rows: [...] } }]
snap.values;                     // full graph state, all 50 rows

// --- request 3: resume with the human's edits ---
const final = await graph.invoke(
  new Command({ resume: editedRowsFromBrowser }),   // Row[]
  config,
);
final.csv;
```

### 2.3 What the return value actually looks like — real output

**[verified by running it]** `graph.invoke(input, config)` on an interrupting graph resolves normally (it does **not** throw). The result is the partial state plus a `__interrupt__` key:

```
result keys: [ 'rows', 'flaggedIds', 'csv', '__interrupt__' ]
__interrupt__: [
  {
    "id": "8c349191b6341c64541a7e74405cacd7",
    "value": { "kind": "review_rows", "rows": [ { "id": "2", "name": "Bad Co", "domain": "badco", "flagged": false } ] }
  }
]
```

And `getState()` from a **fresh process**:

```
next: [ 'review' ]
tasks[].interrupts: [ { "name": "review", "interrupts": [ { "id": "8c34…", "value": { "kind": "review_rows", "rows": [...] } } ] } ]
values: {"rows":[…2 rows…],"flaggedIds":["2"],"csv":null}
```

Three equivalent ways to detect "paused, needs a human":
1. `isInterrupted(result)` on the invoke result (only available to the request that ran it),
2. `snap.next.length > 0 && snap.tasks.some(t => t.interrupts.length > 0)` (works from any request),
3. `snap.next.length === 0` means done.

The docs also suggest #2 for history search: *"Find the checkpoint where an interrupt occurred: `history.find((s) => s.tasks.length > 0 && s.tasks.some((t) => t.interrupts.length > 0))`"* — <https://docs.langchain.com/oss/javascript/langgraph/checkpointers>

### 2.4 Hard requirements, verified by triggering the errors

**[verified by running it]**

| Missing thing | What actually happens |
|---|---|
| No checkpointer on `.compile()` | throws `GraphValueError: No checkpointer set` (with a link to `docs.langchain.com/oss/javascript/langgraph/MISSING_CHECKPOINTER/`) |
| No `thread_id` in config | throws: *"Failed to put checkpoint. The passed RunnableConfig is missing a required `thread_id` field in its `configurable` property…"* |

Matching the docs: *"To use `interrupt`, you need: 1. A **checkpointer** to persist the graph state … 2. A **thread ID** in your config so the runtime knows which state to resume from 3. To call `interrupt()` where you want to pause (payload must be JSON-serializable)"* — <https://docs.langchain.com/oss/javascript/langgraph/interrupts>

---

## 3. Checkpointers in JS specifically

### What exists (the doc's own list)

From <https://docs.langchain.com/oss/javascript/langgraph/checkpointers>:

- `@langchain/langgraph-checkpoint` — *"The base interface for checkpointer savers (`BaseCheckpointSaver`)… Includes in-memory checkpointer implementation (`MemorySaver`) for experimentation. LangGraph comes with `@langchain/langgraph-checkpoint` included."*
- `@langchain/langgraph-checkpoint-sqlite` — *"uses SQLite database (`SqliteSaver`). Ideal for experimentation and local workflows. Needs to be installed separately."*
- `@langchain/langgraph-checkpoint-postgres` — *"An advanced checkpointer that uses Postgres database (`PostgresSaver`), used in LangSmith. Ideal for using in production."*
- `@langchain/langgraph-checkpoint-mongodb` — `MongoDBSaver` + `MongoDBStore`.
- `@langchain/langgraph-checkpoint-redis` — `RedisSaver`.

**There is no filesystem/JSON-file checkpointer in JS.** SQLite is the lightest durable option.

### Actual API surfaces (from the published `.d.ts` files)

`MemorySaver` — exported from `@langchain/langgraph` itself (re-exported from `@langchain/langgraph-checkpoint`), so no extra install:

```ts
import { MemorySaver } from "@langchain/langgraph";
const checkpointer = new MemorySaver();
```

`SqliteSaver` (`@langchain/langgraph-checkpoint-sqlite@1.0.4`):

```ts
declare class SqliteSaver extends BaseCheckpointSaver {
  db: Database;
  constructor(db: Database, serde?: SerializerProtocol);
  static fromConnString(connStringOrLocalPath: string): SqliteSaver;
  protected setup(): void;                     // <-- protected AND synchronous
  deleteThread(threadId: string): Promise<void>;
  // getTuple / list / put / putWrites
}
```

**`SqliteSaver.setup()` is `protected` — you cannot and must not call it.** Reading `dist/index.js` shows `this.setup()` is invoked lazily at the top of `getTuple`, `list`, `put` and `putWrites`, guarded by `isSetup`. Tables are created on first use. This is a **JS-vs-Python difference**: in Python you are told to call `.setup()`; in JS SQLite it is automatic.

`PostgresSaver` (`@langchain/langgraph-checkpoint-postgres@1.0.5`):

```ts
declare class PostgresSaver extends BaseCheckpointSaver {
  constructor(pool: pg.Pool, serde?: SerializerProtocol, options?: Partial<{ schema: string }>);
  static fromConnString(connString: string, options?: Partial<{ schema: string }>): PostgresSaver;
  /** ... It MUST be called directly by the user the first time checkpointer is used. */
  setup(): Promise<void>;                      // <-- public, async, REQUIRED once
}
```

The package's own JSDoc: *"NOTE: you need to call `.setup()` the first time you're using your checkpointer"*, and *"This method creates the necessary tables in the Postgres database if they don't already exist and runs database migrations. It MUST be called directly by the user the first time checkpointer is used."*

**JS lags Python here:** the JS persistence doc page names *"`PostgresSaver` / `AsyncPostgresSaver`"*, but the published JS package exports **only `PostgresSaver`** (`export { PostgresSaver };` is the entire root export; `./store` separately exports `PostgresStore`). `AsyncPostgresSaver` is a Python-only class and that doc line is a Python leak. Do not go looking for it.

Native-dependency note: `better-sqlite3@^12.10.0` is a hard `dependency` (not a peer) of the SQLite checkpointer, and `pg@^8.12.0` of the Postgres one. `better-sqlite3` is a native module; it installed from a prebuilt binary here with no toolchain, but that is a per-platform risk worth knowing if CI runs on an unusual arch.

### Durability spectrum

| Checkpointer | Survives page reload | Survives `tsx watch` reload / server restart | Extra infra |
|---|---|---|---|
| `MemorySaver` | ✅ (same process) | ❌ | none |
| `SqliteSaver` | ✅ | ✅ | one file |
| `PostgresSaver` | ✅ | ✅ | a Postgres, plus a one-time `await setup()` |

There is also a per-run `durability` option (`"exit" | "async" | "sync"`), accepted on `invoke`/`stream` — **[verified by running it]**, `{ durability: "sync" }` works:

> `"exit"`: persists only when execution exits — successfully, with an error, **or due to a human-in-the-loop interrupt**. `"async"`: persists asynchronously while the next step executes. `"sync"`: persists synchronously before the next step starts.
> — <https://docs.langchain.com/oss/javascript/langgraph/checkpointers>

For us the default is fine: even `"exit"` persists on interrupt, which is the only pause we care about.

### RECOMMENDATION for this demo: `SqliteSaver`, one file

Reasoning:
- The requirement is "survives a browser page reload" — `MemorySaver` technically clears that bar, but `tsx`/nodemon restarts on every save during development would silently destroy every in-flight review thread. That will burn debugging time and will look bad if the reviewer restarts the server mid-demo.
- `SqliteSaver` is a single `npm i` and one line (`SqliteSaver.fromConnString("./data/checkpoints.sqlite")`). No `.setup()`, no daemon, no docker-compose, no connection string in `.env`. It is genuinely the "runs on a laptop / one small host" option.
- Postgres buys nothing here (single user, no multi-tenancy) and costs a service dependency plus a `setup()` step in bootstrap.
- Add `data/*.sqlite*` to `.gitignore`, and (optional, 3 lines) call `checkpointer.deleteThread(threadId)` after the CSV is downloaded to keep the file from growing.

Fallback if the native `better-sqlite3` build is a problem on the target host: swap the one constructor line to `new MemorySaver()`. The rest of the code is identical — that's the whole point of `BaseCheckpointSaver`.

---

## 4. Can the resume payload carry edited row data?

**Yes. This is the single most load-bearing finding in this ticket, and it is confirmed three ways.**

**1. The type says so.** `resume?: Resume` where `Resume = unknown` and the class is `Command<Resume = unknown, …>`. There is no boolean constraint anywhere in `constants.d.ts`.

**2. The docs say so.** From <https://docs.langchain.com/oss/javascript/langgraph/interrupts>:

> *"The function accepts any JSON-serializable value which is surfaced to the caller."*
> *"**Value is returned** to the caller under `__interrupt__`; it can be any JSON-serializable value (string, object, array, etc.)"*
> *"You can pass **any JSON-serializable value** as the resume value"*

and the docs' own "Review and edit state" pattern is exactly our use case:

```ts
const reviewNode: typeof State.Node = (state) => {
  const editedContent = interrupt({
    instruction: "Review and edit this content",
    content: state.generatedText,
  });
  return { generatedText: editedContent };
};
// resume:
await graph.invoke(new Command({ resume: "The edited and improved text" }), config);
```

The "Interrupts in tools" example goes further and resumes with a **structured object that overrides field values**: `new Command({ resume: { action: "approve", subject: "Updated subject" } })`.

**3. [verified by running it].** Resuming with an **array of edited row objects** across a process boundary produced exactly the expected merged state:

```
resumed: {
  "rows": [
    { "id": "1", "name": "Acme",       "domain": "acme.com" },
    { "id": "2", "name": "Bad Co Ltd", "domain": "badco.com" }   <-- came from the resume payload
  ],
  "flaggedIds": ["2"],
  "csv": "id,name,domain\n1,Acme,acme.com\n2,Bad Co Ltd,badco.com"
}
```

### The one restriction

> **"Do not return complex values in `interrupt` calls."** *"Depending on which checkpointer is used, complex values may not be serializable (e.g. you can't serialize a function)."* ✅ *"Pass dictionaries/objects with simple values."* 🔴 *"Do not pass functions, class instances, or other complex objects."*
> — <https://docs.langchain.com/oss/javascript/langgraph/interrupts>

Plain row objects (strings/numbers/booleans/null/arrays) are fine. Don't put a `Date`, a Zod schema, or a Notion SDK client in there. (For the record, the serializer — `@langchain/langgraph-checkpoint/dist/serde/jsonplus.js` — *does* round-trip `Set`, `Map`, `RegExp`, `Error` and `Uint8Array` via `lc:2` constructor records, and deliberately refuses anything else so *"old or attacker-controlled checkpoint data cannot execute"*. But the guidance stands: keep it JSON.)

**Conclusion: human edits flow back *through* the graph.** The `emit`/CSV node consumes post-edit state. We do not need a separate "apply edits outside the graph" path.

### Alternative HITL patterns, and why they lose here

**(a) `updateState` / edit-state.** `graph.updateState(config, values, asNode?)` writes a new checkpoint on the thread. The docs: *"This creates a new checkpoint with the updated values — it does not modify the original checkpoint. The update is treated the same as a node update: values are passed through reducer functions when defined."*

**[verified by running it]**, on a thread paused at an interrupt:

```
before updateState: next: ['b']  values: {"n":1,...}   tasks: [{name:'b', interrupts: 1}]
after  updateState: next: ['b']  values: {"n":42,...}  tasks: [{name:'b', interrupts: 0}]   <-- !!
```

**Gotcha nobody documents: `updateState` on an interrupted thread wipes `tasks[].interrupts` from the snapshot.** The thread is still paused (`next` is still `["review"]`) and a later `Command({ resume })` still works — but you have permanently lost the ability to re-read the interrupt payload from `getState()`. If the browser reloads after you've called `updateState`, you can no longer re-render the review UI from the snapshot. This alone disqualifies `updateState` as our primary mechanism.

It also doesn't compose: the node still resumes and still needs *some* resume value, so you'd be writing edits in two places.

**(b) "Review tool call" pattern** (`interrupt()` inside a `tool(...)`, the agent loop pauses before executing). Documented, works, and is the right shape when an LLM proposed the action. We have **no LLM and no tool calls** — the transform is deterministic. Adopting it would mean inventing an agent loop to host a tool we don't need. Reject.

**(c) Static breakpoints** (`compile({ interruptBefore: ["review"] })`). The docs are explicit: *"Static interrupts are **not** recommended for human-in-the-loop workflows. Use the `interrupt` function instead."* They also carry no payload — you'd have to read the flagged rows out of `getState().values` yourself. Reject.

**Decision for "human edits ~5 flagged rows out of 50": `interrupt()` with the flagged rows as the payload, resume with the edited rows array.** One mechanism, payload survives reload, edits flow through the graph, ~10 lines.

---

## 5. The multi-request story

### 5.1 What `thread_id` is

> *"The `thread_id` you choose is effectively your persistent cursor. Reusing it resumes the same checkpoint; using a new value starts a brand-new thread with an empty state."*
> *"The checkpointer uses `thread_id` as the primary key for storing and retrieving checkpoints. Without it, the checkpointer cannot save state or resume execution after an interrupt."*
> — <https://docs.langchain.com/oss/javascript/langgraph/interrupts>, <https://docs.langchain.com/oss/javascript/langgraph/checkpointers>

**What we persist ourselves: nothing.** The 50 rows, the flags, the trimmed names — all of it is graph state and all of it is inside the checkpoint. The browser holds one opaque string. **[verified by running it]** — a fresh `node` process (no shared memory with the one that started the run) read the full state and resumed it correctly from SQLite alone.

### 5.2 Express routes

```ts
// server.ts  (Express 5, ESM, tsx)
import express from "express";
import { randomUUID } from "node:crypto";
import { Command, isInterrupted, INTERRUPT } from "@langchain/langgraph";
import { graph, type Row } from "./graph.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const cfgFor = (threadId: string) => ({ configurable: { thread_id: threadId } });

/** Shared shape so the client has one branch. */
async function snapshot(threadId: string) {
  const s = await graph.getState(cfgFor(threadId));
  const pending = s.tasks.flatMap((t) => t.interrupts);
  return {
    threadId,
    status: s.next.length === 0 ? "done" as const
          : pending.length > 0  ? "awaiting_review" as const
          : "running" as const,
    review: pending[0]?.value ?? null,     // { kind: "review_rows", rows: Row[] }
    csv: s.values?.csv ?? null,
    next: s.next,
  };
}

// POST /run  -> start; returns thread_id + interrupt payload
app.post("/run", async (req, res, next) => {
  try {
    const threadId = randomUUID();
    const out = await graph.invoke({ rows: req.body.rows }, cfgFor(threadId));
    res.status(201).json({
      threadId,
      status: isInterrupted(out) ? "awaiting_review" : "done",
      review: isInterrupted(out) ? out[INTERRUPT][0]?.value : null,
      csv: (out as { csv?: string | null }).csv ?? null,
    });
  } catch (e) { next(e); }
});

// GET /run/:threadId  -> current state (this is what a page reload calls)
app.get("/run/:threadId", async (req, res, next) => {
  try {
    const s = await graph.getState(cfgFor(req.params.threadId));
    if (!s.createdAt) return res.status(404).json({ error: "unknown thread" });   // see gotcha #2
    res.json(await snapshot(req.params.threadId));
  } catch (e) { next(e); }
});

// POST /run/:threadId/resume  -> body carries the edited rows
const inFlight = new Set<string>();                                              // see gotcha #3
app.post("/run/:threadId/resume", async (req, res, next) => {
  const threadId = req.params.threadId;
  try {
    const before = await graph.getState(cfgFor(threadId));
    if (!before.createdAt) return res.status(404).json({ error: "unknown thread" });
    if (!before.tasks.some((t) => t.interrupts.length > 0)) {
      return res.status(409).json(await snapshot(threadId));                     // not paused -> no-op
    }
    if (inFlight.has(threadId)) return res.status(409).json({ error: "resume already in progress" });
    inFlight.add(threadId);
    try {
      const editedRows = req.body.rows as Row[];
      await graph.invoke(new Command({ resume: editedRows }), cfgFor(threadId));
      res.json(await snapshot(threadId));
    } finally { inFlight.delete(threadId); }
  } catch (e) { next(e); }
});

// GET /run/:threadId/csv -> download
app.get("/run/:threadId/csv", async (req, res, next) => {
  try {
    const s = await graph.getState(cfgFor(req.params.threadId));
    if (!s.values?.csv) return res.status(409).json({ error: "not ready" });
    res.type("text/csv").attachment(`export-${req.params.threadId}.csv`).send(s.values.csv);
  } catch (e) { next(e); }
});
```

`GET /run/:threadId` is literally the page-reload story: the browser keeps `threadId` in the URL or `localStorage`, re-fetches, and re-renders the same flagged rows out of `tasks[].interrupts[0].value`.

### 5.3 Gotchas — all four empirically confirmed

**1. The interrupted node re-runs from the top on resume.**
> *"When execution resumes …, the runtime restarts the entire node from the beginning—it does not resume from the exact line where `interrupt` was called. This means any code that ran before the `interrupt` will execute again."*
> ✅ *"Place side effects after `interrupt` calls"* / ✅ *"Separate side effects into separate nodes when possible"*
> — <https://docs.langchain.com/oss/javascript/langgraph/interrupts>

**[verified by running it]** — the log printed `[node review ran]` on the initial run **and again** on resume; `transform` and `check` did not re-run.

For us: the `review` node must contain *only* the `interrupt()` and the merge. Do not put the Notion fetch, the CSV write, or any logging/DB write in it. Our four-node split already satisfies this.

Related rules from the same page, all relevant if the review node ever grows: **do not wrap `interrupt` in a bare try/catch** (it throws a `GraphInterrupt` that the runtime must see); **do not reorder or conditionally skip `interrupt` calls within a node** (*"Matching is strictly index-based"*); **avoid `while(true)` + `interrupt()` loops** (*"each resume replays all previous iterations… exponential re-execution"* — use a conditional edge instead).

One caveat on our own code: `review` starts with `if (s.flaggedIds.length === 0) return {}` — a conditional *before* the interrupt. That is safe because `flaggedIds` is fixed by the time `review` runs and cannot change between the pause and the resume, so the interrupt-call sequence is identical on replay. If a future ticket makes flagging re-computable during the pause, that guard becomes the "conditionally skip interrupt" foot-gun.

**2. Resuming an unknown `thread_id` does NOT throw. [verified by running it]**

```
await graph.invoke(new Command({ resume: {...} }), { configurable: { thread_id: "ghost-…" } })
// -> resolves with {"n":0,"out":null}   (empty default state, no error, no nodes run)
```

A typo'd or expired thread id silently returns an empty state instead of a 404. **Guard every route with a `getState()` existence check** (`!snap.createdAt` ⇒ unknown thread) before doing anything else. This is not documented anywhere I could find.

**3. There is NO concurrency control on a thread. [verified by running it]**

Two `graph.invoke(new Command({ resume }))` calls fired concurrently at the same `thread_id` **both succeeded**, both ran the downstream node, and produced two different final states (`done:100` and `done:200`) racing to be the last write:

```
[concurrent] {"n":100,"out":"done:100"} | {"n":200,"out":"done:200"}
```

The library does not lock threads. If the browser double-submits the review form, you get two runs. **Mitigation for the demo:** the two-line `inFlight` `Set` above plus the `tasks[].interrupts.length > 0` precondition check. That gives idempotency (second submit gets a 409 and the current snapshot) without inventing a job queue. Note the check-then-act is not atomic, but within one Node process and one event-loop tick before the first `await graph.invoke`, the `Set` guard closes the realistic double-click window.

**4. Sequential double-resume is harmless. [verified by running it]** Re-POSTing the same resume to an already-completed thread did **not** error and did **not** re-run any node — it returned the final state unchanged. So the failure mode of gotcha #3 is genuinely concurrency, not repetition.

**5. Serialization.** State is serialized by the checkpointer's `SerializerProtocol` (`dumpsTyped`/`loadsTyped`). Keep every state channel JSON-ish. The Zod `StateSchema` gives us that for free as long as we don't add `z.date()` or custom classes to the row schema. Our rows are strings and booleans — fine.

**6. In-flight run vs resumed run.** In this design there is no long-running background job: `POST /run` runs the graph to the interrupt and *returns* — the HTTP request completes. Nothing is "in flight" during the review pause; the process could be restarted and the SQLite thread would still resume. That is the property that makes this architecture simple, and it is why the checkpointer choice (SQLite over Memory) matters more than any streaming decision.

---

## 6. Streaming — what's actually available

### `streamMode` values, from the type union (authoritative)

`dist/pregel/types.d.ts`:

```ts
type StreamMode = "values" | "updates" | "debug" | "messages" | "checkpoints" | "tasks" | "custom" | "tools";
```

**Docs/type mismatch to flag:** <https://docs.langchain.com/oss/javascript/langgraph/streaming> tabulates only `values | updates | messages | custom | tools | debug`. It omits `checkpoints` and `tasks`, which are in the type union and which I observed emitting real events. The event-streaming page *does* list both. Treat the type union as truth.

The ticket's guessed list (`values/updates/messages/custom/debug`) is close but **incomplete for 1.x** — `tools`, `checkpoints`, `tasks` are new.

### How interrupts surface in a stream

Straight from `dist/pregel/loop.js` (line 409):

```js
this._emit([["updates", { [INTERRUPT]: interruptWrites }], ["values", { [INTERRUPT]: interruptWrites }]]);
```

So the interrupt is emitted as a chunk on **both** `updates` and `values`. **[verified by running it]**:

```
--- streamMode "updates" ---
{"a":{"n":1}}
{"__interrupt__":[{"id":"f723e8dc…","value":{"ask":"edit","n":1}}]}
```

Multi-mode gives `[mode, chunk]` tuples, and resuming mid-stream works: **[verified by running it]**

```
--- streamMode ["updates","values"], input = new Command({resume:{n:99}}) ---
["values",{"n":1,"out":null}]
["updates",{"b":{"n":99}}]
["values",{"n":99,"out":null}]
["updates",{"c":{"out":"done:99"}}]
["values",{"n":99,"out":"done:99"}]
```

### The genuinely nice surprise: native SSE encoding

`PregelOptions` has:

```ts
/**
 * The encoding to use for the stream.
 * - `undefined`: Use the default format.
 * - `"text/event-stream"`: Use the Server-Sent Events format.
 */
encoding?: TEncoding;
```

and the overload returns `Promise<IterableReadableStream<Uint8Array>>`. **[verified by running it]** — the raw bytes are already wire-format SSE:

```
event: updates
data: {"a":{"n":1}}

event: updates
data: {"__interrupt__":[{"id":"9de70189…","value":{"ask":"edit","n":1}}]}

```

Which makes the Express SSE route about eight lines:

```ts
app.post("/run/stream", async (req, res) => {
  const threadId = randomUUID();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Thread-Id": threadId,
  });
  const stream = await graph.stream({ rows: req.body.rows }, {
    configurable: { thread_id: threadId },
    streamMode: ["updates"],
    encoding: "text/event-stream",
  });
  for await (const bytes of stream) res.write(bytes);
  res.end();
});
```

(Behind nginx you also need `X-Accel-Buffering: no`. And the browser must read `X-Thread-Id` off the response — `EventSource` can't do that, so this route needs `fetch` + a stream reader, not `new EventSource()`.)

### `streamEvents(..., { version: "v3" })`

The new typed-projection API. `graph.streamEvents(input, { version: "v3" })` returns a `GraphRunStream` with, per the `.d.ts`:

```ts
get values(): AsyncIterable<TValues> & PromiseLike<TValues>;
get messages(): AsyncIterable<ChatModelStreamHandle>;
get subgraphs(): AsyncIterable<SubgraphRunStream>;
get lifecycle(): AsyncIterable<LifecycleEntry>;
get output(): Promise<TValues>;
get interrupted(): boolean;
get interrupts(): readonly InterruptPayload[];   // { interruptId: string; payload: unknown }
abort(reason?): void;  get signal(): AbortSignal;
```

**[verified by running it]** on our three-node toy:

```
lifecycle   {"event":"running","graph_name":"root"}
checkpoints {"id":"1f1a335f-…","step":0,"source":"loop"}
values      {"n":0,"out":null}
tasks       {"name":"a","input":{...},"triggers":["branch:to:a"],"interrupts":[]}
updates     {"node":"a","values":{"n":1}}
tasks       {"name":"a","result":{"n":1},"interrupts":[]}
checkpoints {"id":"1f1a335f-…","step":1,"source":"loop"}
values      {"n":1,"out":null}
tasks       {"name":"b","input":{...},"triggers":["branch:to:b"],"interrupts":[]}
updates     {"node":"__interrupt__","values":[{"id":"c49214…","value":{"ask":"edit","n":1}}]}
values      {"__interrupt__":[{"id":"c49214…","value":{"ask":"edit","n":1}}]}
tasks       {"name":"b","result":{},"interrupts":[{"id":"c49214…","value":{"ask":"edit","n":1}}]}
lifecycle   {"event":"completed","graph_name":"root"}
interrupted: true  interrupts: [{"interruptId":"c49214…","payload":{"ask":"edit","n":1}}]
```

**Doc ambiguity to flag:** the event-streaming page lists `interrupted` as one of the `lifecycle` `event` values, but on an actually-interrupted run the terminal lifecycle event I observed was `completed`, with the interrupt signalled only via `stream.interrupted` / the `updates` channel. Don't build UI logic on `lifecycle: "interrupted"`; use `stream.interrupted` or watch for `__interrupt__` on `updates`.

The docs' documented HITL streaming loop (<https://docs.langchain.com/oss/javascript/langgraph/interrupts>) is:

```ts
let streamInput: Record<string, unknown> | Command = initialInput;
while (true) {
  const stream = await graph.streamEvents(streamInput, { ...config, version: "v3" });
  for await (const message of stream.messages) {
    for await (const token of message.text) displayStreamingContent(token);
  }
  if (!stream.interrupted) { const finalState = await stream.output; break; }
  const interruptInfo = stream.interrupts[0].payload;
  streamInput = new Command({ resume: await getUserInput(interruptInfo) });
}
```

Note this loop assumes one process holds the whole conversation. **It does not survive our multi-request boundary** — each HTTP request would run one iteration of it. Don't copy it verbatim.

### RECOMMENDATION: don't wire streaming. (Mostly.)

**No, it is not worth it for a three-node graph in a time-boxed take-home.**

- `stream.messages` — the headline feature — is **worthless to us**: we have no LLM. Token streaming is the entire reason this API exists.
- The pipeline is: fetch ~50 rows → deterministic transform → deterministic checks. Sub-second. There is no progress to watch. A spinner is honest and costs nothing.
- SSE adds real surface area on both sides: a `fetch`-based reader (not `EventSource`, because you need the thread id off a header), reconnect semantics, an abort path, and a second code path that must *also* handle the interrupt — while `POST /run` returning `{ threadId, review }` in one JSON response handles it in one.
- It doesn't help the requirement that actually matters. Page-reload survival is delivered by the checkpointer + `GET /run/:threadId`, not by streaming.

**The exception, if there is spare time at the end:** the Notion extract is the one genuinely slow step (network, pagination). If it needs a progress indicator, the *cheap* version is `streamMode: ["updates"]` + `encoding: "text/event-stream"` on `POST /run/stream` — the eight lines above, no client library, no new dependency, and the `__interrupt__` chunk arrives on the same channel so the client's terminal branch is unchanged. Do that only after the core loop works end to end. Do **not** reach for `streamEvents` v3 / transformers / `StreamChannel`; that machinery is for agent UIs.

---

## 7. What this forces on our architecture

### Constraints (non-negotiable, from the findings above)

1. **A checkpointer must be compiled into the graph, and every call needs `configurable.thread_id`.** Both are hard errors otherwise. There is exactly one `graph` module-level singleton and one `cfgFor(threadId)` helper; nothing else in the codebase constructs a config.
2. **`thread_id` is the API's primary key and the browser's only handle.** It goes in the `POST /run` response, into the URL, and into every subsequent request path. Generate it ourselves (`randomUUID()`) — do not let the graph pick.
3. **The review node must be side-effect-free.** It re-runs on resume. Notion I/O, CSV generation, and any logging live in other nodes. This forces the four-node split (`transform → check → review → emit`) rather than folding review into the check node.
4. **All graph state must stay JSON-serializable.** No `Date`, no class instances, no SDK objects in a state channel or an interrupt payload. Rows are plain strings/booleans.
5. **No LangGraph Platform, CLI, `langgraph.json`, or SDK.** Three runtime packages: `@langchain/langgraph`, `@langchain/core`, `@langchain/langgraph-checkpoint-sqlite` (+ `zod`, a required peer).
6. **Every thread-addressed route must existence-check via `getState()` first.** An unknown `thread_id` silently returns empty state rather than erroring.
7. **We own resume idempotency.** The library provides none. Precondition-check `tasks[].interrupts.length > 0` and hold an in-process `inFlight` guard.
8. **Do not call `updateState` on an interrupted thread** — it erases `tasks[].interrupts` and breaks page-reload recovery. Edits go through `Command({ resume })` only.

### What this buys us

- Zero bespoke persistence. No "runs" table, no row cache, no session store. The checkpoint *is* the durable record of the run, and `getState()` *is* the read model.
- Page-reload recovery is one route (`GET /run/:threadId`) reading one snapshot, with no extra state machine.
- Human edits reach the CSV through normal graph state, so the emit node has a single input path whether or not a human intervened.

### Left open for downstream tickets

- **Thread lifecycle.** Nothing deletes threads. `SqliteSaver.deleteThread(threadId)` exists. Decide: delete after CSV download, TTL sweep, or just let the demo file grow.
- **Where the browser keeps `threadId`** (URL path segment vs `localStorage`) and whether the review URL should be shareable/bookmarkable.
- **Resume payload contract.** Whole edited rows (as prototyped) vs a sparse patch (`{ id, field, value }[]`). Whole rows are simpler; sparse patches are smaller and easier to validate. Either is a valid `resume` value.
- **Server-side validation of edits.** The resume value is trusted input straight from the browser. Either re-validate with the row Zod schema inside the review node, or adopt the docs' "Validating human input" pattern (interrupt once per node invocation, store the error in state, loop back via `addConditionalEdges` — **never** a `while` loop inside the node).
- **Rejection / cancel path.** Currently only "edit and continue" is modelled. If the UI needs "discard these rows" or "abort the run", that is a shape on the resume payload (e.g. `{ action: "cancel" }`) plus a `Command({ goto })` branch out of the review node.
- **Whether to add the SSE progress route** for the Notion extract (§6) — explicitly deferred, not rejected.
- **Deployment target.** SQLite assumes a writable local disk and a single process. If this ever lands on a platform with an ephemeral filesystem or more than one instance, swap the one constructor line for `PostgresSaver.fromConnString(...)` **and remember to `await checkpointer.setup()` once at boot.**

---

## 8. Where the docs are ambiguous, wrong, or JS lags Python

| Issue | Detail |
|---|---|
| `AsyncPostgresSaver` in the JS docs | The JS persistence page names *"`PostgresSaver` / `AsyncPostgresSaver`"*, but `@langchain/langgraph-checkpoint-postgres@1.0.5` exports **only** `PostgresSaver`. Python-only class leaked into a JS page. |
| `SqliteSaver.setup()` | `protected` and **synchronous** in JS, called lazily and automatically. Python tells you to call `.setup()`. Do not transcribe the Python instruction. |
| `PostgresSaver.setup()` | Public, async, and genuinely **required once**. The requirement appears only in the package's JSDoc, not on the JS checkpointers doc page. |
| `streamMode` list | The streaming doc page omits `checkpoints` and `tasks`, which exist in the `StreamMode` type union and emit real events. |
| Checkpointers page has no install commands or code | It lists package names and nothing else. Versions and constructor signatures in §1/§3 came from the registry and the tarballs. |
| `lifecycle: "interrupted"` | Documented as a lifecycle event value; the observed terminal event on an interrupted run was `completed`. Use `stream.interrupted`. |
| Unknown-thread resume | Silently returns empty state instead of erroring. Undocumented; found by testing. |
| Concurrent resumes | No locking, no idempotency, last-write-wins. Undocumented; found by testing. |
| `updateState` clears `tasks[].interrupts` | Undocumented; found by testing. |
| `Annotation` vs `StateSchema` | Both are exported from 1.4.13. Every current doc example uses `new StateSchema({...})` + Zod + `typeof State.Type` / `GraphNode<typeof State>`. `Annotation.Root` is legacy — most pre-1.x blog posts and LLM recall use it. |
| `Interrupt` shape | Now `{ id?: string; value?: unknown }`. The older `resumable` / `when` / `ns` fields are gone. |

---

## Sources

Primary docs:
- <https://docs.langchain.com/oss/javascript/langgraph/interrupts>
- <https://docs.langchain.com/oss/javascript/langgraph/checkpointers>
- <https://docs.langchain.com/oss/javascript/langgraph/persistence>
- <https://docs.langchain.com/oss/javascript/langgraph/streaming>
- <https://docs.langchain.com/oss/javascript/langgraph/event-streaming>

Source / registry:
- <https://github.com/langchain-ai/langgraphjs> — `libs/langgraph-core`, `libs/checkpoint-sqlite`, `libs/checkpoint-postgres`
- <https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/README.md>
- Published tarballs inspected directly: `@langchain/langgraph@1.4.13` (`dist/index.d.ts`, `dist/interrupt.d.ts`, `dist/constants.d.ts`, `dist/pregel/types.d.ts`, `dist/pregel/index.d.ts`, `dist/pregel/loop.js`, `dist/stream/run-stream.d.ts`, `dist/stream/types.d.ts`), `@langchain/langgraph-checkpoint@1.1.5`, `@langchain/langgraph-checkpoint-sqlite@1.0.4`, `@langchain/langgraph-checkpoint-postgres@1.0.5`
- npm registry via `npm view <pkg> version` for every version number in §1
