# Handoff notes — batch 2026-W34

Not an import file. Attio never sees this. It is here because Attio cannot
import notes by CSV ([#2](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/2)),
so the `Research notes` prose has nowhere to travel
([#9](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/9)) — and because the
repair log and the flag record otherwise live only on the review screen and
vanish with the tab.

Generated 2026-08-29. Run `2026-W34` · 8 source rows · 7 companies · 7 people
· 6 deals · 2 held.

---

## 1. What was handed off

| file               | destination object | rows |
| ------------------ | ------------------ | ---- |
| `1-companies.csv`  | Companies          | 1    |
| `2-people.csv`     | People             | 7    |
| `3-deals.csv`      | Deals              | 6    |

Import in that order. People must land before Deals. The lone Company carries no
person row and no deal row, so it can land at any point; it goes first to keep
the numbering honest.

**Held, not handed off:**

- **Tern Mobility — Amina Yusuf** (`QL-260819-003`). No work email, so the Person
  candidate is Held.
- **Tern Mobility — deal**. Held by a Stop raised by the sibling above: a Deal
  candidate is emitted only when every candidate in its account is Clear or
  answered ([#29](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/29)).
  Shipping it with an empty participants cell would have created a deal attached
  to nobody, permanently and with no undo.

The *company* was still sent, via `1-companies.csv` — Attio matches Companies on
`Domains`, so it is safe now and a no-op when the row returns. The source row
stays at `Ready for CRM` and comes back when batch `2026-W34` is re-run.

---

## 2. Research notes to paste by hand

Attio takes these only through the UI. Open each person (or the company, where
the person was held) and paste.

**Northbeam Analytics — Priya Nair**
> Priya is replacing a spreadsheet-based forecast. Asked whether implementation
> can start before the October planning cycle.

**Oriel Foods — Helena Costa**
> Referred by Vale Partners. UK team owns the evaluation, but procurement is
> based in Dublin. Wants a discovery call next week.

**Tern Mobility — Amina Yusuf** *(held — paste onto the company)*
> Met at Mobility Summit. Amina asked for the fleet partnerships deck. No work
> email was captured; LinkedIn is verified.

**Brightyard — Lewis Grant**
> Lewis owns CRM hygiene and reporting. Their current process combines Pipedrive
> exports with a weekly agency spreadsheet.

**Brightyard — Marta Silva**
> Marta controls budget and joined the same evaluation as Lewis. Treat this as a
> second contact at the existing account, not a second opportunity.

**Heliograph Systems — Emily Stone**
> Emily attended the RevOps teardown webinar and requested the migration
> checklist. She previously spoke to the team under another email address.

**Alder & Finch — Soren Dahl**
> Warm referral from Dani at North & Coast. Interested in replacing manual lead
> routing before hiring two additional SDRs.

**Lattice Forge — Noor Hassan**
> Noor replied from a newer email alias. Their LinkedIn profile and role match a
> person already researched in the spring campaign.

---

## 3. Repair log

Every silent repair the run made. Silent means the reviewer did not have to
approve it — not that it was hidden.

| source row      | field     | from                                  | to                       |
| --------------- | --------- | ------------------------------------- | ------------------------ |
| `QL-260818-001` | Website   | `https://www.northbeam.example.com/`  | `northbeam.example.com`  |
| `QL-260818-002` | Website   | `https://oriel.example.com/uk`        | `oriel.example.com`      |
| `QL-260819-003` | Website   | `https://tern.example.com`            | `tern.example.com`       |
| `QL-260819-004` | Website   | `https://brightyard.example.com`      | `brightyard.example.com` |
| `QL-260819-005` | Website   | `https://www.brightyard.example.com/` | `brightyard.example.com` |
| `QL-260820-006` | Website   | `heliograph.example.com`              | `heliograph.example.com` |
| `QL-260820-007` | Website   | `www.alderfinch.example.com`          | `alderfinch.example.com` |
| `QL-260820-008` | Website   | `https://lattice.example.com/`        | `lattice.example.com`    |

The two Brightyard rows repair to the **same** domain. That is what collapses
them into one company candidate, and it is why the domain repair is load-bearing
rather than cosmetic — Attio matches companies on `Domains`, so an unrepaired
`www.` prefix would have created a second Brightyard.

`QL-260820-006` is listed for completeness; the value was already correct.

---

## 4. Flags and how they were answered

**Stop — 2**

- **Tern Mobility — Amina Yusuf**: no work email. Person candidate held. Not
  overridable; a person record with no email cannot be matched on re-import.
- **Tern Mobility — deal**: raised by the sibling above, not by the Deal
  candidate's own values. Cleared by completing the account, and by nothing else.

**Decision warn — 1**

- **Brightyard**: two source rows, one company, two contacts. Proven duplicate
  on the repaired domain `brightyard.example.com`. Answered: one deal, both
  contacts attached. The two rows disagree on `Lead source`
  (`Outbound research` / `Agency partner list`), which is why `Lead source` is
  written on the **person**, not the company.

**Notice warn — 2** *(recorded as read; nothing changed)*

- **Heliograph Systems**: the notes say Emily *"previously spoke to the team
  under another email address."* The pipeline never reads Attio, so this is a
  suspicion it can only relay. If a person record already exists under the old
  address, this import creates a second one.
- **Lattice Forge**: the notes say Noor *"replied from a newer email alias"* and
  that the LinkedIn profile matches someone researched in the spring campaign.
  Same limitation, same consequence.

**Batch flag — 1**

- **Deal owner and deal stage**: 6 deals → owner `Maya`, stage `Lead`. Owner read
  per deal from Notion's `Owner` column; stage configured for the batch. The
  count is a derived value — it read `6` at export because the Tern Mobility deal
  was Held, and would have read `7` had the reviewer supplied Amina's work email
  first. The answer covers the batch, not the six deals it happened to name
  ([#40](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/40)).
  ⚠️ `Lead` is taken from Attio's published template, not from a live workspace.
  Confirm the real stage labels before the first real import.

**Data-quality notice, not a flag**

- `Employees` mixes an en dash (`51–200`, `11–50`) with a hyphen (`51-200`,
  `11-50`) at source, and Notion holds them as distinct select options. Nothing
  downstream depends on it — `Employee range` is not emitted — but the Notion
  database is worth tidying.

---

## 5. After importing

Return to the app and confirm the batch landed. Only then does the run set
`CRM status` = `Imported` in Notion, and only on the 7 source rows whose every
candidate landed — `Imported` means finished, not partly finished. Tern
Mobility's row keeps `Ready for CRM`.
