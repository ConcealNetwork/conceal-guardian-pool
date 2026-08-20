# Architecture decision records (ADRs)

> How this project captures **architectural** decisions. ADRs live next to OpenSpec
> archives. Scaffolded by Forgekit (`forge init --adr` / `forgekit install` with ADRs on).

ADR directory for this project: **`docs`** (configured in `.forge/config.json`).

---

## 1. Why ADRs *and* OpenSpec archives?

They overlap in “why we did something,” but they serve different lookups:

| OpenSpec archive (verbose) | ADR (short) |
| -------------------------- | ----------- |
| `proposal.md`, `design.md`, `tasks.md`, specs | One file, one sharpened decision |
| “Replay the implementation story” | “Why is X shaped this way?” |

---

## 2. When to write an ADR

| Write an ADR when the change … | Skip the ADR when … |
| ------------------------------ | ------------------- |
| Establishes or moves a boundary | Bug fix / copy / docs-only |
| Chooses among real alternatives | Refactor that changes no decision |
| Adds a constraint future code must follow | Chore rename without semantics |
| Picks a costly-to-swap vendor or protocol | Narrow feature inside a prior ADR |
| Codifies a convention across the repo | Noise would drown readers |

If you’re listing code edits, that belongs in `design.md`—not an ADR.

---

## 3. Format (`docs/NNNN-short-topic.md`)

```markdown
# NNNN. <Short, decision-shaped title>

- **Status**: Proposed | Accepted | Superseded by ADR-NNNN (…)
- **Date**: YYYY-MM-DD
- **Area**: <product or layer>
- **Related**: openspec/changes/archive/<change>/, …

## Context

One paragraph: pressure or constraint forcing a decision.

## Decision

One imperative paragraph stating what this project commits to.

## Alternatives considered

- **Option A** — rejected because …
- **Chosen** — …

## Consequences

### Positive
### Negative
### Neutral

## References

- Archive: openspec/changes/archive/<name>/
```

Keep ADRs terse (roughly tens to low hundreds of lines each).

---

## 4. Numbering

- Sequential `NNNN`; never recycle numbers—supersede with a **new** ADR.
- Prefer decision-shaped filenames: `0004-outbox-only-on-critical-path.md` not `0004-add-worker.md`.

All ADRs sit under **`docs/`** even when scoped to one area—the decision
usually crosses layers.

---

## 5. Status index (`docs/README.md`)

Maintain the table of `#`, Title, Status, Date. Leave placeholder rows until real ADRs land.

---

## 6. Cross-link OpenSpec ↔ ADRs

ADR **References** should point at the dated archive folder.

Archived `proposal.md` should gain:

```markdown
## Decision record

This change is recorded as ADR-NNNN (docs/NNNN-short-topic.md).
```

Or, for non-architectural archives, the one-line stamp:

```text
No ADR — non-architectural change
```

Capability specs may cite ADRs as normative “why.”

---

## 7. ADRs in agent retrieval

Short, focused ADRs embed well. **Do not** add `docs/` to
`.cursorindexignore` (or equivalent).

---

## 7a. Hooks: archive → ADR

When ADR wiring is enabled, archive hooks remind agents to run **archive-to-adr**
after `openspec archive` or a move into `openspec/changes/archive/YYYY-MM-DD-…`.

Session-start backstops list archives whose `proposal.md` lacks `ADR-[0-9]` **and**
lacks the `No ADR — non-architectural change` stamp.

---

## 8. Maintenance habit

- On each meaningful archive: decide ADR vs stamp.
- Periodically skim the index for stale status.
- Supersede with new ADRs—don’t delete old ones.

---

## 9. TL;DR

- ADRs **distill** decisions; OpenSpec archives keep the **full** story.
- Use this file + `docs/README.md` + `docs/NNNN-*.md`.
- Cross-link archives and ADRs both directions.
- After archive: run **archive-to-adr** (or stamp “No ADR”).
