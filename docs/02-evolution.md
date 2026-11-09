# Design Evolution

This is a short, sanitized history of the design decisions behind Threadline. It is not a dump of private experiment logs.

## 1. Continuity first

The early prototype started with a continuity store:

```text
events
notes
personal state
workspaces
decisions
actions
receipts
```

The original question was not "how do we make a chatbot remember more?" but:

> How does an agent remain the same agent across turns, channels, and restarts?

That led to append-only events, explicit state changes, and receipts for actions.

## 2. Attention and memory were separated

The next iteration added attention and memory protocols.

A key rule emerged:

```text
a memory prompt is an opportunity, not an automatic summary
```

The system may say "there may be something worth remembering", but only the agent writes a note.

This prevented the runtime from quietly turning private context into a synthetic persona.

## 3. Long tasks and the office

A task engine added:

```text
goals
steps
checkpoints
next wake time
completion / abandonment
```

An office worker added:

```text
file reads and writes
restricted commands
npm
plugins
git / GitHub
audit logs
```

The task engine belongs to the brain. The office is an external workspace with its own boundary.

## 4. The context problem

The first context model was a global recent window:

```text
last 50 items
all channels mixed
```

That was simple, but it had a structural failure:

```text
a busy group can push a private conversation out of the window
```

Adding more context was not the answer. The answer was to distinguish:

```text
objective event stream
main cognition
attention threads
long-term memory
```

## 5. Main cognition is not a transcript

A person does not remember every line from a busy group. The same should hold for the agent.

The target model is:

```text
main cognition
  = filtered continuous state
  ≠ raw all-channel transcript
```

Threads hold detailed material. Main cognition holds the self's current continuity.

## 6. Workbench and suspension

The current design target is:

```text
max 8 channel threads
ordered by lastActivityAt
evict least recently active
mark suspended, not complete
drop exclusive material references
keep shared materials
keep the event stream
```

This avoids requiring the agent to know when a conversation has "ended".

## 7. Memory coverage

An earlier implementation treated a fixed recent window as if it were the memory summary window.

That was wrong:

```text
prompt time ≠ memory coverage
fixed window ≠ everything since last memory
```

The current implementation tracks pending received messages and builds a memory window from the last actual note. If the agent skips, the material remains.

## 8. What is still design work

The following are not complete in this skeleton:

```text
8-thread workbench
LRU suspension
reference-counted material ownership
main-cognition filter
automatic per-scene context gap detection
full history browser
```

They are documented so the next person can continue from the design rather than rediscover the same failures.
