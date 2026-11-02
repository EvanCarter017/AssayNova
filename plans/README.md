# Implementation plans

User-selected feature plan, 2026-11-02. Workflow: improve plan → isolated executor → independent review → local preview integration by an executor when approved. The advisor does not edit application source or merge branches.

| Plan | Title | Priority | Depends on | Status |
| --- | --- | --- | --- | --- |
| 001 | Development-only Alt-click element context and preset Prompt | P1 | none | DONE |

Baseline: `872b4b037119737bc8a8deb48645ec206c49e817`. Executor worktree: `D:\Projects\assaynova-locator-work`, branch `advisor/001-alt-element-context`.

The installed `improve` skill was already present and all four files were verified against the official `shadcn/improve` GitHub source by Git blob hashes. No duplicate install or overwrite was necessary.

This is a focused requested feature plan, not a full codebase audit. Framework migration, pricing animation, production backend, and unrelated product work are outside scope.

## Review and local preview integration

- Approved executor commit: `e1c4596dda861fc85f07e4648cca37b7b56777bf` on `advisor/001-alt-element-context`, worktree `D:\Projects\assaynova-locator-work`.
- Reviewer independently ran all five syntax checks and the Node suite: 11 passed, 0 failed, 0 skipped. Read the full scoped implementation and verified no changes to `dist/`; independent read-only reviewer found no blockers.
- Browser acceptance passed: actual clipboard preset has one editable request field; heading maps to original HTML line 48; Alt CTA does not open its form; ordinary clicks work; dynamic input maps to renderSubmission line 51 without typed values; saved request view maps to renderRequestDetail line 149 without saved form content; copied report chart maps to renderReport line 114; forced clipboard rejection exposes a usable in-dialog fallback with full text selection. Temporary browser test override was removed by reload.
- The exact release-between-pointerdown-and-click browser sequence could not be driven through available raw CDP input methods; gesture state-machine regression tests cover Alt release, long-held latch logic, Escape cancellation, and a new ordinary pointerdown.
- Executor copied only the eight approved paths to the live project after checking for drift, with all SHA-256 hashes matching. No Git merge, staging, main-branch commit, push, or deployment was performed. Main remains at baseline with the feature as reviewable working-tree changes.
- Existing localhost 4317 service was replaced by the verified owned process; current hidden Node PID 7592, child NODE_ENV=development. HTTP/context/status checks pass; live preview remains running as requested.
- Final visible-preview smoke confirmed the real browser clipboard points to `D:\Projects\assaynova`, selector `h1 > span`, `dist/index.html:48`, with exactly one requested-change field. No new browser errors were observed. Production/default mode exclusion is covered by the HTTP tests.
- Preserved ordinary site content, current framework choice, and the deferred pricing animation.
