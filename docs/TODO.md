# TODO

## 1. Approval gate: live end-to-end verification

The gate is wired and unit-pinned (304 tests) but has never run against a live
agy turn. Enable it, drive an agy turn that mutates a file, and watch the
round trip: PreToolUse hook -> POST /approval park -> shadow toolUse ->
decision -> hook stdout -> agy enforces.

- Enable without a third-party extension: `AGY_APPROVALS=shadow AGY_APPROVALS_MODE=ask` (interactive pi; headless denies). Deny path: a fake gate extension that blocks marker calls (`pi.on("tool_call")` + `{block: true, reason}`).
- Probe artifacts live outside the repo: `~/tmp/pi-antigravity-bridge-probes/` (run scripts via `npx tsx` from the repo cwd - they import src/*.ts).
- Live-behavior risks to watch: hook timeout soft-passes (V3) - the staged timeout must keep exceeding the park budget; denied calls emit no `tool_call` session/update frames on ACP (V2); edit-class arg names beyond `create_file` are docs-attested, never live-captured - check the confirm-dialog text on a real `run_command` and a real `replace_file_content`.
- On pass: clear the "NOT yet live-verified" notes (AGENTS.md, this file).

## 2. Explicit `antigravity_approve` variant (dedicated mode)

`approvals.gateMode: "dedicated"` currently stages the same shadow tools
(warn-logged remap). Planned: one registered tool `antigravity_approve` with
input `{toolName, args}`, for setups that prefer explicit names (gotgenes
`shellTools` alias users). Full v2 spec preserved in git history:
`dd7845b:docs/TODO.md` (sections 2.1-2.9).
