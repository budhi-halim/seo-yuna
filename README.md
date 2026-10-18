# Seo Yuna Studio

A single-page prompt collection with keyboard navigation and JSON imports through GitHub Actions. Browse and copy prompts without signing in. Only the owner can submit updates. **Owner sign-in is pending configuration.** This public build supports browsing, copying, and local JSON validation; submission stays disabled until a trusted account-authenticated backend is connected.

This repository starts with the **22 themes and 156 prompts** from `budhi-halim/sakura-yuki` at commit `7131198691f24a1dbd47293993f5bf161c9c60f0`. Their text, IDs, and ordering are preserved. The original repository is independent and is never a write target of this app or its workflow.

## One-time setup

1. Publish these files to the public repository **`budhi-halim/seo-yuna`**, with **`master`** as its default branch.
2. Open **Settings → Pages → Build and deployment** and select **GitHub Actions** as the source.
3. Open **Actions → Seo Yuna Studio → Run workflow**. Select `master`, leave all three inputs empty, and run it to publish the initial website. A normal push to `master` also publishes it.
4. Open the website URL reported by the successful deployment.

The workflow uses GitHub’s built-in `GITHUB_TOKEN`. You do not need to add a repository secret. Keep the `github-pages` environment free of required reviewers if you want imports to publish without a manual approval step. Repository rules that prohibit the workflow from updating `data.json` must be configured to allow that intended update.

### Account-only owner access — pending configuration

There is no application password, passphrase, or token input. The public page cannot read GitHub login cookies or treat a browser flag as authorization. Submissions remain disabled until a trusted backend verifies the selected owner account.

Two supported designs are under consideration: GitHub sign-in with a server-side OAuth exchange and a fixed owner GitHub ID check; or an owner-private managed importer using its platform account boundary. Either design can use a GitHub App installed only on `seo-yuna` for server-to-server writes. The account provider, GitHub App registration, credentials, and endpoint are not configured in this release. No GitHub App access has been granted by publishing this code.

The public page and `data.json` remain readable by anyone. Browser edits cannot grant repository access. The existing import worker currently accepts only the repository owner's GitHub actor; adding a trusted app actor requires an explicit matching identity after registration.

## Using the studio

The **Prompts**, **Add JSON**, and **Activity** tabs are views in one HTML page. The outer page fits the viewport; long prompts, the JSON editor, and activity use internal scrolling. Native dropdowns, navigation buttons, and copy buttons remain available on touch screens.

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

1. Open **Add JSON**.
2. Choose **Paste JSON** for one valid JSON array, or **Upload files** to select or drop multiple JSON files. The app sorts files by filename using natural numeric order: `data_1.json`, `data_2.json`, then `data_10.json`. Review the visible ordered list before submitting.
3. Click **Validate JSON**. Review new themes, new prompts, extended themes, and duplicate entries.
4. Once owner sign-in is configured, sign in and click **Submit to GitHub**. Submission is disabled in the current public build.
5. Keep the page open until **Accepted by GitHub** appears. After acceptance, processing continues on GitHub when the page closes.
6. Check **Activity** or the linked GitHub run for the final result.

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

Each import is limited to **5 MiB of UTF-8 JSON in total**. For multiple files, both their combined original byte size and the serialized combined payload must fit this limit. Each file is parsed separately, must contain at least one theme with a variation, and must have a unique filename. Files with the same natural numeric sort value use the original filename as a deterministic tie-break. JSON files must use valid UTF-8; damaged encodings are rejected instead of silently changing prompt characters. All files are combined into one batch and submitted together, so a conflict in the last file prevents the whole import. The complete stored catalog is limited to **50 MiB**. These are application limits. Older themes with four variations remain valid; the importer does not impose a fixed variation count. The app requires at least one variation in a submitted batch.

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

Activity stores only nonsecret receipts in this browser: request IDs, checksums, Git blob SHAs, run IDs, timestamps, counts, and status. Activity stores neither your token nor the JSON payload. Clearing browser data removes local history; the repository’s Actions tab still contains the workflow runs. Closing before acceptance can leave an unsent draft that needs to be supplied again.

A request ID is saved before dispatch and included in the workflow run name. If the response is interrupted, the app searches for that exact run instead of automatically submitting again. Explicit retry also checks an unknown outcome first. Polling slows when disconnected and pauses in hidden tabs; the **Check status** and **Refresh** buttons provide an immediate check.

## How the workflow works

The browser checks the batch against the latest canonical file, stages its UTF-8 text using GitHub’s Git Blobs API, computes a SHA-256 checksum, and dispatches `studio.yml` with three small references. The API is pinned to `2026-03-10`, whose workflow-dispatch response includes a run ID.

The workflow accepts imports only from `budhi-halim` on `master` in `budhi-halim/seo-yuna`. It validates the file size, UTF-8 encoding, Git blob SHA, SHA-256 digest, schema, and conflicts. It then reads a current immutable snapshot of the catalog and writes `data.json` with an optimistic SHA check. If another writer changes the catalog, it rereads and remerges within a bounded retry loop.

Merging and deployment share one concurrency group with `cancel-in-progress: false` and `queue: max`. GitHub allows up to 100 pending runs in this configuration. This prevents a newer import from replacing an older pending import and keeps these workflow deployments serialized. Checkout starts from current `master` after the job leaves the queue. The site is built from the saved commit.

Publication happens in the same workflow. Commits made with `GITHUB_TOKEN` do not start another push workflow, so an independent push-only deployment would miss these imports. A normal code push still runs the same publisher. Manual repository edits are outside this app’s append-only import policy; avoid editing `data.json` while troubleshooting a run unless you intend to change the canonical collection.

Official Actions are pinned to full commit SHAs. There are no npm dependencies, external scripts, external fonts, or paid backend services. The build copies only the public HTML, assets, canonical JSON, and rulebook into `_site`, and adds a `version.txt` commit marker. Workflow source, tests, and documentation are not deployed as website assets.

## Development and verification

Use Node.js 22 or later. No package installation is required.

```sh
node --test tests/*.test.mjs
node tools/build-site.mjs
```

Serve `_site` with a local static HTTP server for development. The production import actions still target the explicitly configured GitHub repository. The scripts refuse workflow events that target the old repository or an unexpected branch/actor.

| File | Purpose |
| --- | --- |
| `index.html`, `assets/style.css`, `assets/favicon.svg` | Single-page interface and visual design |
| `assets/app.mjs` | Navigation, clipboard actions, validation UI, and submission history |
| `assets/shortcuts.mjs` | Keyboard gesture and looping navigation rules |
| `assets/github.mjs` | Browser GitHub API client and workflow status interpretation |
| `assets/receipts.mjs` | Explicit nonsecret browser-storage schema |
| `assets/import-batch.mjs` | Deterministic filename sorting and atomic multi-file batch preparation |
| `assets/catalog.mjs` | Shared schema validation and immutable append logic |
| `tools/import-data.mjs` | Workflow validation, integrity checks, and conflict-safe catalog commit |
| `tools/build-site.mjs` | Explicit static-site build |
| `.github/workflows/studio.yml` | Serialized import and Pages deployment |
| `tests/` | Validation, concurrency retry, security boundaries, receipts, API behavior, and keyboard tests |

## GitHub references

- [Workflow dispatch REST API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [Git blobs REST API](https://docs.github.com/en/rest/git/blobs)
- [Workflow concurrency and larger queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [Custom GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [OWASP browser storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)
