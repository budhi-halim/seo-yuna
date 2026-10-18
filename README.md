# Seo Yuna Studio

A single-page prompt collection with keyboard navigation and JSON imports through GitHub Actions. Everyone can browse and copy prompts. Imports use **GitHub sign-in** and are restricted to the **`budhi-halim`** account.

- **Public reader:** [budhi-halim.github.io/seo-yuna](https://budhi-halim.github.io/seo-yuna/)
- **Owner studio:** [seo-yuna-owner.halimbudhiarto.chatgpt.site/studio](https://seo-yuna-owner.halimbudhiarto.chatgpt.site/studio)

The owner studio serves the same interface with a managed backend for GitHub authorization and imports. Its hosting address does not select the sign-in provider: account verification happens through GitHub. This release supplies the owner service and its deployed address; **the owner's one-time GitHub App registration and installation are still required**. Deploying the source does not register an app or grant repository access. Until setup is complete, importing stays disabled and the owner studio offers **Connect GitHub once**.

This repository starts with the **22 themes and 156 prompts** from `budhi-halim/sakura-yuki` at commit `7131198691f24a1dbd47293993f5bf161c9c60f0`. Their text, IDs, and ordering are preserved. The original repository is independent and is never a write target of this app or its workflow.

## One-time GitHub connection

1. Open the [owner studio](https://seo-yuna-owner.halimbudhiarto.chatgpt.site/studio), choose **Owner access**, then **Connect GitHub once**.
2. Choose **Continue on GitHub** and use the **`budhi-halim`** account. GitHub presents a private GitHub App registration prepared from this site's manifest. Review its requested repository permissions: **Contents: read and write** and **Actions: read and write**.
3. Create the private app. On GitHub's installation screen, choose **Only select repositories** and select **`seo-yuna`**. Complete the installation and return to the owner studio.
4. Choose **Sign in with GitHub** and authorize the same owner account. The header displays **budhi-halim** after the session is verified. **Submit to GitHub** becomes available after a valid batch is prepared.

If registration succeeded but installation was interrupted, **Finish GitHub setup** resumes that connection. Complete installation before signing in. You do not need to register a new app on each browser or visit. On later visits, open the owner studio and sign in with GitHub if the existing session has expired.

If a registration attempt failed before its connection could be saved, return to the owner studio and start a fresh setup. Each new attempt proposes a distinct app name so an unfinished earlier registration does not block it. A saved connection is always resumed; starting setup never replaces its credentials.

The studio has no credential-entry form. GitHub handles account sign-in, and the server exchanges the authorization code and keeps the resulting GitHub credentials encrypted. An HTTP-only session cookie connects the browser to that verified account. The backend checks both the fixed GitHub user ID and the owner login before accepting writes; client-side edits cannot grant repository access.

### Repository publication

The public repository is **`budhi-halim/seo-yuna`**, with **`master`** as its default branch. Keep the owner's existing Pages setting, **Deploy from a branch → master → / (root)**. The custom `Seo Yuna Studio` publisher has been verified with this configuration; switching Pages to a different source is not a setup requirement.

A push to `master` runs the publisher. To publish again without importing, open **Actions → Seo Yuna Studio → Run workflow**, select `master`, leave all three inputs empty, and run it. Imports merge and publish in this same workflow.

The workflow uses GitHub's built-in `GITHUB_TOKEN` for its catalog commit and Pages deployment. GitHub App registration credentials belong only to the managed owner service, so they are not repository secrets or public files. Keep the `github-pages` environment free of required reviewers if imports should publish without a manual approval step. Repository rules must permit the workflow's intended update to `data.json`.

## Using the studio

The **Prompts**, **Add JSON**, and **Activity** tabs are views in one HTML page. The outer page fits the viewport; long prompts, the JSON editor, and activity use internal scrolling. Native dropdowns, navigation buttons, and copy buttons remain available on touch screens.

### Find a theme or variation

Each selector has a search field for its displayed number, name, or both. Name searches ignore case. A leading number matches the exact displayed position: `2` finds item 2, while `12 glacial`, `12. glacial cave`, and the full copied title find theme 12. Variation numbers refer to the current theme, and filtered results keep their original numbering.

Searching does not change the displayed prompt or copy target. Choose a matching result from the selector to switch. If the current selection does not match the query, it stays in a labeled current-selection group. The match count makes this distinction visible. Clear the field to restore all options; changing themes clears the previous theme's variation search. Enter or Arrow Down moves from the search field to its selector, and Escape clears the query. A/D and W/S continue to navigate their full lists outside text inputs.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| **A** / **D** | Previous / next theme, wrapping at both ends |
| **W** / **S** | Previous / next variation in the current theme, wrapping at both ends |
| **Q** | Copy the theme title with its number, such as `1. Theme name` |
| **Q, Q** within 350 ms | Copy only the theme name |
| **E** | Copy the complete prompt |

The first Q writes to the clipboard immediately. A quick second Q replaces it with the unnumbered name. Holding a key does not count as a double press. Shortcuts are active only in Prompts, outside inputs, dropdowns, editable fields, and dialogs. Normal typing and browser shortcuts with Ctrl, Command, or Alt remain available. The variation name has a copy button and no hotkey.

### Append a JSON batch

1. Open the **owner studio**, sign in with GitHub, then open **Add JSON**. Sign in before selecting files or entering a draft, because sign-in navigates through GitHub.
2. Choose **Paste JSON** for one valid JSON array, or **Upload files** to select or drop multiple JSON files. The app sorts files by filename using natural numeric order: `data_1.json`, `data_2.json`, then `data_10.json`. Review the visible ordered list before submitting.
3. Click **Validate JSON**. Review new themes, new prompts, extended themes, and duplicate entries.
4. Click **Submit to GitHub**. The owner service verifies your account and rechecks the batch against the current repository catalog.
5. Keep the page open until **Accepted by GitHub** appears. After acceptance, processing continues on GitHub when the page closes.
6. Check **Activity** or the linked GitHub run for the final result.

The public reader also supports local JSON validation. Its **Owner access → Open owner studio** action opens the owner studio in a new tab and leaves the original draft intact. Files and pasted JSON are not transferred between the two origins: select the files again or copy the draft once into the owner studio. Bookmark the owner studio for everyday imports.

There is one tracked JSON file: **`data.json`**. Uploaded batches are staged as Git blobs without a filename, tree entry, or commit. The workflow validates them and updates only `data.json`; it does not commit an incoming-file folder. Staging objects in a public repository is not private storage, and GitHub does not provide an app-controlled expiry or deletion guarantee for those objects. Upload only data intended for this public collection.

### Accepted format

Submit a JSON array of theme objects, using the established schema:

```json
[
  {
    "id": "example-theme",
    "name": "Example theme",
    "variations": [
      {
        "id": "example-theme-variation-1",
        "name": "Example variation",
        "prompt": "Your complete prompt text."
      }
    ]
  }
]
```

Paste the JSON itself, without Markdown code fences. Each theme has exactly `id`, `name`, and `variations`; each variation has exactly `id`, `name`, and `prompt`. IDs use lowercase letters, digits, and hyphens, up to 160 characters. Names must be nonempty and at most 240 characters. Prompts must be nonempty and at most 40,000 characters. Variation IDs are unique across the entire collection.

Each import is limited to **5 MiB of UTF-8 JSON in total**. For multiple files, both their combined original byte size and the serialized combined payload must fit this limit. Each file is parsed separately, must contain at least one theme with a variation, and must have a unique filename. Files with the same natural numeric sort value use the original filename as a deterministic tie-break. JSON files must use valid UTF-8; damaged encodings are rejected instead of silently changing prompt characters. All files are combined into one batch and submitted together, so a conflict in the last file prevents the whole import. The complete stored catalog is limited to **16 MiB**. These are application limits. Older themes with four variations remain valid; the importer does not impose a fixed variation count. The app requires at least one variation in a submitted batch.

The creative directions are in [rulebook.txt](rulebook.txt). Validation checks data structure and conflicts; it does not judge prompt quality or automatically rewrite prompts.

### Append and conflict rules

| Incoming entry | Result |
| --- | --- |
| New theme ID with new variation IDs | Append the theme to the end |
| Existing theme ID and identical theme name, with new variation IDs | Append variations to that theme |
| Existing variation ID with identical name and prompt in the same theme | Skip the duplicate |
| Existing theme ID with a different name | Reject the whole batch |
| Existing variation ID with different content or under another theme | Reject the whole batch |
| Duplicate IDs inside one file, invalid fields, or malformed JSON | Reject the whole batch |

Exact duplicates across selected files are skipped as the files are combined; new variations within an existing theme append in file order. Their skipped count is included in the preview. Nothing is silently overwritten or deleted. The complete batch is checked before any write. Existing order stays stable, so previously numbered themes keep their numbers. Retrying an identical successful batch produces no duplicate prompts and can republish the site if an earlier deployment failed.

## Submission states and closing the page

| State | Meaning | Can the page close? |
| --- | --- | --- |
| Checking / uploading / submitting | GitHub has not yet confirmed workflow acceptance | Keep it open |
| Acceptance unknown | The request may have arrived, but its response was lost | Check Activity before retrying |
| Not submitted | GitHub rejected the request, or upload/validation failed | No background import is confirmed; keep the JSON if you want to retry |
| Accepted / queued | GitHub has accepted responsibility for the run | Yes |
| Validating & merging | The workflow is processing the batch | Yes |
| Saved · publishing | `data.json` has been processed; deployment is in progress | Yes |
| Published | The workflow and website deployment succeeded | Yes |
| Saved · publication incomplete | The merge succeeded but deployment did not finish | Yes; use the run details and Retry publication |
| Import did not complete | The workflow failed, timed out, or was cancelled | Yes; inspect the run before retrying |

**Accepted is not a guarantee that a batch will pass validation.** The server checks the latest catalog again before writing. A conflict introduced by another batch can therefore be reported by the workflow even after a local preview was valid.

Activity stores only nonsecret receipts in this browser: request IDs, checksums, Git blob SHAs, run IDs, timestamps, counts, and status. Browser storage contains neither GitHub credentials nor the JSON payload. The public reader and owner studio have separate local histories because they use different origins. Clearing browser data removes local history; the repository's Actions tab still contains the workflow runs. Closing before acceptance can leave an unsent draft that needs to be supplied again.

A request ID is saved before dispatch and included in the workflow run name. If the response is interrupted, the app searches for that exact run instead of automatically submitting again. Explicit retry also checks an unknown outcome first. Polling slows when disconnected and pauses in hidden tabs; the **Check status** and **Refresh** buttons provide an immediate check.

## Authorization and storage

| Component | Responsibility |
| --- | --- |
| Public GitHub Pages reader | Browsing, copying, local validation, and anonymous workflow status reads; it never probes owner sessions or submits imports |
| Owner studio frontend | Same interface, plus a session check against its exact trusted HTTPS origin and fixed `/api/owner/` routes |
| Managed owner API | GitHub sign-in, fixed owner and repository checks, batch validation, staging, dispatch, and authenticated workflow status |
| Managed D1 database | Encrypted app configuration, encrypted sessions and temporary authorization state, plus small staged-upload and submission records |
| GitHub repository | The sole prompt catalog, `data.json`, and the serialized import and publication workflow |

GitHub App creation and repository installation happen once. Each owner session uses the app's GitHub account authorization flow. Runtime GitHub requests use the authenticated owner's user token on the server, so imports are dispatched as **`budhi-halim`** and satisfy the workflow's existing actor guard. The app installation is verified for only `seo-yuna`; the original `sakura-yuki` repository remains outside every write path.

The browser receives a short-lived CSRF value for same-origin mutations and keeps it in memory. GitHub credentials are never returned to frontend code or saved in browser storage. The server session cookie is secure and HTTP-only, and sign-out invalidates the server session. App configuration and session payloads are encrypted with a managed runtime secret that is absent from the repository. D1 does not store a second prompt catalog or the JSON batch text.

## How the workflow works

The browser computes a SHA-256 checksum and sends the validated UTF-8 batch to the owner API. The server rechecks the current canonical file, stages the batch using GitHub's Git Blobs API, and records the blob SHA and digest with the verified owner. A subsequent dispatch sends only three references: the request UUID, blob SHA, and SHA-256 digest. The server accepts only a staged receipt belonging to that owner, claims the request before dispatch, and does not automatically replay an interrupted attempt. GitHub API requests are pinned to `2026-03-10`; a returned run ID allows immediate status tracking, and exact run-name lookup handles a confirmed acceptance without one.

The workflow accepts imports only from `budhi-halim` on `master` in `budhi-halim/seo-yuna`. It validates the file size, UTF-8 encoding, Git blob SHA, SHA-256 digest, schema, and conflicts. It then reads a current immutable snapshot of the catalog and writes `data.json` with an optimistic SHA check. If another writer changes the catalog, it rereads and remerges within a bounded retry loop.

Merging and deployment share one concurrency group with `cancel-in-progress: false` and `queue: max`. This queues later runs without replacing an older pending import and keeps these workflow deployments serialized. Checkout starts from current `master` after the job leaves the queue. The site is built from the saved commit.

Publication happens in the same workflow. Commits made with `GITHUB_TOKEN` do not start another push workflow, so an independent push-only deployment would miss these imports. A normal code push still runs the same publisher. Manual repository edits are outside this app’s append-only import policy; avoid editing `data.json` while troubleshooting a run unless you intend to change the canonical collection.

Official Actions are pinned to full commit SHAs. The frontend and repository scripts have no npm dependencies, external scripts, or external fonts. The static build copies only the public HTML, assets, canonical JSON, and rulebook into `_site`, and adds a `version.txt` commit marker. Backend source, tests, workflow source, and documentation are not included in that Pages build. The owner service is deployed separately on managed hosting; it serves the same frontend and reads the published catalog through a server route instead of storing another catalog file.

## Development and verification

Use Node.js 22.18 or later. No package installation is required.

```sh
node --test tests/*.test.mjs
node tools/build-site.mjs
```

Serve `_site` with a local static HTTP server for development. The production import actions still target the explicitly configured GitHub repository. The scripts refuse workflow events that target the old repository or an unexpected branch/actor.

For individual owner-client test output, run `node tests/owner-client.test.mjs`. The auth, setup, and API tests exercise server identity checks, CSRF, encrypted state, callback replay protection, and uncertain dispatch outcomes without real account credentials.

The managed owner checkout is separate from the Pages build. `node tools/sync-owner.mjs /path/to/prepared-owner-checkout` copies this repository's frontend, server modules, route adapters, and schema into an already registered server Site with a `DB` binding. Deployment must provision the schema, the fixed `APP_ORIGIN`, and the secret `APP_CREDENTIAL_KEY` in that host. The synchronization tool does not read or export credentials. Publishing these source updates preserves the distinction between deployed code and the owner's GitHub registration step.

| File | Purpose |
| --- | --- |
| `index.html`, `assets/style.css`, `assets/favicon.svg` | Single-page interface and visual design |
| `assets/app.mjs` | Navigation, clipboard actions, validation UI, GitHub account controls, and submission history |
| `assets/owner-client.mjs` | Exact-origin owner session facade, CSRF-protected imports, and public status fallback |
| `assets/shortcuts.mjs` | Keyboard gesture and looping navigation rules |
| `assets/selector-search.mjs` | Number-and-name filtering that preserves displayed positions and current selection |
| `assets/github.mjs` | Fixed-repository GitHub API client; anonymous in the browser and authenticated only on the owner server |
| `assets/receipts.mjs` | Explicit nonsecret browser-storage schema |
| `assets/import-batch.mjs` | Deterministic filename sorting and atomic multi-file batch preparation |
| `owner/auth.mjs` | GitHub account authorization, encrypted sessions, fixed owner checks, and CSRF |
| `owner/setup.mjs` | One-time private GitHub App manifest registration and repository installation |
| `owner/github-app.mjs` | Server-only GitHub App and installation verification |
| `owner/api.mjs` | Fixed owner import routes, staged receipt binding, and durable dispatch claims |
| `owner/sites-route.ts`, `owner/sites-data-route.ts` | Managed server adapters for the owner API and the published catalog |
| `owner/sites-schema.ts`, `owner/schema.sql` | D1 schema for encrypted authorization state and nonsecret submission records |
| `assets/catalog.mjs` | Shared schema validation and immutable append logic |
| `tools/import-data.mjs` | Workflow validation, integrity checks, and conflict-safe catalog commit |
| `tools/build-site.mjs` | Explicit static-site build |
| `tools/sync-owner.mjs` | Copies source into a separate prepared owner-server checkout |
| `.github/workflows/studio.yml` | Serialized import and Pages deployment |
| `tests/` | Validation, concurrency retry, security boundaries, receipts, API behavior, and keyboard tests |

## GitHub references

- [Workflow dispatch REST API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [Git blobs REST API](https://docs.github.com/en/rest/git/blobs)
- [Workflow concurrency and larger queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [Custom GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [OWASP browser storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)
