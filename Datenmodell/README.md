# Data Model

An exercise is four JSON files: one configuration and three event files, one each for
communication, task and infrastructure events. The configuration states what the
exercise consists of, the event files state what happened while it was played. A change
of exercise is an exchange of these four files.

## Contents

| Folder | Contents |
|---|---|
| `Schema/` | `scenario.schema.json` for the configuration, `events.schema.json` for the three event files |
| `Vorlagen/` | Four blank forms. What each field means is explained in their `_note` entries |
| `Daten/` | Exercise 1, TauernRad AG, filled in |

## Files of an exercise

| File | Holds |
|---|---|
| `scenario.json` | Actors, control identifiers, components with their dependencies, time model, permitted component states, metrics, cost rates |
| `communication.json` | Messages between two actors: `subject`, optional `body` |
| `tasks.json` | Task reports: `task` and `event`, the latter `start` or `end` |
| `infrastructure.json` | Status messages: `component` and `state` |

Every event carries `id`, `time`, `from` and `to`. Times are narrated time, ISO 8601
without a time zone. Ticks, durations and component states are computed at runtime and
are stored in no file.

## Exercise 1 — TauernRad AG

| | |
|---|---|
| Actors | 8 |
| Components | 5 |
| Events | 80 — 28 communication, 22 task start, 19 task end, 11 infrastructure |
| Tasks | 22 paired, 3 still open at the end |
| Phases | 5, covering ticks 1–74 |
| Tick grid | 30 minutes |
| Business day | 08:00–17:00 |
| Metrics | 4 |
| Cost items | 3 |

## Checking

```
cd ../Implementierung/Dashboard
node test/validate.js
```

The checker validates this folder against `Schema/`, then by content, and finally
against the target values in `test/expected/tauernrad-run-1.json`. The four blank forms
in `Vorlagen/` are checked by the same rules afterwards.
