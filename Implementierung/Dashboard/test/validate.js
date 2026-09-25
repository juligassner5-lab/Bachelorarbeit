#!/usr/bin/env node
// validate.js — checks an exercise (configuration plus event files) against schema and content rules.
'use strict';

const fs = require('fs');
const path = require('path');
const Core = require('../core.js');
const SchemaCheck = require('./schema-check.js');

// Layout of the surrounding repository. The defaults match this repository; set
// MODEL_DIR to point the checker at a data model kept anywhere else.
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const modelDir = process.env.MODEL_DIR
  ? path.resolve(process.env.MODEL_DIR)
  : path.join(repoRoot, 'Datenmodell');
const schemaDir = path.join(modelDir, 'Schema');
const templateDir = path.join(modelDir, 'Vorlagen');
const base = path.resolve(process.argv[2] || path.join(modelDir, 'Daten'));

const KINDS = Core.SOURCES;

function readJSON(file, label) {
  if (!fs.existsSync(file)) { console.error('File missing: ' + file); process.exit(2); }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('Invalid JSON in ' + (label || file) + ': ' + e.message); process.exit(2); }
}

const scenarioSchema = readJSON(path.join(schemaDir, 'scenario.schema.json'));
const eventsSchema = readJSON(path.join(schemaDir, 'events.schema.json'));

/* --- Stage 1: formal schema --- */
function checkSchema(config, sources, names) {
  const problems = [];
  SchemaCheck.validate(config, scenarioSchema, scenarioSchema, names.config)
    .forEach(m => problems.push(m));
  KINDS.forEach(kind => {
    SchemaCheck.validate(sources[kind], eventsSchema.$defs[kind], eventsSchema, names[kind])
      .forEach(m => problems.push(m));
  });
  return problems;
}

/* --- Stage 2: content rules --- */
function checkContent(config, sources) {
  const errors = [];
  const warnings = [];
  const fail = m => errors.push(m);
  const warn = m => warnings.push(m);
  const result = { errors, warnings, ds: null, pairs: [], openTasks: [], metrics: {}, costs: null };

  // Event files must belong to the exercise declared in scenario.json.
  KINDS.forEach(kind => {
    if (sources[kind].exercise !== config.exercise?.id) {
      fail(`${kind}.json: exercise "${sources[kind].exercise}" does not match scenario.json ` +
        `(exercise.id "${config.exercise?.id}") — files from two different runs mixed up?`);
    }
  });

  try { result.ds = Core.buildDataset(config, sources); }
  catch (e) { fail('Time axis could not be built: ' + e.message); return result; }
  const ds = result.ds;

  const actorIds = new Set(config.actors.map(a => a.id));
  const componentIds = new Set((config.components || []).map(c => c.id));
  const controlIds = new Set(Object.values(config.control_ids || {}));
  const stateNames = new Set((config.vocabulary?.component_states || []).map(s => s.name));
  const isKnownParty = id => actorIds.has(id) || controlIds.has(id) || componentIds.has(id);

  // Reported once, not once per component, when vocabulary is missing entirely.
  const vocabularyMissing = (config.components || []).length > 0 && !config.vocabulary;
  if (vocabularyMissing) {
    fail('components is configured but vocabulary is missing — every declared state would need a traffic-light color');
  }

  // Referential integrity of the configuration
  (config.components || []).forEach(c => {
    if (!vocabularyMissing && !stateNames.has(c.initial_state)) fail(`Component "${c.id}": initial_state "${c.initial_state}" is not in the vocabulary`);
    (c.depends_on || []).forEach(d => {
      if (!componentIds.has(d)) fail(`Component "${c.id}": depends_on references unknown component "${d}"`);
      if (d === c.id) fail(`Component "${c.id}": depends on itself`);
    });
  });

  // A cycle would make the layered layout in aspect 4 impossible
  (function detectCycles() {
    const graph = new Map((config.components || []).map(c => [c.id, c.depends_on || []]));
    const state = new Map();
    const visit = (id, stack) => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'open') { fail('Cycle in the dependency graph: ' + stack.concat(id).join(' -> ')); return; }
      state.set(id, 'open');
      (graph.get(id) || []).forEach(n => { if (graph.has(n)) visit(n, stack.concat(id)); });
      state.set(id, 'done');
    };
    [...graph.keys()].forEach(id => visit(id, []));
  })();

  const categoryIds = new Set((config.cost_categories || []).map(c => c.id));
  const metricById = new Map((config.metrics || []).map(m => [m.id, m]));
  (config.costs || []).forEach(c => {
    if (!categoryIds.has(c.category)) fail(`Cost item "${c.id}": unknown category "${c.category}"`);
    const metric = metricById.get(c.span?.metric);
    if (!metric) {
      fail(`Cost item "${c.id}": span.metric references an unknown metric`);
    } else if (metric.start?.pick === 'count' || !metric.end) {
      fail(`Cost item "${c.id}": metric "${metric.id}" has no time span (count metric), a rate cannot be applied to it`);
    }
    if (c.rate_per_hour == null && c.rate_per_workday == null && c.flat_fee == null) {
      fail(`Cost item "${c.id}": no rate defined (rate_per_hour, rate_per_workday or flat_fee)`);
    }
  });

  // Working window — the one rule that applies to every data type alike
  ds.all.forEach(e => {
    if (e._tick === null) fail(`${e._source} "${e.id}": time ${e.time} falls outside every working window`);
  });

  ds.events.communication.forEach(e => {
    if (!actorIds.has(e.from)) fail(`communication "${e.id}": sender "${e.from}" is not an actor — only actors have a lifeline in aspect 1`);
    if (!actorIds.has(e.to)) fail(`communication "${e.id}": recipient "${e.to}" is not an actor — only actors have a lifeline in aspect 1`);
    if (e.from === e.to) fail(`communication "${e.id}": sender and recipient are identical ("${e.from}")`);
  });

  ds.events.tasks.forEach(e => {
    if (!actorIds.has(e.from)) fail(`tasks "${e.id}": task sender "${e.from}" is not an actor`);
    if (!isKnownParty(e.to)) fail(`tasks "${e.id}": unknown recipient "${e.to}"`);
  });

  ds.events.infrastructure.forEach(e => {
    if (!isKnownParty(e.from)) fail(`infrastructure "${e.id}": unknown sender "${e.from}"`);
    if (!isKnownParty(e.to)) fail(`infrastructure "${e.id}": unknown recipient "${e.to}"`);
    if (!componentIds.has(e.component)) fail(`infrastructure "${e.id}": unknown component "${e.component}"`);
    if (!vocabularyMissing && !stateNames.has(e.state)) fail(`infrastructure "${e.id}": state "${e.state}" is not in the vocabulary`);
  });

  // Task pairing
  result.pairs = Core.pairTasks(ds);
  result.pairs.filter(p => p.orphanEnd).forEach(p => {
    fail(`Task "${p.task}" of "${p.actor}": end without a matching start`);
  });
  result.openTasks = result.pairs.filter(p => p.open);
  result.pairs.filter(p => !p.open && !p.orphanEnd && p.endMinutes < p.startMinutes).forEach(p => {
    fail(`Task "${p.task}" of "${p.actor}": end lies before the start`);
  });

  // Minimum gap between events an actor produces itself.
  const gap = config.time_model.min_event_gap_minutes;
  if (gap) {
    const perActor = {};
    ds.events.communication.concat(ds.events.tasks).forEach(e => {
      if (!actorIds.has(e.from)) return;
      (perActor[e.from] = perActor[e.from] || []).push(e);
    });
    Object.keys(perActor).forEach(id => {
      const list = perActor[id].sort((a, b) => a._minutes - b._minutes);
      for (let i = 1; i < list.length; i++) {
        const delta = list[i]._minutes - list[i - 1]._minutes;
        if (delta < gap) {
          warn(`Actor "${id}": only ${delta} min between two self-generated events (${list[i - 1].time} / ${list[i].time}), minimum gap ${gap} min`);
        }
      }
    });
  }

  // Every configured selector must find something.
  try {
    (config.metrics || []).forEach(m => {
      if (m.end && m.end.pick === 'count') {
        fail(`Metric "${m.id}": selector "end" must not be a count metric (pick:"count"), ` +
          'only "start" can count');
      }
      ['start', 'end'].forEach(k => {
        if (!m[k]) return;
        const allowedFields = Object.keys(eventsSchema.$defs[m[k].source]?.properties?.events?.items?.properties || {})
          .filter(f => f !== '_note');
        const unknownFields = Object.keys(m[k].where || {}).filter(f => !allowedFields.includes(f));
        if (unknownFields.length) {
          fail(`Metric "${m.id}": selector "${k}" uses unknown field(s) ${unknownFields.map(f => `"${f}"`).join(', ')} ` +
            `in "where" (allowed for ${m[k].source}: ${allowedFields.join(', ')})`);
          return;
        }
        const hit = Core.resolveSelector(m[k], ds);
        if (hit === null) {
          fail(`Metric "${m.id}": selector "${k}" finds no matching event`);
        } else if (m[k].pick === 'count' && hit.count === 0) {
          warn(`Metric "${m.id}": count selector "${k}" finds no event, the tile shows 0 — typo in the filter?`);
        }
      });
    });
    result.metrics = Core.computeMetrics(ds);
    result.costs = Core.computeCosts(ds, result.metrics, null);
  } catch (e) {
    fail('Computation failed: ' + e.message);
  }

  return result;
}

/* --- Stage 3: target values (optional) --- */
function checkExpected(config, run) {
  const file = path.join(__dirname, 'expected', (config.exercise?.id || 'unknown') + '.json');
  if (!fs.existsSync(file)) return null;
  const expected = readJSON(file);
  const { ds, metrics, costs, errors } = run;
  const check = (label, actual, target, tolerance) => {
    if (actual == null) { errors.push(`Target "${label}": no actual value computed`); return; }
    if (Math.abs(actual - target) > tolerance) {
      errors.push(`Target "${label}": expected ${target}, computed ${Math.round(actual * 100) / 100}`);
    }
  };
  if (expected.event_counts) {
    check('Total events', ds.all.length, expected.event_counts.total, 0);
    check('Communication', ds.events.communication.length, expected.event_counts.communication, 0);
    check('Infrastructure', ds.events.infrastructure.length, expected.event_counts.infrastructure, 0);
    check('Task start', ds.events.tasks.filter(e => e.event === 'start').length, expected.event_counts.task_start, 0);
    check('Task end', ds.events.tasks.filter(e => e.event === 'end').length, expected.event_counts.task_end, 0);
  }
  if (expected.total_ticks != null) check('Total ticks', ds.timeline.totalTicks, expected.total_ticks, 0);
  Object.entries(expected.metric_hours || {}).forEach(([id, target]) => {
    check(`Duration "${id}"`, metrics[id] ? metrics[id].hours : null, target, 0.01);
  });
  Object.entries(expected.metric_counts || {}).forEach(([id, target]) => {
    check(`Count "${id}"`, metrics[id] ? metrics[id].count : null, target, 0);
  });
  Object.entries(expected.cost_amounts || {}).forEach(([id, target]) => {
    check(`Cost "${id}"`, costs?.perCost[id]?.amount, target, 1);
  });
  Object.entries(expected.category_totals || {}).forEach(([id, target]) => {
    check(`Category total "${id}"`, costs?.perCategory[id], target, 1);
  });
  if (expected.grand_total != null) check('Grand total', costs?.total, expected.grand_total, 1);
  return expected;
}

/* --- Output --- */
function reportRun(config, run, expected) {
  const { ds, pairs, openTasks, metrics, costs } = run;
  console.log('\n=== ' + (config.exercise?.name || base) + ' ===');
  console.log('Source      : ' + path.relative(repoRoot, base).replace(/\\/g, '/'));
  if (ds) {
    console.log(`Time axis   : ${ds.timeline.totalTicks} ticks of ${ds.timeline.tickMinutes} min in ${ds.timeline.phases.length} phases`);
    ds.timeline.phases.forEach(p => {
      console.log(`              ${p.label.padEnd(18)} Tick ${String(p.firstTick).padStart(3)}–${String(p.firstTick + p.ticks - 1).padStart(3)}  (${Core.formatClock(p.start)}–${Core.formatClock(p.end)}, ${p.ticks} ticks)`);
    });

    const ms = config.time_model.playback_ms_per_tick || 1000;
    const seconds = Math.round(ds.timeline.totalTicks * ms / 1000);
    const diagramHeight = Core.sequenceDiagramHeight(ds);
    console.log(`Size        : sequence diagram ${diagramHeight} px high · ` +
      `Playback ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} min at ${ms} ms/tick`);

    console.log(`Actors      : ${config.actors.length}   Components: ${(config.components || []).length}`);
    console.log(`Events      : ${ds.all.length} (${ds.events.communication.length} communication, ` +
      `${ds.events.tasks.filter(e => e.event === 'start').length} task start, ` +
      `${ds.events.tasks.filter(e => e.event === 'end').length} task end, ` +
      `${ds.events.infrastructure.length} infrastructure)`);
    if (pairs.length) {
      console.log(`Tasks       : ${pairs.length} paired, ${openTasks.length} still open at the end`);
    }
    if (Object.keys(metrics).length) {
      console.log('Metrics     :');
      Object.values(metrics).forEach(m => {
        const value = m.count != null ? `${m.count}` : (m.hours != null ? `${Math.round(m.hours * 100) / 100} ${m.unit}` : '—');
        console.log(`              ${m.label.padEnd(24)} ${value}`);
      });
    }
    if (costs) {
      console.log('Costs       :');
      Object.values(costs.perCost).forEach(c => {
        console.log(`              ${(c.label || c.id).padEnd(24)} ${Core.formatEuro(c.amount)}`);
      });
      (config.cost_categories || []).forEach(cat => {
        console.log(`              ${('Σ ' + cat.label).padEnd(24)} ${Core.formatEuro(costs.perCategory[cat.id])}`);
      });
      console.log(`              ${'Σ Total'.padEnd(24)} ${Core.formatEuro(costs.total)}`);
    }
  }
  if (run.warnings.length) {
    console.log('\nNotes (' + run.warnings.length + '):');
    run.warnings.forEach(w => console.log('  ! ' + w));
  }
  if (run.errors.length) {
    console.log('\nERRORS (' + run.errors.length + '):');
    run.errors.forEach(e => console.log('  x ' + e));
  } else {
    console.log('\nOK — schema and content are free of errors.' + (expected ? ' Target values match.' : ' (no target-value file present)'));
  }
  console.log('');
}

/* --- Main run --- */
const config = readJSON(path.join(base, 'scenario.json'));
const sources = {};
KINDS.forEach(kind => { sources[kind] = readJSON(path.join(base, kind + '.json')); });

const schemaProblems = checkSchema(config, sources, {
  config: 'scenario.json', communication: 'communication.json',
  tasks: 'tasks.json', infrastructure: 'infrastructure.json'
});

let run;
let expected = null;
if (schemaProblems.length) {
  run = { errors: schemaProblems.map(m => 'Schema: ' + m), warnings: [], ds: null, pairs: [], openTasks: [], metrics: {}, costs: null };
} else {
  run = checkContent(config, sources);
  if (!run.errors.length) expected = checkExpected(config, run);
}
reportRun(config, run, expected);

// Templates checked with the same rules, after the main run.
function checkTemplates() {
  const files = {
    config: path.join(templateDir, 'scenario.template.json'),
    communication: path.join(templateDir, 'communication.template.json'),
    tasks: path.join(templateDir, 'tasks.template.json'),
    infrastructure: path.join(templateDir, 'infrastructure.template.json')
  };
  if (Object.values(files).some(f => !fs.existsSync(f))) return null;

  const tConfig = readJSON(files.config);
  const tSources = {};
  KINDS.forEach(kind => { tSources[kind] = readJSON(files[kind]); });

  const names = {
    config: 'scenario.template.json', communication: 'communication.template.json',
    tasks: 'tasks.template.json', infrastructure: 'infrastructure.template.json'
  };
  const problems = checkSchema(tConfig, tSources, names).map(m => 'Schema: ' + m);
  if (problems.length) return { errors: problems, warnings: [] };
  const t = checkContent(tConfig, tSources);
  return { errors: t.errors, warnings: t.warnings };
}

const templates = checkTemplates();
if (templates) {
  console.log('--- Templates (' + path.relative(repoRoot, templateDir).replace(/\\/g, '/') + ') ---');
  if (templates.warnings.length) templates.warnings.forEach(w => console.log('  ! ' + w));
  if (templates.errors.length) {
    console.log(`ERRORS (${templates.errors.length}) — the template set is not valid as a starting point:`);
    templates.errors.forEach(e => console.log('  x ' + e));
  } else {
    console.log('OK — the four blank forms together form a valid exercise.');
  }
  console.log('');
}

process.exit((run.errors.length || templates?.errors.length) ? 1 : 0);
