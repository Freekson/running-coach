---
name: pr-description
description: Draft a clear, ready-to-paste GitHub pull request title and description for a completed Running Coach Linear issue, based on the actual Git diff and verified checks. Use when asked for a PR description, PR title, pull request summary, or after completing implementation when preparing the handoff. Never create, commit, push, or merge a PR.
---

# Running Coach PR Description

Prepare a **copy-paste-ready GitHub PR title and body** for completed work. Report what the implementation actually changes; do not describe intended work as completed.

## Repository conventions

- Feature/fix/chore PR: `feat/*`, `fix/*`, `chore/*` -> `development`.
- Release PR: `development` -> `main`.
- Reference the relevant Linear issue (`RUN-<number>`) in the title or body. Prefer the verified Linear URL if available. Do not invent URLs.
- Keep PR titles concise, in English, and use Conventional Commit style (`feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`, `docs(scope): ...`). For releases use `release: vX.Y.Z — <summary>` only when the version and release scope are confirmed.
- PR body language: **English**, matching the repository. User-facing introduction may be in Ukrainian.
- Follow `AGENTS.md` and the existing `.github` PR template if present. Preserve its required sections when possible.

## Gather evidence (read only)

1. Identify the current branch with `git branch --show-current` and check changes with `git status --short`.
2. Identify target/base: normally `development` for issue branches; normally `main` for release from `development`. Respect an explicitly specified target branch.
3. Use locally available refs to inspect branch changes (`git merge-base HEAD origin/development` or `origin/main` as appropriate, then `git diff --stat <merge-base> HEAD`, `git diff --name-status <merge-base> HEAD`, and review relevant actual diffs). If remote refs are absent, inspect local equivalents and disclose the comparison limitation. **Do not assume a branch or diff exists.**
4. Inspect `git diff`, `git diff --cached` and untracked-file names when relevant. Uncommitted changes are **not yet included in a pushed PR**; distinguish them from committed changes and state the limitation clearly. If the user is preparing a PR before committing, you may draft provisionally using clearly identified local changes.
5. Inspect changed implementation, tests, documentation, schema, and configuration as needed to make concrete statements. Do not infer behavior solely from commit messages or issue titles.
6. Obtain the Linear issue title, description, and acceptance criteria using an available Linear tool **if already connected**. Otherwise use the `RUN-...` ID in the branch/user message and available local task context. If unavailable, do not fabricate requirements or completion status.
7. Check for a PR template (`.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE/`, etc.) and adapt the output to its format.
8. Collect checks from this session or trustworthy CI evidence. A command you did not execute and cannot verify must be marked **Not run / Not verified**, not Passed. Don't execute expensive builds merely to draft a description unless the user requested validation.

## Compose the PR

Produce exactly these sections (or the equivalent repository PR template):

**PR title**

A short, change-based Conventional Commit title, with issue reference where useful.

**PR description** (one fenced `md` block ready to paste):

```md
## Summary

- <2–4 bullets describing actual behavior and architectural changes>

## Linear issue

- RUN-XX — <issue title or verified URL>

## Changes

- <specific implementation details; no speculative features>

## Validation

- [x] <verified check and outcome>
- [ ] <not run / manual checks still needed>

## Notes / Risks

- <migration, environment variables, secrets, deployment, known limitations, and any deferred work if relevant; otherwise "None identified">
```

Adapt section titles and checkboxes to the project's template if one exists. Prefer concise, reviewer-useful bullets. Include screenshot/manual-testing notes **only** when relevant; never claim screenshots exist unless provided. Mention backward compatibility, data migrations, auth/ownership and deploy considerations when they actually changed. Avoid including secrets, `.env` contents, private athlete information, or huge diff excerpts.

If a task has incomplete acceptance criteria or unexplained changes, make that explicit under **Notes / Risks** rather than claiming it is fully done. For a `development` -> `main` release, summarize the actual combined changes and confirmed release scope; do not list individual changes as verified without inspecting them.

## Non-negotiable safety rules

- **Read-only drafting:** Do not run `git add`, `git commit`, `git push`, `git merge`, `gh pr create`, `gh pr edit`, or modify code/config/docs as part of this skill.
- Do not create or update a GitHub PR, Linear issue, or status automatically.
- Do not claim CI passed because a previous unrelated PR passed.
- Do not invent tests, performance gains, dependencies, migration steps, or deployed functionality.
- Finish by presenting the title and body for the user to paste; the user controls GitHub actions.
