# Visualizing Cyber Exercise Progress — Artifacts

Data model and dashboard prototype accompanying the bachelor's thesis
*Visualizing Cyber Exercise Progress: A Scenario-Based Prototype* by Julius Gaßner.

A cyber exercise is described by four JSON files. The dashboard renders five
visualization aspects — communication, task stack, event density, infrastructure state
and business impact — from those files alone and holds no value of its own for any
exercise it displays. Two exercises are stored here and run on the same code.

## Contents

| Folder | Contents |
|---|---|
| `Datenmodell/Schema/` | The formal rules: fields, types, required entries, permitted values |
| `Datenmodell/Vorlagen/` | Four blank forms, one per file, for a new exercise |
| `Datenmodell/Daten/` | Exercise 1 — TauernRad AG |
| `Implementierung/Dashboard/` | The prototype and the checker |
| `Implementierung/Dashboard/test/scenario/` | Exercise 2 — NetzWerk Weserland GmbH |

## Requirements

Node, tested with 22.15, and any static file server. Nothing else: the code has no
package dependencies, and D3.js and dagre are included in `Implementierung/Dashboard/lib/`,
with their licence notices in `Implementierung/Dashboard/lib/THIRD-PARTY-NOTICES.txt`.

## Running the checker

```
cd Implementierung/Dashboard
node test/validate.js                # exercise 1
node test/validate.js test/scenario  # exercise 2
```

Each run checks the four files against the schema and the content rules, then compares
the computed event counts, metric durations and cost sums against the stored target
values in `test/expected/`. It exits non-zero on any mismatch, so a successful run
reproduces the figures reported in the thesis.

## Opening the dashboard

Start a static server in the folder that contains this README. After extracting
the ZIP from GitHub, this is usually the inner of two `Bachelorarbeit-main` folders.

```
python -m http.server 8000
```

The server keeps running; leave the terminal open. Then open
<http://localhost:8000/Implementierung/Dashboard/> for exercise 1, or
<http://localhost:8000/Implementierung/Dashboard/?data=test/scenario> for exercise 2.

Opening `index.html` by double-click does not work: the four JSON files are loaded at
runtime, and browsers block that for `file://` addresses.
