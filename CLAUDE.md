# CLAUDE.md

Guidance for Claude Code (and other AI assistants) when working in this repository.

## Repository Status

**This repository is currently empty.** As of the initial commit on this branch, there is no application code, build configuration, tests, or documentation beyond this file. The remote (`mosnin/Clickup`) has no other branches.

The name `Clickup` suggests the project may eventually integrate with or clone functionality from ClickUp (the project-management product), but no scope has been committed yet. **Do not infer architecture, language, or conventions from the repo name** — wait until real code lands, then update this file.

## What to do until code lands

When you (an AI assistant) are asked to make changes here:

1. **Confirm the user's intent before scaffolding.** Don't pick a stack, framework, or directory layout on your own. Ask which language, framework, package manager, and target platform the project should use.
2. **Add only what was asked for.** Don't pre-create `src/`, `tests/`, CI configs, lint configs, Dockerfiles, etc. on speculation. Each piece of scaffolding is a decision the user should make.
3. **Keep this file honest.** If you add real code, replace the relevant sections below with concrete information. If the repo is still empty after your turn, leave this notice intact.

## Conventions for this repo

These apply regardless of what code eventually lives here:

- **Branching:** Feature work goes on `claude/<short-slug>` branches. The current working branch is `claude/add-claude-documentation-dCV2F`. Do not push to `main` directly.
- **Commits:** One logical change per commit. Write a short imperative subject (≤72 chars) and use the body to explain *why* when it isn't obvious.
- **PRs:** After pushing a branch, open a draft PR against `main`. Keep the PR description focused on the user-facing change and test plan.
- **Files Claude should not create unprompted:** `README.md`, additional `*.md` docs, license files, `.gitignore` entries beyond what a chosen toolchain requires. Ask first.

## Update protocol

When the codebase grows, replace this file's content with sections covering at minimum:

- **Stack & entry points** — language(s), framework(s), how to run the app locally.
- **Directory layout** — what lives where, and what each top-level directory is responsible for.
- **Build / test / lint commands** — the exact commands an agent should run before declaring work done.
- **Conventions** — naming, error handling, logging, module boundaries, anything non-obvious.
- **External services & secrets** — what the app talks to, where credentials come from, what's safe to log.
- **Gotchas** — things that have bitten contributors and should not bite the next agent.

Until those sections can be written from real code, leave them out rather than guess.
