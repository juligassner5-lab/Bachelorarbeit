// core.js — derivation logic: ticks, states, durations, costs.
// Shared by dashboard.js (browser) and test/validate.js (Node).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* --- Time --- */
  function toMinutes(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
    if (!m) throw new Error('Invalid timestamp: ' + iso);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
  }

  function clockToMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!m) throw new Error('Invalid time of day: ' + hhmm);
    return +m[1] * 60 + +m[2];
  }

  function dayStartMinutes(minutes) {
    return Math.floor(minutes / 1440) * 1440;
  }

  function formatClock(minutes) {
    const inDay = ((minutes % 1440) + 1440) % 1440;
    const h = Math.floor(inDay / 60), mi = inDay % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  }

  function formatEuro(n) {
    return Math.round(n).toLocaleString('de-DE') + ' €';
  }

  /* --- Timeline --- */
  function buildTimeline(config) {
    const tm = config.time_model;
    if (tm.business_day) businessWindow(tm.business_day);
    const size = tm.tick_minutes;
    let offset = 0;
    const phases = tm.phases.map((p, i) => {
      const start = toMinutes(p.narrative_start);
      const end = toMinutes(p.narrative_end);
      if (end <= start) throw new Error('Phase "' + p.label + '": narrative_end is not after narrative_start');
      const ticks = Math.ceil((end - start) / size);
      const entry = { index: i, label: p.label, start: start, end: end, ticks: ticks, firstTick: offset + 1 };
      offset += ticks;
      return entry;
    });
    for (let i = 1; i < phases.length; i++) {
      if (phases[i].start < phases[i - 1].start) {
        throw new Error('Phases are not in chronological order: "' + phases[i].label +
          '" starts before "' + phases[i - 1].label + '" and must come before it in the configuration');
      }
      if (phases[i].start < phases[i - 1].end) {
        throw new Error('Phases overlap: "' + phases[i - 1].label + '" and "' + phases[i].label + '"');
      }
    }

    // Finds the phase containing a given tick or minute.
    function phaseContainingTick(tick) {
      for (const ph of phases) {
        if (tick >= ph.firstTick && tick < ph.firstTick + ph.ticks) return ph;
      }
      return null;
    }

    function phaseContainingMinutes(minutes) {
      for (const ph of phases) {
        if (minutes >= ph.start && minutes < ph.end) return ph;
      }
      return null;
    }

    function tickOf(iso) {
      const t = toMinutes(iso);
      const ph = phaseContainingMinutes(t);
      if (!ph) return null;
      return ph.firstTick + Math.floor((t - ph.start) / size);
    }

    function timeOfTick(tick) {
      const ph = phaseContainingTick(tick);
      if (!ph) return null;
      return ph.start + (tick - ph.firstTick) * size;
    }

    function labelOfTick(tick) {
      const ph = phaseContainingTick(tick);
      if (!ph) return '';
      return ph.label + ', ' + formatClock(ph.start + (tick - ph.firstTick) * size);
    }

    return {
      phases: phases,
      tickMinutes: size,
      totalTicks: offset,
      tickOf: tickOf,
      timeOfTick: timeOfTick,
      labelOfTick: labelOfTick
    };
  }

  /* --- Business hours --- */
  function businessWindow(businessDay) {
    const start = clockToMinutes(businessDay.start);
    const end = clockToMinutes(businessDay.end);
    if (end <= start) {
      throw new Error('Business day "' + businessDay.start + '-' + businessDay.end +
        '": the end must be after the start, a day rollover is not supported');
    }
    return { start: start, end: end };
  }

  function businessMinutesBetween(fromMin, toMin, businessDay) {
    const win = businessWindow(businessDay);
    if (toMin <= fromMin) return 0;
    const dayStart = win.start;
    const dayEnd = win.end;
    let total = 0;
    for (let day = dayStartMinutes(fromMin); day <= dayStartMinutes(toMin); day += 1440) {
      const winStart = day + dayStart, winEnd = day + dayEnd;
      const a = Math.max(fromMin, winStart), b = Math.min(toMin, winEnd);
      if (b > a) total += b - a;
    }
    return total;
  }

  function workdayHours(businessDay) {
    const win = businessWindow(businessDay);
    return (win.end - win.start) / 60;
  }

  /* --- Dataset --- */
  const SOURCES = ['communication', 'tasks', 'infrastructure'];

  function buildDataset(config, sources) {
    const timeline = buildTimeline(config);
    const byName = {
      communication: sources.communication.events || [],
      tasks: sources.tasks.events || [],
      infrastructure: sources.infrastructure.events || []
    };
    Object.keys(byName).forEach(key => {
      byName[key] = byName[key]
        .map(e => {
          const minutes = toMinutes(e.time);
          return Object.assign({}, e, { _source: key, _minutes: minutes, _tick: timeline.tickOf(e.time) });
        })
        .sort((a, b) => a._minutes - b._minutes);
    });
    return {
      config: config,
      timeline: timeline,
      events: byName,
      all: byName.communication.concat(byName.tasks, byName.infrastructure)
        .sort((a, b) => a._minutes - b._minutes)
    };
  }

  /* --- Selectors --- */
  function resolveSelector(sel, ds) {
    const list = ds.events[sel.source];
    if (!list) throw new Error('Unknown data source in selector: ' + sel.source);
    const where = sel.where || {};
    const hits = list.filter(e => Object.keys(where).every(k => e[k] === where[k]));
    if (sel.pick === 'count') return { count: hits.length, times: hits.map(e => e._minutes) };
    if (!hits.length) return null;
    return sel.pick === 'last' ? hits[hits.length - 1] : hits[0];
  }

  /* --- Metrics --- */
  function computeMetrics(ds) {
    const bd = ds.config.time_model.business_day;
    const out = {};
    (ds.config.metrics || []).forEach(m => {
      if (m.start && m.start.pick === 'count') {
        const c = resolveSelector(m.start, ds);
        out[m.id] = { id: m.id, label: m.label, unit: m.unit, count: c.count, countMinutes: c.times };
        return;
      }
      const s = resolveSelector(m.start, ds);
      const e = m.end ? resolveSelector(m.end, ds) : null;
      out[m.id] = {
        id: m.id, label: m.label, unit: m.unit,
        startMinutes: s ? s._minutes : null,
        endMinutes: e ? e._minutes : null,
        startTick: s ? s._tick : null,
        endTick: e ? e._tick : null,
        hours: (s && e) ? businessMinutesBetween(s._minutes, e._minutes, bd) / 60 : null
      };
    });
    return out;
  }

  // Elapsed duration of a metric up to a given moment.
  function metricHoursAt(metric, atMinutes, businessDay) {
    if (metric.startMinutes == null) return 0;
    if (atMinutes <= metric.startMinutes) return 0;
    const until = (metric.endMinutes != null) ? Math.min(atMinutes, metric.endMinutes) : atMinutes;
    return businessMinutesBetween(metric.startMinutes, until, businessDay) / 60;
  }

  // Count of matches strictly before a given moment.
  function metricCountAt(metric, atMinutes) {
    const times = metric.countMinutes || [];
    let n = 0;
    for (; n < times.length; n++) {
      if (times[n] >= atMinutes) break;
    }
    return n;
  }

  /* --- Costs --- */
  function costAmount(cost, hours, businessDay) {
    let amount = 0;
    if (cost.rate_per_hour != null) amount += cost.rate_per_hour * hours;
    if (cost.rate_per_workday != null) amount += cost.rate_per_workday * (hours / workdayHours(businessDay));
    if (cost.flat_fee != null && hours > 0) amount += cost.flat_fee;
    return amount;
  }

  function computeCosts(ds, metrics, atMinutes) {
    const bd = ds.config.time_model.business_day;
    const perCost = {}, perCategory = {};
    let total = 0;
    (ds.config.cost_categories || []).forEach(c => { perCategory[c.id] = 0; });
    (ds.config.costs || []).forEach(cost => {
      const m = metrics[cost.span.metric];
      if (!m) throw new Error('Cost item "' + cost.id + '" references unknown metric "' + cost.span.metric + '"');
      const hours = (atMinutes == null) ? (m.hours || 0) : metricHoursAt(m, atMinutes, bd);
      const amount = costAmount(cost, hours, bd);
      perCost[cost.id] = { id: cost.id, label: cost.label, category: cost.category, hours: hours, amount: amount };
      if (perCategory[cost.category] === undefined) {
        throw new Error('Cost item "' + cost.id + '" uses unknown category "' + cost.category + '"');
      }
      perCategory[cost.category] += amount;
      total += amount;
    });
    return { perCost: perCost, perCategory: perCategory, total: total };
  }

  /* --- Sequence diagram height --- */
  const TICK_HEIGHT_PX = 18;
  const ARROW_ROW_PX = 14;

  // Tick height in pixels: fixed unless more than one message lands on it.
  function tickHeight(messageCount) {
    return messageCount <= 1 ? TICK_HEIGHT_PX : messageCount * ARROW_ROW_PX;
  }

  function communicationCountPerTick(ds) {
    const counts = {};
    ds.events.communication.forEach(e => {
      if (e._tick != null) counts[e._tick] = (counts[e._tick] || 0) + 1;
    });
    return counts;
  }

  function sequenceDiagramHeight(ds) {
    const counts = communicationCountPerTick(ds);
    let total = 0;
    for (let t = 1; t <= ds.timeline.totalTicks; t++) {
      total += tickHeight(counts[t] || 0);
    }
    return total;
  }

  /* --- Task pairing --- */
  function pairKey(event) {
    return event.from + '::' + event.task;
  }

  function pairTasks(ds) {
    const open = {}, out = [];
    ds.events.tasks.forEach(e => {
      const key = pairKey(e);
      if (e.event === 'start') {
        (open[key] = open[key] || []).push(e);
      } else if (e.event === 'end') {
        const pending = open[key];
        if (pending && pending.length) {
          const s = pending.shift();
          out.push({
            actor: e.from, task: e.task,
            startMinutes: s._minutes, endMinutes: e._minutes,
            startTick: s._tick, endTick: e._tick, open: false
          });
        } else {
          out.push({
            actor: e.from, task: e.task,
            startMinutes: null, endMinutes: e._minutes,
            startTick: null, endTick: e._tick, open: false, orphanEnd: true
          });
        }
      }
    });
    Object.keys(open).forEach(key => {
      open[key].forEach(s => {
        out.push({
          actor: s.from, task: s.task,
          startMinutes: s._minutes, endMinutes: null,
          startTick: s._tick, endTick: null, open: true
        });
      });
    });
    const sortKey = t => t.startMinutes != null ? t.startMinutes : t.endMinutes;
    return out.sort((a, b) => sortKey(a) - sortKey(b));
  }

  /* --- Infrastructure state --- */
  // atMinutes is exclusive: matches events strictly before it.
  function stateAt(ds, componentId, atMinutes) {
    const comp = (ds.config.components || []).find(c => c.id === componentId);
    let state = comp ? comp.initial_state : null;
    ds.events.infrastructure.forEach(e => {
      if (e.component === componentId && e._minutes < atMinutes) state = e.state;
    });
    return state;
  }

  function stateCategory(config, stateName) {
    const v = (config.vocabulary && config.vocabulary.component_states) || [];
    const hit = v.find(s => s.name === stateName);
    return hit ? hit.category : null;
  }

  /* --- Actor order and colours --- */
  const PALETTE = ['#4f46e5', '#0ea5e9', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#06b6d4', '#64748b',
    '#ef4444', '#14b8a6', '#a855f7', '#eab308', '#22c55e', '#f43f5e', '#6366f1', '#84cc16'];

  function paletteColor(index) {
    return PALETTE[index % PALETTE.length];
  }

  function orderedActors(config) {
    return (config.actors || [])
      .map((a, i) => ({ actor: a, i: i }))
      .sort((x, y) => {
        const ox = x.actor.order != null ? x.actor.order : x.i;
        const oy = y.actor.order != null ? y.actor.order : y.i;
        return ox - oy || x.i - y.i;
      })
      .map((x, idx) => Object.assign({}, x.actor, { color: x.actor.color || paletteColor(idx) }));
  }

  return {
    SOURCES: SOURCES,
    TICK_HEIGHT_PX: TICK_HEIGHT_PX,
    ARROW_ROW_PX: ARROW_ROW_PX,
    formatClock: formatClock,
    formatEuro: formatEuro,
    buildDataset: buildDataset,
    resolveSelector: resolveSelector,
    computeMetrics: computeMetrics,
    metricHoursAt: metricHoursAt,
    metricCountAt: metricCountAt,
    computeCosts: computeCosts,
    pairTasks: pairTasks,
    stateAt: stateAt,
    stateCategory: stateCategory,
    orderedActors: orderedActors,
    paletteColor: paletteColor,
    tickHeight: tickHeight,
    communicationCountPerTick: communicationCountPerTick,
    sequenceDiagramHeight: sequenceDiagramHeight
  };
});
