# Threadline Philosophy

## The problem

Most agent systems collapse four different things into one:

```text
what happened
what the agent is paying attention to now
what the agent remembers
what the agent is trying to do
```

That works for short chats. It fails when an agent has many channels, long tasks, and a history larger than a context window.

Threadline separates them.

## Four layers

### 1. Objective event stream

Every real inbound message, response, tool action, and receipt is an event.

Events are:

```text
append-only
individually addressable
timestamped
searchable
not automatically remembered
```

This is the factual archive. It is not the agent's memory.

### 2. Main cognition

Main cognition is the agent's filtered, continuous cognitive state.

It is not a copy of every message. Like a person in a busy group chat, the agent does not retain every line. It retains:

```text
what it just did
who it just spoke to
what is currently relevant
what remains unresolved
```

The target bound is about 50 recent cognitive items, not 50 raw messages from every channel.

### 3. Attention threads

An attention thread is a focused view over one channel.

```text
thread = channel projection + material references
default backfill = latest 30 messages, both sides
```

Threads are material views, not separate selves.

The proposed workbench holds at most 8 active threads. When full, the least recently active thread is suspended, not marked complete. Its exclusive material references leave the workbench; shared references stay.

### 4. Long-term memory

Long-term memory is what the agent explicitly writes:

```text
notes
people and relationships
self-state
beliefs and goals
```

It is not an automatic summary of the event stream.

## One self, many threads

There is one subject and one continuous self.

```text
one subject
  ├─ main cognition
  ├─ attention thread A
  ├─ attention thread B
  └─ ...
```

Multiple threads are states, not multiple agents. At any moment, the model receives:

```text
current event
+ main cognition
+ focused thread material
+ metadata for other active threads
+ memory and task state
```

It does not receive eight full conversations at once.

## Ownership and forgetting

Dropping something from the workbench is not deleting history.

```text
thread suspension:
  remove workbench references
  keep event stream
  keep long-term memory
  keep shared material
```

Material can be owned by a thread or a task. When a task completes or suspends, its ownership is released. A material with another active owner remains.

## Memory is written, not extracted

The system may offer a memory opportunity. It does not decide what the agent remembers.

```text
system: here is a memory window
agent:  write a note, skip, or continue
```

No hidden extraction. No automatic persona. No silent "summary" presented as memory.

## Why this matters

The design goal is not to make a chatbot with a bigger context window.

It is to make a runtime where:

- facts remain recoverable;
- attention can move without losing the self;
- memory has an owner;
- long tasks survive restarts;
- another person can replace the identity without inheriting someone else's history.
