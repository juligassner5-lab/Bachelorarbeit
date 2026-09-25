# Dashboard — a generic visualization system for cyber exercises

Five visualization aspects — communication, task stack, event density, infrastructure state
and business impact — built entirely from a configuration file and three event files. The
dashboard code holds no scenario values: changing the exercise means swapping the four JSON
files, nothing else.

The datasets live in `Datenmodell/Daten/`, not in this folder, so the server is started
at the repository root.

## Starting

```
cd <repository root>
python -m http.server 8000
```

Then open in the browser: <http://localhost:8000/Implementierung/Dashboard/>

Alternatively with Node: `npx serve .` (also at the repository root).

Opening `index.html` directly by double-click does not work — the four JSON files are
loaded at runtime, and browsers block that for `file://` addresses.

### Showing a different exercise

The `?data=` parameter takes any path, relative to this folder:

```
http://localhost:8000/Implementierung/Dashboard/?data=test/scenario
```

Without the parameter, `../../Datenmodell/Daten` is loaded.

## Checker

Checks an exercise in two stages — first against the formal schema in
`Datenmodell/Schema/` (types, required fields, unknown field names), then by content
(valid references, vocabulary, working windows, task pairing, resolvable selectors):

```
node test/validate.js                # checks Datenmodell/Daten
node test/validate.js test/scenario  # checks the second stored exercise
```

If a file `test/expected/<exercise-id>.json` exists, event counts, durations and cost
totals are additionally compared against target values. The script also reports the
resulting diagram height and the playback duration.

After the exercise, it checks the four blank forms in `Datenmodell/Vorlagen/` by the same
rules, as a complete exercise. A template error does not abort the check of the actual
dataset.

Phase order, phase overlap and the business day are checked in `core.js` rather than here,
so they are reported in the browser as well.

The checker assumes this repository's layout. Set the `MODEL_DIR` environment variable to
point it at a data model kept somewhere else.

## Files

| File | Role |
|---|---|
| `index.html` | Skeleton: the five cards and the time controls |
| `dashboard.js` | Rendering of all five aspects |
| `core.js` | Derivation logic: ticks, durations, selectors, task pairing, costs. Shared by the dashboard and the checker |
| `lib/` | D3.js and dagre, kept locally — nothing is loaded from the network. Their licence notices are in `lib/THIRD-PARTY-NOTICES.txt` |
| `test/validate.js` | Checker |
| `test/schema-check.js` | Compact validator for the JSON Schema subset in use, without third-party dependencies |
| `test/expected/` | Target values per exercise |
| `test/scenario/` | A second, synthetic exercise |

## Configuring a different exercise

1. Copy the four blank forms from `Datenmodell/Vorlagen/` and fill them in. What each
   field means is explained in the `_note` entries of the forms themselves; the formal rules
   are in `Datenmodell/Schema/`.
2. Run `node test/validate.js <directory>` — it reports unknown field names, missing
   references, unknown states, events outside the working windows and selectors that
   cannot be resolved.
3. Open it in the browser with `?data=<directory>`.

**Time model:** events carry only a timestamp (narrated time, ISO 8601 without a time
zone). Ticks, durations and states are computed at runtime. `time_model.phases` are the
working windows — time outside them does not exist on the time axis, nights and breaks are
skipped. `narrative_end` is exclusive. `time_model.business_day` separately defines the
business day that durations in working hours and daily rates refer to.
