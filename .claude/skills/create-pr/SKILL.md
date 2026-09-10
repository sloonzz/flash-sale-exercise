---
name: create-pr
description: Branch off and open a PR using this repo's ticket-based naming convention. Use when the user wants to open a PR, create a PR, ship a branch, or start work on a numbered issue/ticket.
---

# Create PR

This repo's branch and PR naming both key off a ticket: a **type** (`feature` / `fix` / `enhancement`), a **ticket number**, and a short **description**. Establish all three before touching git.

## 1. Establish type, ticket number, description

Find the GitHub issue already in play this session (a number the user gave, or a `Closes #N` / `Part of #N` reference). Fetch it if you haven't already: `gh issue view <N> --json title,body,labels`.

- **type**: `feature` for a new capability, `fix` for a bug, `enhancement` for improving something that already exists. Infer from the issue's labels/title wording; ask the user only if genuinely ambiguous.
- **ticket number**: the issue number.
- **description**: a short kebab-case slug (3-6 words) from the issue title.

Done when all three are settled — they drive both names below.

## 2. Branch

Naming convention: `<type>/<ticket-number>-<description>`, e.g. `feature/2-redis-atomic-reservation`.

Check the current branch name against `^(feature|fix|enhancement)/\d+-[a-z-]+$`:
- Already matches → reuse it.
- Doesn't match → `git checkout -b <type>/<ticket-number>-<description>` off the base branch. If the current branch already has commits pushed upstream that others may have based work on, don't rename it — create the new branch and tell the user instead.

## 3. Commit

Commit any pending work on the branch, following the repo's usual commit conventions (see your standing git-commit instructions). If there's nothing uncommitted and no commits ahead of the base branch, stop and tell the user there's nothing to PR.

## 4. Push and open the PR

PR title convention: `<type>(<ticket-number>): <description>`, e.g. `feature(2): redis atomic reservation module`.

Push the branch and open the PR (`git push -u origin <branch>`, then `gh pr create --title "..." --body "..."`), following your standing PR-creation flow for the body (Summary + Test plan, HEREDOC, attribution footer). Report the PR URL back to the user.
