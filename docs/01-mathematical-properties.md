# Mathematical Properties

This document gives a small formal model and the properties we rely on.

It separates:

```text
implemented invariants
design specifications not yet implemented
```

## 1. Model

Let an event be:

```text
e = (id, t, source, actor, body, origin, hash)
```

Let the event store be a partial function:

```text
S : EventId -> Event
```

Let a context projection be:

```text
C = Project(S, current, recent, continuity)
```

Let a memory-window projection be:

```text
M = MemoryWindow(S, coverage, pending)
```

## 2. Implemented properties

### P1 — Event identity is immutable

For an existing event id `i`:

```text
append(S, e) with e.id = i
  => require e.hash = S(i).hash
  => return S(i)
```

No command updates an event body in place.

**Why it holds:** the event writer checks the existing record and its input hash before returning it. A differing payload is rejected. Projections are read-only.

**Consequence:** two projections cannot disagree about what the original event said.

### P2 — Recent context is bounded

Let `R` be the recent context list and `B` its byte budget.

```text
|R| <= 50
bytes(R) <= 20KB
```

**Why it holds:** selection takes the latest `limit` items and then removes the oldest items while the serialized size exceeds the budget.

**Consequence:** context growth cannot exceed the configured bound.

### P3 — Memory counting is sound

A message is counted only if all hold:

```text
it is a new event
it is not from a muted scene
it has a received subject observation
it is not a duplicate delivery
```

Actions, tool receipts, the agent's own responses, and muted messages are not counted.

**Why it holds:** the muted branch returns before counting; duplicate detection checks the event before ingest; the counter is incremented only for a newly created, received observation.

**Consequence:** the memory trigger is a function of received messages, not of all system activity.

### P4 — A skipped memory window is not silently lost

Let `P` be the pending message-id queue.

```text
append(P, id) does not drop old ids
```

The memory window may display only the first `K` items, but it reports:

```text
count
items
truncated
omitted
```

If the agent writes no note, `P` is unchanged.

**Why it holds:** pending ids are appended without a fixed-size truncation; the window reports omitted count instead of pretending completeness.

**Consequence:** a capped read does not imply a capped archive.

### P5 — Coverage advances only on an actual note

A memory opportunity does not automatically advance coverage.

```text
coverage advances
  iff a new note is created
```

When it advances:

```text
only message ids included in the window are removed from P
coverage time becomes the maximum included item time
```

Omitted messages remain pending. If the note action fails, no new note exists and coverage does not advance.

**Why it holds:** coverage is computed from the note count before and after execution.

**Consequence:** "prompt shown" is not confused with "memory written".

### P6 — Task terminal states close their plan

When a task becomes terminal:

```text
done      => pending/running steps become done
abandoned => unfinished steps become skipped
currentStep, nextStep, nextWakeAt become null
```

**Why it holds:** the task service normalizes terminal transitions before persisting.

**Consequence:** a closed task cannot keep waking the scheduler for a stale step.

## 3. Design specifications, not yet implemented

These are the target properties for the attention-thread layer.

### P7 — One subject, many projections

All thread packets and the main cognition packet share one `subjectId`.

```text
threads are projections of S
threads do not own separate identities
```

The current framework has one global subject. The 8-thread workbench is a design target.

### P8 — Workbench capacity and suspension

Let `T` be active threads.

```text
|T| <= 8
```

On overflow, evict the thread with the smallest `lastActivityAt`.

```text
on eviction:
  status = suspended
  remove exclusive workbench references
  retain references with another active owner
  retain S and long-term memory
```

**Status:** specified, not implemented in this skeleton.

### P9 — Material ownership is reference-counted

A material may be owned by multiple threads or tasks.

```text
release(owner):
  remove that owner's binding
  keep the material if another active binding exists
  remove only the workbench reference when no active binding remains
```

**Status:** specified, not implemented in this skeleton.

## 4. What these properties do not prove

They do not prove:

- that the model will choose the right action;
- that the agent's self-report is accurate;
- that memory content is true;
- that long-chain planning always succeeds;
- that the current attention implementation is complete.

They are structural guarantees about storage, projection, bounds, and ownership. Semantic quality remains an empirical question.
