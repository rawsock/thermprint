# AGENTS.md

How to work in this repo. Deliberately repo-AGNOSTIC: nothing here names a module, a directory or a
command, so it stays true as the tree changes. What is specific to this project — what it is, how it
is laid out, how to install and test it — lives in `PLANS.md`, which is also the entry point to the
plan files. Read that first.

`CLAUDE.md` imports this file, so Claude Code and Codex CLI both read it natively. Edit here, never
there.

## Core engineering preferences

- Programming language is Python.
- Compact, direct code; prefer functions and small modules over classes. Use classes only when they
  clearly improve the design — persistent state, polymorphism, lifecycle management.
- Keep changes minimal, localized and easy to review.
- Avoid speculative abstractions, generic frameworks, or future-proofing the current task does not
  require.
- Follow existing project conventions before introducing new patterns.
- Console output goes only through the `rich` logger, never bare `print`. For each logical section,
  and anything processing-heavy, log what is currently happening.
- WAV I/O uses `soundfile`.
- One input interface per tool — don't mix CLI args with env vars or global defines for the same
  setting.
- When thinking or replying, use a relatively compact style. No unnecessary explanation or
  repetition.

## Reuse and dependencies

- Don't reinvent functionality a well-known, reliable library already provides — parsing,
  validation, date/time, file handling, CLI parsing, testing utilities.
- Before adding a dependency, check whether the project already has one for that purpose.
- A dependency belongs to the narrowest installable that needs it, never to the shared base.

## Command-line interfaces

- Keep CLIs small and focused, with few well-documented options.
- Don't expose internal implementation details as flags unless necessary (e.g. debugging).
- Where many options are unavoidable, use a YAML config file instead of expanding the CLI.
- Preserve backward compatibility for existing options unless the task explicitly allows breaking
  changes.
- A config file LABELS its options, it does not explain them. One inline comment per parameter,
  on the parameter's own line, and nothing more unless the design genuinely requires it -- a
  format the user has to type, a unit that is not obvious from the name. Why a value is what it
  is belongs in the code that reads it or in the plan file, and prose in a config is the third
  copy of an explanation that then rots in three places. The same goes for a file's header: say
  what the file is and who reads it, not how the system works.

## Testing

- Add or update unit tests for changed logic, and integration tests when behaviour crosses a module,
  process or API boundary. Prefer focused tests of observable behaviour over implementation details.
  Include regression tests for bugs.
- Run the most relevant test subset before finishing.
- Tests must skip gracefully when the data they need is absent.
- Derive paths from ONE named anchor per suite, not from fresh `parents[n]` arithmetic in each file:
  depth changes, and every hand-counted path breaks at once.
- With more than one test suite in a repo, shared helpers go in a uniquely NAMED module, not in
  `conftest`. Several `conftest.py` files on `sys.path` resolve `from conftest import ...` to
  whichever was imported first, which silently hands one suite another's helpers — a wrong answer,
  not an error. Reserve `conftest.py` for fixtures, which are resolved per directory, and keep test
  file basenames unique across suites or collection fails outright.

## Implementation discipline

- Inspect the relevant existing code before proposing changes.
- Prefer modifying existing code paths over creating parallel implementations.
- Keep diffs small and cohesive; avoid broad refactors unless the requested change needs them.
- Don't mix unrelated cleanup with feature work.
- Comment non-obvious decisions where the comment clarifies intent.
- Code, tests and config never cite a plan file, a plan section or a dated plan entry. A comment
  states its own reason and, if it rests on a measurement, the number and its date. Plans are
  regrouped and pruned; a pointer into them goes stale silently, while the code is what a plan
  defers to.
- Remove dead code introduced or made obsolete by the change.
- When one quantity has two implementations, fold them into the one that owns the concept. Two
  algorithms for the same conversion are not redundancy, they are a disagreement waiting to happen.
- Beware a module-level name that a function also uses as a local: promoting a private helper to a
  shared name can be shadowed at a call site and fail only at runtime. If the local name is the
  natural one, rename the local, and don't paper over it with a second alias for the import.
- Commit each completed change separately, so it is easy to revert individually.

## How to write a plan file

For any `/plan` task, update the relevant plan file *before* editing code, and keep it current as
the work proceeds.

Plan files exist so a future session does not re-derive what was already measured. They rot in one
specific way: each session appends a dated entry, restates the method it just used, and leaves the
previous entry in place. One file here reached 184 kB that way and had to be cut in half. The rules
that prevent it:

1. **One entry per DECISION, not per session.** When new work touches a decision that already has an
   entry, edit that entry. Appending "revisited X" beside "X" is how a plan becomes a diary. A
   superseded number is replaced, not preserved beside its replacement — unless the change of mind is
   itself the finding, in which case say so in one sentence.
2. **An entry is: the decision, the number it rests on, and the provenance of that number** (which
   data, which date). The derivation, the intermediate readings and the ranked candidates are in git
   history and in the commit that made the change. Do not restate them.
3. **A method lesson goes in the file's "rules" list once**, never re-explained inside the entries
   that used it. If two entries teach the same lesson, they are one list item and two data points.
4. **Group by subsystem, not by date.** Dates belong inside an entry as provenance for a
   measurement, never as the organising axis. Reverse-chronological ordering guarantees the
   duplication in rule 1.
5. **A rejected idea gets one line: what it was, the number that killed it, and why that number.**
   Negative results are the expensive part to rediscover, so they stay — but a paragraph of
   narration about how the rejection was reached is not the result.
6. **Nothing that the code, the config or this file already states.** No module inventories, no
   how-to-run instructions, no restating a comment that lives next to the code it describes. If a
   plan and the code disagree, the code wins and the plan is wrong.
7. **Prune when you touch a section, and treat these as budgets**: ~1000 lines or ~80 kB per plan
   file. Past that, prune before adding, and split by subsystem rather than growing a file whose
   sections nobody reads to the end. Pruning is normal maintenance, not a special task — and it is
   only safe against these rules, because they are what tells you which text carries information.
8. **Closed threads shrink to their conclusion.** When something is settled, cut it to the decision
   and the evidence that would have to change for it to reopen. A closed thread that still reads as a
   work log is the largest single source of bloat. A migration or a one-off task that has finished
   loses its planning document entirely, once its durable facts have moved to where they are used.

## Codex collaboration

Use the codex-peer skill proactively for nontrivial technical
problems when independent analysis would improve reliability.

Treat Codex as an expert peer, not merely a code reviewer.
You may discuss ideas and challenge conclusions with Codex
without asking me first.

Do not invoke Codex for trivial tasks. Resolve disagreements
yourself where possible, and inform me of significant unresolvable
differences of opinion.
