# Attio importer probes

Everything else in this directory is **generated** — do not hand-edit it, and do
not trust a copy that was not produced against a live workspace.

- `attio-schema.json` — every object, attribute and select-option label in the
  workspace, written by `npm run attio:schema`. Attio publishes none of this;
  the standard Companies `Employee range` option list in particular exists
  nowhere in the docs (issue #2, silence 7).
- `probe-*.csv` — written by `npm run attio:probes`, using the option labels
  from `attio-schema.json`. They differ only in bytes:

  | file                             | encoding           | line endings | delimiter | asks                                           |
  | -------------------------------- | ------------------ | ------------ | --------- | ---------------------------------------------- |
  | `probe-a-utf8-lf-comma.csv`      | UTF-8, no BOM      | LF           | `,`       | does what we intend to emit survive?           |
  | `probe-b-utf8bom-crlf-comma.csv` | UTF-8 **with BOM** | CRLF         | `,`       | does an Excel-shaped file break the header?    |
  | `probe-c-utf8-lf-semicolon.csv`  | UTF-8, no BOM      | LF           | `;`       | is a semicolon file understood, or one column? |

Generating them by script rather than by hand is deliberate: a BOM, a CRLF and
an en dash are all invisible in an editor and all easy to destroy by opening the
file and saving it.

Each file carries four rows that probe select matching — the exact label, its
dash-swapped twin, a whitespace-padded copy, and a value that matches nothing —
plus a name containing `é`, an en dash and an emoji. Probe A adds a fifth row on
a real domain so Attio's enrichment has an opinion to overwrite us with.

Regenerate: `npm run attio:schema && npm run attio:probes`.
Read the result back: `npm run attio:readback`.
