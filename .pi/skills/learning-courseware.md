---
name: learning-courseware
description: Write, deepen, rebuild, and maintain the Chinese pi source-reading courseware in docs/learning/pi/modules-chain. Use when adding course pages, deepening module explanations, syncing docs after upstream code changes, regenerating index.html, or fixing broken source routes and anchors.
---

# Maintaining the pi Learning Courseware

Run commands from the repository root (two directories above this skill). The courseware lives in `docs/learning/pi/modules-chain/`; its authoring rules are in `docs/learning/pi/modules-chain/GUIDE.md`. Read `GUIDE.md` before editing; this skill is the executable workflow, the guide is the reference.

This work is documentation only. Do not change source behavior, public APIs, prompts, schemas, or generated files. Do not add changelog entries on a non-`main` branch. On `learning/full-chain-study-bay`, the Chinese learning exception in `AGENTS.md` applies.

## When to use

- Add a module page, lesson, trace, glossary entry, or debug-map entry.
- Deepen an existing page: function internals, subfunctions, data changes, failure branches, design reasons.
- Sync courseware after upstream source changes or a rebase.
- Rebuild `index.html`.
- Diagnose a broken route, anchor, page button, or line number.

Not for: adding Chinese inline comments to source (separate annotation task), release notes, or refactoring code to match the courseware.

## Handoff for a new session or model

Start by reading, in this order: `AGENTS.md`, this skill, `GUIDE.md`, `README.md`, `COURSE.md`, then `02-agent-loop/README.md` as the depth benchmark. Run `--check` once before editing to see the baseline. Do not trust a page inventory from an earlier session: read the `PAGES` array and `git status`.

A handoff prompt should state:

- The exact pages or sections to write, and which existing pages are already verified and must not be rewritten.
- The owned file set; other agents may be editing disjoint files. Never edit or stage another owner's files.
- The requirement to read the cited source in full and verify data shapes, failure branches, and event order before writing.
- The definition of done: required sections, 0 `--check` errors, route titles verified, `index.html` regenerated, and `npm run check` if `build.mjs` changed.
- What not to claim: no source behavior changes, no upstream semantic review, no test pass that was not actually run.

Depth is not a line count. A page is deep when a reader can trace one concrete input through real functions, see the data before and after each step, name the failure branches, and explain why the non-obvious choice exists. A deep module page often runs to hundreds of lines because it carries that evidence, not because length is a target.

## Read before writing

1. `AGENTS.md` sections "Chinese Learning Branch Exception", "Code Quality", "Commands", and "Git".
2. `docs/learning/pi/modules-chain/GUIDE.md`, then `README.md` for the current page map and reading order.
3. The page you will edit, plus `02-agent-loop/README.md` as the depth benchmark.
4. Every source file you will describe, in full. Read its callers and callees; verify types and data shapes instead of inferring from names. Check `node_modules` for external types when needed.

## Audience and quality bar

The reader knows basic TypeScript but not pi. Establish the global picture first: one real query through the full chain, then lifecycle traces, then module deep dives, then glossary and debugging. A module page must let the reader answer "where am I, who called this, what data changes, what happens on failure, and why is it designed this way".

Required content for every module page. Use the standard heading names where they fit; mechanism-specific headings are acceptable when they carry the same content and are easy to find.

1. **学完能回答**: verifiable questions, each answerable with source evidence.
2. **一句话职责**: one responsibility; if it needs two, the module should be split.
3. **大白话总览**: concrete analogy or trace, plus what the module explicitly does not do.
4. **关键概念**: terms that are easy to confuse, with project-specific meaning and an example.
5. **运行示例**: one real input and the actual objects, fields, messages, or events it produces inside this module.
6. **在链路中的位置**: upstream, downstream, and links to the corresponding steps in `00-full-chain`.
7. **文件路由 / 函数路由**: grouped by mechanism, not alphabetically; stable IDs, symbols, and source links.
8. **函数拆解**: for each key function, purpose, inputs, outputs, side effects, numbered internal steps, subfunctions, data changes, error branches, and the reason for non-obvious choices.
9. **数据变化**: the same data before, during, and after the module, preferably as a table or short trace.
10. **设计取舍**: why this design, what alternative was rejected, and what breaks under the alternative.
11. **自测**: questions with answers or source pointers.
12. **练习**: small runnable or observable changes, such as adding a log, changing a parameter, or drawing the data flow.
13. **常见误解**: misconception, correction, and the source evidence.
14. **继续阅读**: previous/next module, full-chain steps, and related traces.

Hard rules:

- A route table alone is not a module page.
- Examples must come from real code. Do not invent field names, event names, defaults, or error text.
- Distinguish compile-time TypeScript checks, runtime schema validation, and what tests actually prove. Do not claim a branch is tested when only the type permits it.
- Explain failure paths and cancellation, not only the success path.
- Use direct Chinese prose and no emojis.

## Page inventory and registration

| Page | Responsibility |
| --- | --- |
| `README.md` | Home page: material map, reading order, web/Markdown entry points. No module internals. |
| `COURSE.md` | Course map: learning paths, lesson order, time budget, self-checks, exercise sequence. |
| `00-full-chain/README.md` | One real query from CLI to answer, numbered steps S1-S13, cross-module links. |
| `01-entry-and-config/README.md` | Module 01 deep dive. |
| `02-agent-loop/README.md` | Module 02 deep dive; depth benchmark. |
| `03-session-and-context/README.md` | Module 03 deep dive. |
| `04-model-access/README.md` | Module 04 deep dive. |
| `05-modes-and-tui/README.md` | Module 05 deep dive. |
| `traces/README.md` | Cross-cutting lifecycles: a message, a tool call, a context, an event. |
| `GLOSSARY.md` | One term, one project-specific definition, aliases, and a source anchor. |
| `DEBUG_MAP.md` | Symptom -> layer -> data to inspect -> function/source route. |
| `GUIDE.md` | Authoring template, route conventions, generator notes, maintenance rules. |
| `index.html` | Generated single-file web version. Never edit by hand. |

A page that is not in the `PAGES` array at the top of `build.mjs` is not rendered, not navigable, and not link-checked. To add a page:

1. Create the Markdown file with real content.
2. Add `{ id, file, title, short, group }` to `PAGES` in `build.mjs`. `id` is the `#/id@anchor` route; keep it lowercase and stable.
3. Add the page to the `README.md` material map and the `COURSE.md` learning path.
4. Add it to the "继续阅读" of its neighbors.
5. Run `--check`, regenerate `index.html`, and verify the page button in the web version.

If a page is renamed, update `PAGES`, `README.md`, `COURSE.md`, and every relative link. Do not rename a route `id` casually; it is the web bookmark identity.

## Route IDs and anchors

Route ID format: `M<two-digit module>.<mechanism>.<action>`, for example `M02.loop.run` and `M03.store.projection`.

- One ID points to one symbol. Never rename an ID to follow a function rename; update the symbol and link instead.
- For overloaded functions, link the most representative entry line.
- Group route tables by mechanism, not by source file order.
- Source link format: `[agent.ts:668](../../../../../packages/agent/src/agent.ts#L668 "async prompt(input: string")`.
- The link title is not prose. It is the literal search anchor used by the checker. It must appear verbatim in the target file and should be unique; include `function`, `async`, or a distinctive part of the signature when a bare name is ambiguous.
- File-level routes omit `#L` and are only for "this whole file".
- Stable cross-page anchors use explicit HTML: `<a id="m02-walk-loop"></a>` immediately before the heading, linked as `../02-agent-loop/README.md#m02-walk-loop`. Do not rely on Chinese heading slugs; renderers differ. The generator rewrites registered `.md#anchor` links to `#/page@anchor`.
- Same-page anchors also need an explicit `id`; `--check` warns when it cannot find one.

Line drift:

```bash
node docs/learning/pi/modules-chain/build.mjs --check   # file existence, line bounds, literal anchors, ambiguity warnings
node docs/learning/pi/modules-chain/build.mjs --fix     # move label :line and URL #L to the nearest anchor match
node docs/learning/pi/modules-chain/build.mjs --check   # confirm clean
```

`--check` warnings about multiple matches are not automatically harmless: `--fix` picks the nearest line and can pick the wrong overload. Tighten the title anchor instead of ignoring the warning. Never bulk-add or subtract line numbers by hand. Review the `--fix` diff before accepting it.

## Parallel agents and file ownership

- Each agent owns a disjoint set of files. Read other pages freely; never edit them, even to fix a broken link. Report the broken link to its owner or the integrator.
- Never stage or commit files another agent changed. Stage explicit paths only; never `git add -A` or `git add .`.
- `build.mjs` and shared indexes (`README.md`, `COURSE.md`, `STUDY_PROGRESS.md`, `STUDY_LOG.md`) are conflict points. Assign one owner per shared file, or have the integrator apply all registration and log edits after the page writers stop.
- Do not run repository-wide formatting or `npm run check` while source writers are active. Freeze writers first, then run the repository checks.
- After merging parallel work, one integrator reruns `--check`, regenerates `index.html`, and inspects the exact staged paths.
- An unfinished draft stays out of the stage commit. Do not claim a page is complete because it has many Chinese lines; completeness means every required section is present, source was read in full, and links pass.

## Workflow

1. Define the page and its one concept. Read `GUIDE.md`, `README.md`, and a neighboring page.
2. Read the whole target source file and its key callees. Trace callers with `rg`; confirm types from source and `node_modules`, not from names.
3. Write an outline listing every required section, the route IDs, and the source lines you will link.
4. Write the content. Prefer a concrete trace: input -> steps -> data before/after -> output -> failure branch -> design reason.
5. Check every route: file exists, line is in range, title anchor is literal and unique, cross-page anchors have explicit `id`s.
6. Run `--check`. Fix all errors. Review every warning and tighten ambiguous anchors.
7. Run `--fix` only if line drift is real, then rerun `--check` and inspect the Markdown diff.
8. Regenerate the web version:

```bash
node docs/learning/pi/modules-chain/build.mjs
```

9. Preview. Open `index.html`, or use `--serve` when clicking source chips inside an IDE preview:

```bash
node docs/learning/pi/modules-chain/build.mjs --serve
node docs/learning/pi/modules-chain/build.mjs --serve --port=4918 --ide=pycharm
```

Verify page buttons, cross-page anchors, search entries, and that route chips open the right file and line. If the local opener is not running, clicking a chip should copy `path:line` rather than break the page.

10. Inspect the working tree:

```bash
git status --short
git diff --stat
```

Stage only your paths, then inspect `git diff --cached --stat` and the staged file list. Commit only when the user, the stage plan, or the learning-branch standing authorization allows it. Do not force push.

## Sync after upstream changes

- Do not switch branches, create worktrees, stash, or reset. If a rebase is required, resolve conflicts only in files you modified; if a conflict is in a file you did not modify, abort and ask.
- Inspect the actual range: `git log --oneline <reviewed-commit>..origin/main -- <paths>` and `git diff <reviewed-commit>..origin/main -- <paths>`. Read changed source files in full.
- Compare the changes against `docs/learning/pi/STUDY_PROGRESS.md` and the per-file coverage inventory. List every affected page, route, and example.
- Update explanations, examples, route line numbers, and anchors. Re-run `--check`, `--fix` if needed, regenerate `index.html`, and preview.
- Run the relevant package tests when behavior changed. Docs-only courseware changes do not need code tests, but a stage that includes code changes must run `npm run check` after writers freeze. Never run `npm test` unless asked; for non-e2e tests use `./test.sh`, or a specific Vitest file from the package root.
- Record the actual reviewed upstream commit in `docs/learning/pi/STUDY_LOG.md`, with the pages and checks performed. A passing `--check` only proves links and line numbers; it is not a semantic review. State what you actually read and verified.
- Update `STUDY_PROGRESS.md` and the coverage inventory only for work that belongs to the learning stage. Do not count generated, vendored, or partially annotated files as complete.

## Common failures

- `文件不存在 COURSE.md` or another missing page: a home-page link points at a page that has not been created or is owned by another agent. Create and register it only if it is yours; otherwise coordinate. Do not add an empty placeholder page.
- Page absent from web navigation: it is not in `PAGES`. Register it and regenerate `index.html`.
- `ERR_UNKNOWN_URL_SCHEME`: JCEF cannot follow `webstorm://`/`pycharm://` directly. Use the generated chips with `--serve`; use `--port=4918` on a port conflict. Do not replace chips with plain custom-protocol links.
- `--check` ambiguity warning: many lines contain the bare symbol. Extend the title anchor to a unique literal, then rerun `--fix` or adjust the line manually only after verifying the target.
- Cross-page anchor not found: the explicit `<a id="...">` is missing or misspelled, or the target page is not registered. The checker only resolves anchors for registered pages.
- Page button or `#/page@anchor` does not work: `id` in `PAGES`, the URL, and the page's anchors disagree. Fix the registration and regenerate.
- Hand-edited `index.html` is lost: rebuild from Markdown. Change `build.mjs` for generator behavior, never the output.
- Line numbers drift after a rebase: `--check`, then `--fix`, then inspect the diff. Do not mass-edit numbers.
- Invented fields or events: re-read the type declarations and the code that constructs the object. If the field exists only in a test fixture, say so.
- Route table only, no explanation: add the plain-language overview, function walkthrough, data changes, and design tradeoffs before considering the page done.

## Pre-commit checklist

- [ ] Only files owned by this agent changed; no source or generated-file edits.
- [ ] Target source read in full; callers, callees, types, and runtime validation verified.
- [ ] Page contains every required section; it is not just a route table.
- [ ] Examples use real code and real field names; no invented defaults or error text.
- [ ] Route IDs are stable; link titles are literal and unambiguous; cross-page anchors use explicit `id`s.
- [ ] New pages are registered in `PAGES`, `README.md`, and `COURSE.md`, and linked from neighbors.
- [ ] `node docs/learning/pi/modules-chain/build.mjs --check` reports 0 errors for owned pages; errors owned by others are reported, not hidden; every warning was reviewed.
- [ ] `index.html` regenerated; page buttons, anchors, search, and source chips verified in a preview.
- [ ] `git status --short` and the staged file list contain only owned paths.
- [ ] `STUDY_LOG.md` records the actual reviewed upstream commit and checks; `STUDY_PROGRESS.md` updated if the stage requires it.
- [ ] No secrets, tokens, credentials, or personal information.
