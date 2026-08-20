# `specs/` — Forge specs (built-in planning engine)

OpenSpec-compatible change tracking without the OpenSpec CLI. Managed by the
Forge workflow (see the `forge` skill, `phases/plan-specs.md`).

```
specs/
  changes/<change-name>/
    proposal.md   # Why / What Changes / Impact
    design.md     # optional — context, decisions, risks
    tasks.md      # ## groups with - [ ] task checkboxes
  changes/archive/YYYY-MM-DD-<change-name>/   # archived on finish
```

Conventions (kept identical to OpenSpec so migration stays trivial):

- One change per unit of substantial work; kebab-case change names.
- `tasks.md` uses `##` section groups and `- [ ]` checkboxes; Forge counts
  and reviews per group.
- On finish, move the change dir into `changes/archive/` with a date prefix,
  then follow the project ADR policy if enabled.

Migrating to OpenSpec later: run `openspec init`, then move
`specs/changes/*` into `openspec/changes/`.
