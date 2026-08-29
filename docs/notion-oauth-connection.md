# The Notion OAuth connection

The demo signs the user in with Notion rather than carrying a static token, so the pipeline needs a registered **public connection**. This document records the one that exists, and the facts the docs could not tell us.

Resolves [#14](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/14). Background reading: [`docs/research/notion-oauth.md`](research/notion-oauth.md).

## The connection

| | |
| --- | --- |
| Name | `notion2attio` |
| Portal | [app.notion.com/developers/connections/3cbd872b-…](https://app.notion.com/developers/connections/3cbd872b-594c-818c-b867-0037be86b73c) |
| Auth type | **OAuth** (the portal's word for what the docs call a *public connection*) |
| Installable in | **Public** — any workspace |
| Development workspace | Qiuyi's Notion |
| Redirect URI | `http://localhost:3000/auth/notion/callback` |
| Client ID | `3cbd872b-594c-818c-b867-0037be86b73c` |
| Client secret | `.env` only, as `NOTION_OAUTH_CLIENT_SECRET`. Never committed. |
| Marketplace listing | Unpublished, and staying that way |

`NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_REDIRECT_URI` and `NOTION_OAUTH_CLIENT_SECRET` live in `.env`; the first two are mirrored into `.env.example`, the secret is left blank there.

## `http://localhost` is accepted — verified, not assumed

This was the question the ticket existed to answer, and the docs genuinely do not say. **It works.** No HTTPS tunnel, no ngrok.

Proved end to end, not just at the form: the authorize URL was hit by hand with `redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fnotion%2Fcallback`, consent was granted, Notion redirected to `http://localhost:3000/auth/notion/callback?code=…&state=…`, and `POST /v1/oauth/token` returned **200**.

Worth knowing anyway:

- **The portal's own help text contradicts itself.** Under the Redirect URIs field it says users "will be redirected to one of these **HTTPS** URLs" — and then accepts an `http://localhost` URI without complaint, at the form, at `/v1/oauth/authorize`, and at the token exchange. Trust the behaviour, but do not be surprised if Notion tightens this.
- The same help text does state real constraints: redirect URLs "can't include URL fragments, relative paths, wildcards or public IP addresses". `localhost` is not a public IP, which is presumably why it survives.
- **The consent screen shows the redirect host to the user**: *"Make sure you trust notion2attio (localhost:3000)"*. Fine for a demo driven by us; it would look wrong to a stranger, which is one more reason the reviewer-connects-their-own-Notion path stays unsupported ([#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7)).

## What the portal actually asked for

Less than the docs describe, and in a different order. The **New connection** dialog asks for exactly four things:

1. Connection name
2. Authentication method — **Access token** (workspace-scoped static token, 1 workspace, not Marketplace-eligible) or **OAuth** (user-scoped, multi-workspace, Marketplace-eligible). This is the current framing of "internal vs public"; the words *internal* and *public* do not appear.
3. **Installable in** — `Any workspace`, or one/more named workspaces. This is the docs' permanent "installation scope".
4. **Redirect URIs** — a chip input; type the URI and press <kbd>Enter</kbd> or it is silently discarded when focus leaves.

Nothing else. **No company name, website, support email, privacy-policy URL, terms-of-use URL or icon** — the research note flagged these as unverified, and the answer is that none of them are asked for at creation time. They belong to the optional Marketplace listing.

Creating the connection agrees to Notion's [Developer Terms](https://notion.notion.site/Developer-Terms-ba4131408d0844e08330da2cbb225c20) — the dialog says so above the button.

**No review gate.** The connection was usable immediately. The Authorisation URL is populated on the Configuration tab the moment the connection exists, which settles the stale "populates after submitted for review" screenshot caption the research note flagged. Marketplace listing is a separate, optional "Publish to Marketplace" action.

## Capabilities are set *after* creation — and default to the maximum

The creation dialog has no capabilities step. They appear on the **Configuration** tab once the connection exists, and Notion pre-ticks the most permissive content set:

| | Notion's default | Ours |
| --- | --- | --- |
| Read content | ✅ | ✅ |
| Update content | ✅ | ✅ |
| **Insert content** | ✅ | ❌ **unticked** |
| Read comments | ☐ | ☐ |
| Insert comments | ☐ | ☐ |
| User information | *including email addresses* | **without email addresses** |

Read + update is exactly what [#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7) needs: read the batch out, write `CRM status = Imported` back. We never create pages, so **Insert content** is wrong for us and was turned off. User info was stepped down from Notion's default because the token response's `owner.user.name` is all the UI needs to say who is connected — asking for workspace emails we never read would be asking for the reviewer's trust and spending it on nothing.

Changes save on click ("Connection updated"), there is no Save button, and they survive a reload. Note the docs' warning still applies: **changing capabilities forces every already-authorized user to re-authorize** — cheap now, when the only authorization is ours.

The consent screen renders these as plain English: *View pages you select · Edit pages you select · View workspace users*. With Insert content off, no "create pages" line appears.

## What the live token response actually looked like

From the by-hand round trip, against `Notion-Version: 2026-03-11`:

- Keys returned: `access_token`, `token_type`, `refresh_token`, `bot_id`, `workspace_name`, `workspace_icon`, `workspace_id`, `owner`, `duplicated_template_id`, `request_id`.
- **No `expires_in`, and no expiry field of any kind.** The research note inferred this from an absence in the docs; it is now observed. Build no timed refresh loop.
- `refresh_token` is **present and non-null** — the schema's `string | null` did not bite. Post-2026-06-08 behaviour, as expected for a connection created today.
- `access_token` is an **`ntn_`-prefixed opaque string**, not the UUID the older docs examples show.
- `owner.type = "user"`, `owner.user.type = "person"`, `owner.user.name = "Qiuyi Hong"`, and **`owner.user.person = {}`** — empty, because we asked for user info *without* email addresses. That is the capability gate working, and it means `person.email` is not available to the app.
- `duplicated_template_id` is `null`; we configured no template.

Both capabilities were then exercised with the issued token:

- `POST /v1/data_sources/{id}/query` with the real W34 filter → **200, 8 rows**, matching [#5](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/5).
- `PATCH /v1/pages/{id}` setting `CRM status` → **200**, then restored to `Ready for CRM`. The write-back leg is not a hope.

## The page grant

Consent is a page picker, and **at least one page must be selected** — "Select at least one page to continue". The empty grant the research note warned about is enforced at the picker, but a user can still deselect everything the app cares about, so "no databases" remains a state the UI must handle.

We granted the **parent page**, `notion2attio — source data`, not the `Qualified accounts` database directly. Children are inherited, so re-running `npm run notion:setup` — which creates a *new* database under that same parent — stays covered by the existing grant instead of needing a fresh consent round.

## Still open

- Where the issued `access_token` / `refresh_token` are persisted between requests is [#15](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/15). Deliberately not decided here; the round-trip token was destroyed after verification, so the next run re-authorizes.
- The redirect path `/auth/notion/callback` is a guess at this stage, chosen to match Notion's own docs example and to land on the backend (the token exchange needs the client secret, so it cannot be the Vite dev server). If [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16) settles on a different shape, the URI is editable in the portal — unlike the installation scope.
