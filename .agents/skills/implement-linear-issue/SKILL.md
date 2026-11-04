---
name: implement-linear-issue
description: Implement a scoped Running Coach Linear development issue according to acceptance criteria, project architecture, authorization rules, tests, and CI. Use when tasked to write or change application code for RUN-* tickets.
---

# Implement a Running Coach issue

1. Read the requested Linear issue and its acceptance criteria. If direct Linear access is unavailable, use the supplied ticket text and clearly note missing details. Identify dependencies and existing code paths. Only consult design docs relevant to the issue.
2. Write a concise implementation plan for any multi-file/domain change. Keep diff within issue scope; note new architectural decisions before changing shared contracts.
3. For UI work, inspect `src/components/ui/`, related feature components, their co-located `*.stories.tsx` files, and `docs/design-tokens.md` before adding a component or style. Reuse shared components and semantic tokens. Add or extend a shared primitive only when reuse is clear; keep its public props typed and its Storybook stories in sync with meaningful variants and states. Keep feature-only compositions local and story mocks out of production imports. Review labels, keyboard focus, dark contrast, and narrow/zoomed layouts.
4. Implement server-side behavior and validation first where applicable. Derive the owner from verified auth; authorize nested entity access. Do not hardcode athlete-specific distance/records. Respect immutable approved plans and data provenance.
5. Write unit tests and, for any owned resource or privileged action, negative cross-user and unauthenticated tests. Use synthetic athlete fixtures.
6. Where changing DB schema, follow `db-migration` skill and inspect SQL migration. Where changing provider adapters, preserve canonical domain model and verify capabilities.
7. Execute format/check, lint, typecheck, tests, build as available. For shared UI changes, also run `pnpm build-storybook`; when changing Storybook setup, smoke-test `pnpm storybook`. Fix real errors rather than disabling rules. If cannot run, state why and exactly what remains unverified.
8. Summarize: acceptance criteria met/not met, files changed, migration actions, tests/commands and results, risks, and suggested PR description. Do not mark a Linear issue Done without verified acceptance.
