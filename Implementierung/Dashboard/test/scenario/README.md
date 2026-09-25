# Exercise 2 — NetzWerk Weserland GmbH

A second exercise, written against the same schema as exercise 1 and differing from it
in every dimension the configuration covers. It runs on the same code: no line of
`core.js`, `dashboard.js` or `index.html` was changed for it.

| | Exercise 1 | Exercise 2 |
|---|---|---|
| Actors | 8 | 15 |
| Components | 5 | 20 |
| Events | 80 | 797 |
| Phases | 5 | 10 |
| Ticks | 74 | 180 |
| Tick grid | 30 minutes | 60 minutes |
| Business day | 08:00–17:00 | 06:00–24:00 |
| Metrics | 4 | 9 |
| Cost items | 3 | 6 |

Its 797 events are 538 communication, 101 task start, 97 task end and 61 infrastructure
events. All 15 actors carry an explicit reading order and no color, so the palette
fallback assigns every one of them. Six of the nine metrics bind to infrastructure or
communication events, while all four metrics of exercise 1 bind to task events.

## Checking and viewing

```
cd ../..
node test/validate.js test/scenario
```

In the browser, with a static server running at the repository root:
<http://localhost:8000/Implementierung/Dashboard/?data=test/scenario>
