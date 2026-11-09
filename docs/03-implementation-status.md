# Implementation Status

This skeleton is a source framework, not a finished agent.

## Implemented

```text
event store and immutable event identities
recent-context projection as a session board
  (current chat in full + every other live chat with unread / waiting / preview)
subject lock: chat turns, task wakes, memory updates and maintenance commit one at a time
stale-commit replay on fresh state; dropped state changes reported back as hostNotices
shared rhythm / daily budget across all chats
burst coalescing: consecutive unread messages in one chat are read and answered in one turn
configurable capacities (app/src/limits.mjs) with automatic shrink on input overflow
node:test suite (npm test) and packet dump tool (npm run dump-packet)
memory opportunity and memory window
task store, steps, checkpoints, terminal transitions
scheduler / task wake
office worker and watchdog
QQ/OneBot bridge
GitHub minimal-permission client
plugin install/run
UI and launch scripts
```

## Implemented but limited

```text
main cognition
  Currently the code uses the session board (recent-context-v2): the current chat in
  full plus a session list of all other live chats. It is a structured view, not yet
  a separately filtered main-cognition layer.

memory window
  Includes received messages, responses, and terminal actions.
  Coverage advances only after a note is actually created.
  A window is capped at THREADLINE_MEMORY_WINDOW_ITEMS (default 40) displayed items
  and reports omitted items.

attention threads
  The design is specified, but the 8-thread workbench and LRU suspension
  are not implemented in this skeleton.

office worker
  Logical workspace and command allowlist, not an OS-level sandbox.
  Command execution tools are off unless THREADLINE_OFFICE_EXEC=1.

plugins
  Manifest validation and a separate child process, not a hard sandbox.
```

## Not included

```text
real memory database
persona card
API keys / tokens
QQ account data
chat logs
private experiments
evaluation artifacts
DSH harness source
```

## Relationship to DSH

DSH is an external harness/client environment.

Threadline includes an office worker and an office client that a harness can call. It does not vendor DSH itself.

## What the next contributor should preserve

```text
events are append-only
memory is written, not extracted
context is bounded
threads are projections, not separate selves
suspension is not deletion
shared material must survive eviction
```

## Open questions

1. How should main cognition select and compress events without hiding important continuity?
2. How should a channel thread be reactivated after suspension?
3. When a task spans multiple channels, which thread owns the material?
4. Should muted messages be searchable later?
5. How do we evaluate whether the agent's memory is useful rather than merely large?

These are design questions, not bugs to hide.
