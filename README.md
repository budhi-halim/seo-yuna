# Seo Yuna Studio

A single-page prompt collection with keyboard navigation and JSON imports through GitHub Actions. Everyone can browse and copy prompts. Owner access uses a GitHub token encrypted in the owner's browser and unlocked with two local strings: **Username** and **Password**.

**App:** [budhi-halim.github.io/seo-yuna](https://budhi-halim.github.io/seo-yuna/)

The app runs on GitHub Pages and communicates directly with GitHub's API. There is no hosted authentication service, OAuth redirect, or separate owner site. Login does not start a workflow. The username and password are local unlock credentials; GitHub authorizes repository requests using the unlocked token.

This repository starts with the **22 themes and 156 prompts** from `budhi-halim/sakura-yuki` at commit `7131198691f24a1dbd47293993f5bf161c9c60f0`. Their text, IDs, and ordering are preserved. The original repository is independent and is never a write target of this app or its workflow.

## One-time setup in each browser

1. Open the [app](https://budhi-halim.github.io/seo-yuna/) and select **Owner access**.
2. Select **Create GitHub token**. The link opens GitHub's fine-grained token form with the token name, resource owner, a 90-day expiration, and the two required permissions prefilled. Sign in to GitHub as **budhi-halim** if asked.
3. Check **Resource owner → budhi-halim**. Under **Repository access**, choose **Only select repositories**, then select **seo-yuna**. The link cannot select that repository automatically.
4. Under repository permissions, verify **Contents → Read and write** and **Actions → Read and write**. **Metadata → Read-only** is automatic. No other permissions are needed. Check the expiration; replacing an expired token will require a new setup.
5. Generate the token and copy its full value, beginning with `github_pat_`. Return to Seo Yuna and paste it into **GitHub token · one-time setup**. Enter the token only in the app on your own device; do not put it in chat, JSON, repository files, workflow inputs, or Actions secrets.
6. Choose your own **Username** and **Password**. These can differ completely from your GitHub account details. The password must have at least 12 characters; several unrelated words are preferable. Both fields are exact and case-sensitive, including spaces. Confirm the password.
7. Select **Save & log in**. The app checks the token's GitHub identity, the fixed repository, and its active workflow, then saves the token encrypted in this browser. The header displays **budhi-halim** when owner access is ready.

Read-only verification cannot prove all fine-grained write permissions or that no extra repositories were selected. Review step 4 carefully; GitHub enforces write permissions on each actual upload and workflow request.

On later visits, select **Owner access**, enter your local **Username** and **Password**, and select **Log in**. The form checks the local encrypted connection and verifies the GitHub identity directly. No Action is queued for login. Public reading and JSON validation work while logged out.

The setup belongs to this browser profile. A new browser or device, cleared site storage, a forgotten local login, or an expired/revoked token requires setting up a connection again. To replace it, open **Owner access → Reset or replace this connection → Remove saved connection**, then repeat setup. This removes only the browser's encrypted token; it does not revoke the token on GitHub or change any prompts. Revoke an unused or compromised token in [GitHub token settings](https://github.com/settings/personal-access-tokens).

**Log out**, a page reload, and leaving or closing the tab remove the usable in-memory credential. Closing the Owner access panel after successful login keeps the current tab connected. Cancelling the panel while login is pending cancels that operation. Removing or replacing a saved connection in another tab locks this tab when its storage-change event is received.

### Repository publication

The repository is **budhi-halim/seo-yuna**, with **master** as its default branch. Keep the owner's existing Pages setting, **Deploy from a branch → master → / (root)**. The custom `Seo Yuna Studio` publisher has been verified with this configuration; no Pages source change is needed for this authentication migration.

A push to master runs the publisher. To publish again without importing, open **Actions → Seo Yuna Studio → Run workflow**, select master, leave all three inputs empty, and run it. Imports merge and publish in this same workflow.

The workflow uses GitHub's built-in `GITHUB_TOKEN` for the catalog commit and Pages deployment. You do not add a username, password, password hash, or PAT to repository secrets. Keep the `github-pages` environment free of required reviewers if imports should publish without an approval step. Repository rules must permit the workflow's intended update to data.json.

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

1. Open **Add JSON** in the [app](https://budhi-halim.github.io/seo-yuna/). Log in through **Owner access** before submitting. Login stays on this page and preserves any selected files or pasted draft.
2. Choose **Paste JSON** for one valid JSON array, or **Upload files** to select or drop multiple JSON files. The app sorts by filename in natural numeric order: data_1.json, data_2.json, then data_10.json. Review the visible ordered list.
3. Select **Validate JSON**. Review new themes, prompts, extended themes, duplicates, and conflicts.
4. Select **Submit to GitHub**. The app rechecks the latest collection, stages the data directly on GitHub, and requests the import workflow.
5. Keep the page open until **Accepted by GitHub** and **Safe to close** appear. GitHub continues processing after the page closes.
6. Check **Activity** or the linked GitHub run for the final result. Acceptance confirms the handoff, while the workflow still validates the batch before saving.

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

Activity stores nonsecret receipts separately from the encrypted connection: request IDs, checksums, Git blob SHAs, run IDs, timestamps, counts, and status. It does not store the JSON batch, plaintext tokens, or login strings. Clearing browser data removes local history; workflow runs remain on GitHub. Previous submissions made on a different origin have their original browser history there; this app does not transfer that history.

A request ID is saved before dispatch and included in the workflow run name. If the response is interrupted, the app searches for that exact run instead of automatically submitting again. Explicit retry also checks an unknown outcome first. Polling slows when logged out and pauses in hidden tabs. There is no server-side dispatch claim, so the guarantee is append deduplication, not exactly-once workflow execution.

## Local login and security boundaries

The two strings are encoded as a versioned, unambiguous tuple. A randomly salted PBKDF2-HMAC-SHA256 derivation with 600,000 iterations produces an AES-256-GCM key. Each saved connection uses a fresh salt and nonce. Only the encrypted token and nonsecret encryption metadata are stored persistently. Wrong login details or modified ciphertext fail authenticated decryption; no plaintext password or separate password-verification hash is stored in the app or repository.

The username and password stay on the device. The usable token is held in memory while unlocked and is sent only in authorization headers to the fixed https://api.github.com destination. Requests omit cookies, reject redirects, and exclude upstream error bodies from user-visible errors. Logging out cancels pending authentication and clears the client credential. The app checks the fixed owner ID 121861881 and repository ID 1423899802, owner/repository names, branch, and active workflow. The workflow independently restricts imports to budhi-halim.

Two fields form one combined secret, not two-factor authentication. Knowing the public code or bypassing UI checks does not supply a GitHub credential. Encryption protects the saved record while locked; it cannot protect an unlocked token from malicious code running in the page, a hostile extension, or a compromised device. Browser storage is scoped to an origin, so other project pages on budhi-halim.github.io share the browser boundary. The repository uses local scripts and fonts, strict CSP, and text rendering for prompt/JSON content.

A fine-grained token is restricted to selected repositories and permission categories, not to only data.json. Choose only seo-yuna during setup. An attacker with a stolen usable token could exercise its repository permissions until it expires or is revoked. An attacker with a copied encrypted record could attempt offline guessing, which is why a memorable but strong password and a slow derivation are used. Keep the encrypted record local.

## How the workflow works

The browser computes a SHA-256 checksum and uploads the validated UTF-8 batch through GitHub's Git Blobs API. Dispatch sends only three references: the request UUID, blob SHA, and checksum. Login strings and the PAT are never workflow inputs. GitHub authenticates the dispatch before starting a job; the Action then uses its own GITHUB_TOKEN for validation, merge, and publication. GitHub API requests are pinned to 2026-03-10. A returned run ID allows immediate status tracking; exact run-name lookup handles a confirmed acceptance without one.

The workflow accepts imports only from `budhi-halim` on `master` in `budhi-halim/seo-yuna`. It validates the file size, UTF-8 encoding, Git blob SHA, SHA-256 digest, schema, and conflicts. It then reads a current immutable snapshot of the catalog and writes `data.json` with an optimistic SHA check. If another writer changes the catalog, it rereads and remerges within a bounded retry loop.

Merging and deployment share one concurrency group with `cancel-in-progress: false` and `queue: max`. This queues later runs without replacing an older pending import and keeps these workflow deployments serialized. Checkout starts from current `master` after the job leaves the queue. The site is built from the saved commit.

Publication happens in the same workflow. Commits made with `GITHUB_TOKEN` do not start another push workflow, so an independent push-only deployment would miss these imports. A normal code push still runs the same publisher. Manual repository edits are outside this app’s append-only import policy; avoid editing `data.json` while troubleshooting a run unless you intend to change the canonical collection.

Official Actions are pinned to full commit SHAs. The frontend and repository scripts have no npm dependencies, external scripts, or external fonts. The static build copies only public HTML, assets, the canonical JSON, and rulebook into _site, plus a version.txt commit marker. Backend hosting and deployment adapters are not used.

## Development and verification

Use Node.js 22.18 or later. No package installation is required for the application or unit tests.

```sh
node --test tests/*.test.mjs
node tools/build-site.mjs
```

Serve _site with a local static HTTP server for development. Production imports always target the fixed GitHub repository. Automated tests use synthetic credentials and mocked GitHub requests; never put a real token in a test fixture.

For optional browser integration checks, install Playwright and Chromium in your development environment, then run `node tests/browser-check.mjs`. Set `SEO_YUNA_CHROMIUM` to an alternate Chromium executable if needed. The script starts a local server and fresh browser profiles, mocks GitHub, blocks other external requests, and makes no live writes. It checks the public reader, local setup and login, cancellation, draft preservation, submission handoff, recovery, and the mobile dialog. Screenshots are written outside the repository; `SEO_YUNA_QA_DIR` can change their destination. The application and unit-test gate remain dependency-free.

| File | Purpose |
| --- | --- |
| index.html, assets/style.css, assets/favicon.svg | Single-page interface and local login forms |
| assets/app.mjs | Reader, clipboard, local login controls, validation, and Activity |
| assets/credential-vault.mjs | Password-derived authenticated encryption and browser storage |
| assets/owner-client.mjs | Local credential lifecycle and direct GitHub imports |
| assets/github.mjs | Fixed-repository GitHub API client and status descriptions |
| assets/shortcuts.mjs | Keyboard gestures and looping navigation |
| assets/selector-search.mjs | Number-and-name filtering |
| assets/receipts.mjs | Nonsecret submission receipt schema |
| assets/import-batch.mjs | Deterministic multi-file sorting and atomic preparation |
| assets/catalog.mjs | Shared schema and immutable append logic |
| tools/import-data.mjs | Workflow validation, integrity checks, and conflict-safe commit |
| tools/build-site.mjs | Explicit static build |
| .github/workflows/studio.yml | Serialized import and Pages deployment |
| tests/ | Credential lifecycle, security boundaries, imports, API behavior, and reader tests |

## Retiring the previous owner connection

This release no longer opens or calls the previous hosted owner studio. Removing source dependencies does not revoke an already installed GitHub App or delete an existing hosted deployment. After the direct connection works, the owner can revoke the previous Seo Yuna app under **GitHub Settings → Applications → Authorized GitHub Apps**, and uninstall that same app under **Installed GitHub Apps**. Identify the app created for Seo Yuna; leave unrelated installations alone. These are separate cleanup steps from local token setup.

## References

- [Fine-grained personal access tokens and setup links](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [Git blobs API](https://docs.github.com/en/rest/git/blobs)
- [Web Crypto key derivation](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey)
- [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [GitHub App authorization revocation](https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps)
