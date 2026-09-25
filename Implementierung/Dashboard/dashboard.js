// dashboard.js — renders the five visualisation aspects from configuration and events.
(function () {
  'use strict';

  const CFG = {
    lifelineWidth: 132,   // minimum width of one actor lane (aspect 1)
    barMax: 34,           // maximum bar thickness (aspect 3)
    phaseCharPx: 6.2      // estimated character width (aspect 1 gutter, aspect 3 phase headers)
  };

  // Oversized backing rect so a sticky layer stays opaque while panned.
  const BACKING_OVERSIZE = 20000;

  // Colours read once from the CSS custom properties in index.html.
  const rootStyle = getComputedStyle(document.documentElement);
  function cssColor(name) { return rootStyle.getPropertyValue(name).trim(); }
  const COLOR = {
    text: cssColor('--text'),
    text2: cssColor('--text-2'),
    textMuted: cssColor('--text-muted'),
    card: cssColor('--card'),
    surface: cssColor('--surface'),
    border: cssColor('--border'),
    stroke: cssColor('--stroke'),
    lightOff: cssColor('--light-off'),
    accent: cssColor('--accent'),
    ok: cssColor('--ok'),
    warning: cssColor('--warning'),
    critical: cssColor('--critical')
  };

  const SOURCE_COLOR = {
    communication: cssColor('--data-communication'),
    tasks: cssColor('--data-tasks'),
    infrastructure: cssColor('--data-infrastructure')
  };
  const SOURCE_LABEL = {
    communication: 'Communication',
    tasks: 'Task start/end',
    infrastructure: 'Infrastructure'
  };

  let ds, timeline, actors, actorById, metrics, tasks, tickNow = 1;
  let bucketKey = null;         // granularity of aspect 3: 'tick', 'hour', or 'phase'
  let a3Content = null, a3Size = { w: 1, h: 1 }, a3Viewport = null;
  let playing = false, timer = null, msPerTick = 1000;

  const tooltip = document.getElementById('tooltip');

  /* --- Helpers --- */

  function num(n, digits) {
    return n.toLocaleString('de-DE', { minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0 });
  }

  function durationLabel(minutes) {
    if (minutes % 60 === 0) return (minutes / 60) + ' h';
    return minutes + ' min';
  }

  function showTip(html, event) {
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    moveTip(event);
  }

  function moveTip(event) {
    const pad = 14;
    let x = event.clientX + pad, y = event.clientY + pad;
    const box = tooltip.getBoundingClientRect();
    if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - pad;
    if (y + box.height > window.innerHeight - 8) y = event.clientY - box.height - pad;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function hideTip() { tooltip.style.display = 'none'; }

  // Shows a text hint on a card that has nothing to draw.
  function emptyNote(svg, text) {
    svg.attr('viewBox', '0 0 420 48').attr('width', 420).attr('height', 48);
    svg.append('text')
      .attr('x', 4).attr('y', 28)
      .attr('font-size', 11).attr('fill', COLOR.textMuted)
      .text(text);
  }

  function bindTip(sel, htmlFn) {
    sel.on('mousemove', (event, d) => showTip(htmlFn(d), event))
       .on('mouseleave', hideTip);
  }

  // Shortens SVG text with an ellipsis until it fits maxWidth.
  function truncate(node, maxWidth, full) {
    let text = full;
    while (text.length > 3 && node.getComputedTextLength && node.getComputedTextLength() > maxWidth) {
      text = text.slice(0, -1);
      node.textContent = text + '…';
    }
  }

  // Builds an SVG path through waypoints with rounded inner corners.
  function roundedPath(points, radius) {
    if (points.length < 3) return 'M' + points.map(p => p.x + ',' + p.y).join('L');
    let d = 'M' + points[0].x + ',' + points[0].y;
    for (let i = 1; i < points.length - 1; i++) {
      const p0 = points[i - 1], p1 = points[i], p2 = points[i + 1];
      const v1 = { x: p1.x - p0.x, y: p1.y - p0.y }, v2 = { x: p2.x - p1.x, y: p2.y - p1.y };
      const len1 = Math.hypot(v1.x, v1.y), len2 = Math.hypot(v2.x, v2.y);
      const r = Math.min(radius, len1 / 2, len2 / 2);
      const a = { x: p1.x - v1.x / len1 * r, y: p1.y - v1.y / len1 * r };
      const b = { x: p1.x + v2.x / len2 * r, y: p1.y + v2.y / len2 * r };
      d += 'L' + a.x + ',' + a.y + 'Q' + p1.x + ',' + p1.y + ' ' + b.x + ',' + b.y;
    }
    const last = points[points.length - 1];
    return d + 'L' + last.x + ',' + last.y;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Actor name lookup, used only for communication (aspect 1).
  function nameOf(id) {
    return actorById[id].name;
  }

  function colorOfActor(id) {
    return actorById[id].color;
  }

  /* --- Bounded zoom window (aspects 1, 3, 4) --- */
  function createViewport(opts) {
    const host = opts.host;
    const svg = d3.select(host).select('svg');
    const controls = opts.controls;
    let current = d3.zoomIdentity;
    let active = false;
    let box = { w: 0, h: 0 };
    let content = { w: 1, h: 1 };
    // Tracks the current-tick marker; a manual gesture disarms it.
    let follow = true;

    const zoom = d3.zoom()
      // Wheel zooms only with Ctrl/Cmd held; plain drag pans.
      .filter(event => {
        if (event.type === 'wheel') return event.ctrlKey || event.metaKey;
        return !event.button;
      })
      // Pins the drawing's left edge at x=0 when narrower than the window.
      .constrain((transform, extent, translateExtent) => {
        const dx0 = transform.invertX(extent[0][0]) - translateExtent[0][0];
        const dx1 = transform.invertX(extent[1][0]) - translateExtent[1][0];
        const dy0 = transform.invertY(extent[0][1]) - translateExtent[0][1];
        const dy1 = transform.invertY(extent[1][1]) - translateExtent[1][1];
        const narrow = dx1 > dx0;
        const t = transform.translate(
          narrow ? 0 : Math.min(0, dx0) || Math.max(0, dx1),
          dy1 > dy0 ? (dy0 + dy1) / 2 : Math.min(0, dy0) || Math.max(0, dy1)
        );
        return narrow ? d3.zoomIdentity.translate(0, t.y).scale(t.k) : t;
      })
      .on('zoom', event => {
        current = event.transform;
        if (event.sourceEvent) follow = false;
        apply();
      });

    function apply() {
      opts.content().attr('transform', current.toString());
      if (opts.sticky) opts.sticky(current);
    }

    function fitScale() {
      return Math.min(box.w / content.w, box.h / content.h);
    }

    // Centres vertically when the drawing is smaller than the window.
    function transformFor(k) {
      return d3.zoomIdentity
        .translate(0, Math.max(0, (box.h - content.h * k) / 2))
        .scale(k);
    }

    function setTransform(t) {
      svg.call(zoom.transform, t);
    }

    function button(label, title, handler) {
      controls.append('button')
        .attr('type', 'button').attr('title', title).attr('aria-label', title)
        .text(label).on('click', handler);
    }

    function step(factor) {
      return () => zoom.scaleBy(svg, factor);
    }

    button('−', 'Zoom out (also Ctrl + mouse wheel)', () => { follow = false; step(1 / 1.3)(); });
    button('+', 'Zoom in (also Ctrl + mouse wheel)', () => { follow = false; step(1.3)(); });
    button('Fit', 'Fit the whole drawing', () => { follow = false; setTransform(transformFor(fitScale())); });
    button('1:1', 'Original size', () => { follow = true; setTransform(transformFor(1)); });

    function update() {
      content = opts.measure();
      if (!(content.w > 0) || !(content.h > 0)) content = { w: 1, h: 1 };

      box = { w: host.clientWidth, h: host.clientHeight };
      opts.resize(box);
      zoom.scaleExtent([Math.min(fitScale(), 1) * 0.9, 2])
        .extent([[0, 0], [box.w, box.h]])
        .translateExtent([[-24, -24], [content.w + 24, content.h + 24]]);
      svg.call(zoom);
      setTransform(active ? current : transformFor(1));
      active = true;
    }

    // Distance from the edge before the follow nudge kicks in.
    const FOLLOW_MARGIN = 80;

    // Nudges the view to keep a point on followAxis inside the window.
    function follow_(point) {
      if (!follow || !opts.followAxis) return;
      const k = current.k;
      if (opts.followAxis === 'y') {
        const screenY = current.y + point * k;
        if (screenY > box.h - FOLLOW_MARGIN) setTransform(d3.zoomIdentity.translate(current.x, box.h - FOLLOW_MARGIN - point * k).scale(k));
        else if (screenY < FOLLOW_MARGIN) setTransform(d3.zoomIdentity.translate(current.x, FOLLOW_MARGIN - point * k).scale(k));
      } else {
        const screenX = current.x + point * k;
        if (screenX > box.w - FOLLOW_MARGIN) setTransform(d3.zoomIdentity.translate(box.w - FOLLOW_MARGIN - point * k, current.y).scale(k));
        else if (screenX < FOLLOW_MARGIN) setTransform(d3.zoomIdentity.translate(FOLLOW_MARGIN - point * k, current.y).scale(k));
      }
    }

    return {
      update: update,
      reset: () => { active = false; follow = true; },
      follow: follow_
    };
  }

  // Exclusive upper bound of a tick: matches events of that tick only.
  function minutesAtEndOfTick(tick) {
    const m = timeline.timeOfTick(tick);
    return m == null ? null : m + timeline.tickMinutes;
  }

  function tickLabel(tick) {
    return timeline.labelOfTick(tick);
  }

  /* --- Aspect 1: communication (sequence diagram) --- */
  const a1 = {};

  function buildAspect1() {
    const svg = d3.select('#a1');
    svg.selectAll('*').remove();

    const countPerTick = Core.communicationCountPerTick(ds);
    a1.countPerTick = countPerTick;

    // Cumulative top offset of each tick (1-indexed; tickTop[0] = 0).
    const tickTop = [0];
    for (let t = 1; t <= timeline.totalTicks; t++) tickTop.push(tickTop[t - 1] + Core.tickHeight(countPerTick[t] || 0));
    a1.tickTop = tickTop;

    const GUTTER_MIN = 112, GUTTER_PAD = 58;
    const longestPhase = timeline.phases.reduce((max, p) => Math.max(max, (p.label || '').length), 0);
    const gutter = Math.max(GUTTER_MIN, Math.round(longestPhase * CFG.phaseCharPx) + GUTTER_PAD);
    const padRight = 40, headH = 46, padBottom = 24;
    const plotW = Math.max(actors.length, 1) * CFG.lifelineWidth;
    const width = gutter + plotW + padRight;
    const height = headH + tickTop[timeline.totalTicks] + padBottom;

    svg.attr('viewBox', '0 0 ' + width + ' ' + height)
       .attr('width', width).attr('height', height);

    const root = svg.append('g').attr('class', 'vp-content');
    const headLayer = svg.append('g').attr('class', 'a1-heads');
    const gutLayer = svg.append('g').attr('class', 'a1-gutter');

    root.append('rect').attr('x', 0).attr('y', 0).attr('width', width).attr('height', height).attr('fill', COLOR.card);

    const x = d3.scalePoint()
      .domain(actors.map(a => a.id))
      .range([gutter, gutter + plotW])
      .padding(0.5);

    a1.x = x;
    a1.yOf = tick => headH + tickTop[tick - 1] + Core.tickHeight(countPerTick[tick] || 0) / 2;

    const defs = svg.append('defs');
    defs.selectAll('marker').data(actors).join('marker')
      .attr('id', d => 'arrow-' + d.id)
      .attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto-start-reverse')
      .append('path').attr('d', 'M0,0 L10,5 L0,10 Z')
      .attr('fill', d => d.color);

    const bands = root.append('g').attr('class', 'a1-bands');
    bands.selectAll('rect').data(timeline.phases).join('rect')
      .attr('x', gutter - 8)
      .attr('y', p => headH + tickTop[p.firstTick - 1])
      .attr('width', plotW + 16)
      .attr('height', p => tickTop[p.firstTick + p.ticks - 1] - tickTop[p.firstTick - 1])
      .attr('fill', (p, i) => i % 2 ? COLOR.surface : COLOR.card);

    bands.selectAll('line.sep').data(timeline.phases.slice(1)).join('line')
      .attr('class', 'sep')
      .attr('x1', 8).attr('x2', gutter + plotW + 8)
      .attr('y1', p => headH + tickTop[p.firstTick - 1])
      .attr('y2', p => headH + tickTop[p.firstTick - 1])
      .attr('stroke', COLOR.lightOff).attr('stroke-width', 1);

    const ticks = [];
    for (let t = 1; t <= timeline.totalTicks; t++) ticks.push(t);

    gutLayer.append('rect')
      .attr('x', 0).attr('y', -BACKING_OVERSIZE)
      .attr('width', gutter - 10).attr('height', BACKING_OVERSIZE * 2)
      .attr('fill', COLOR.card);

    gutLayer.selectAll('text.phase').data(timeline.phases).join('text')
      .attr('class', 'phase')
      .attr('x', 10)
      .attr('y', p => a1.yOf(p.firstTick) + 3)
      .attr('font-size', 11).attr('font-weight', 700).attr('fill', COLOR.text2)
      .text(p => p.label);

    // Hour marks are drawn once but revealed progressively in renderAspect1.
    a1.hourLabels = gutLayer.selectAll('text.clock').data(ticks.filter(t => {
      const m = timeline.timeOfTick(t);
      return m != null && m % 60 === 0;
    })).join('text')
      .attr('class', 'clock')
      .attr('x', gutter - 14).attr('text-anchor', 'end')
      .attr('y', t => a1.yOf(t) + 3)
      .attr('font-size', 9).attr('fill', COLOR.textMuted)
      .text(t => Core.formatClock(timeline.timeOfTick(t)));

    root.append('g').selectAll('line').data(actors).join('line')
      .attr('x1', d => x(d.id)).attr('x2', d => x(d.id))
      .attr('y1', headH - 8).attr('y2', height - padBottom)
      .attr('stroke', d => d.color)
      .attr('stroke-width', 1.5).attr('opacity', .38);

    headLayer.append('rect')
      .attr('x', -BACKING_OVERSIZE).attr('y', 0)
      .attr('width', BACKING_OVERSIZE * 2).attr('height', headH - 10)
      .attr('fill', COLOR.card);

    const head = headLayer.append('g').selectAll('g').data(actors).join('g')
      .attr('transform', d => 'translate(' + x(d.id) + ',0)');
    head.append('circle').attr('cy', 16).attr('r', 5)
      .attr('fill', d => d.color);
    head.append('text').attr('y', 34).attr('text-anchor', 'middle')
      .attr('font-size', 10).attr('font-weight', 700).attr('fill', COLOR.text)
      .text(d => d.name)
      .each(function (d) { truncate(this, CFG.lifelineWidth - 10, d.name); });

    a1.messages = root.append('g').attr('class', 'a1-messages');
    a1.markerLine = root.append('g').attr('class', 'a1-marker').append('line')
      .attr('x1', gutter - 8).attr('x2', gutter + plotW + 8)
      .attr('stroke', COLOR.accent).attr('stroke-width', 1).attr('stroke-dasharray', '3 3').attr('opacity', .5);
    a1.markerArrow = gutLayer.append('path').attr('fill', COLOR.accent);

    a1.gutter = gutter;

    a1.viewport = createViewport({
      host: document.getElementById('a1-viewport'),
      controls: d3.select('#a1-controls'),
      content: () => root,
      followAxis: 'y',
      sticky: t => {
        headLayer.attr('transform', 'translate(' + t.x + ',0) scale(' + t.k + ')');
        gutLayer.attr('transform', 'translate(0,' + t.y + ') scale(' + t.k + ')');
      },
      measure: () => ({ w: width, h: height }),
      resize: b => {
        svg.attr('viewBox', '0 0 ' + b.w + ' ' + b.h).attr('width', b.w).attr('height', b.h);
      }
    });
    a1.viewport.update();
  }

  function renderAspect1() {
    const visible = ds.events.communication.filter(e => e._tick != null && e._tick <= tickNow);

    // Offsets simultaneous messages, centred within the tick's band.
    const seen = {};
    const rows = visible.map(e => {
      const count = a1.countPerTick[e._tick] || 1;
      const n = seen[e._tick] = (seen[e._tick] || 0) + 1;
      return { e: e, offset: (n - (count + 1) / 2) * Core.ARROW_ROW_PX };
    });

    const g = a1.messages.selectAll('g.msg').data(rows, d => d.e.id);
    g.exit().remove();

    const enter = g.enter().append('g').attr('class', 'msg');
    enter.append('line');
    enter.append('text');
    const all = enter.merge(g);

    all.attr('transform', d => 'translate(0,' + (a1.yOf(d.e._tick) + d.offset) + ')');

    all.select('line')
      .attr('x1', d => a1.x(d.e.from))
      .attr('x2', d => a1.x(d.e.to))
      .attr('y1', 0).attr('y2', 0)
      .attr('stroke', d => colorOfActor(d.e.from))
      .attr('stroke-width', 1.6)
      .attr('marker-end', d => 'url(#arrow-' + d.e.from + ')');

    all.select('text')
      .attr('x', d => (a1.x(d.e.from) + a1.x(d.e.to)) / 2)
      .attr('y', -4).attr('text-anchor', 'middle')
      .attr('font-size', 9).attr('fill', COLOR.text2);

    // Text and truncation only run once, when a message enters.
    enter.select('text')
      .text(d => d.e.subject)
      .each(function (d) {
        const span = Math.abs(a1.x(d.e.to) - a1.x(d.e.from));
        truncate(this, Math.max(span - 12, 60), d.e.subject);
      });

    bindTip(enter, d =>
      '<b>' + escapeHtml(d.e.subject) + '</b><br>' +
      escapeHtml(nameOf(d.e.from)) + ' → ' + escapeHtml(nameOf(d.e.to)) + '<br>' +
      tickLabel(d.e._tick) + (d.e.body ? '<br><span style="opacity:.8">' + escapeHtml(d.e.body) + '</span>' : ''));

    const y = a1.yOf(tickNow);
    a1.markerArrow.attr('d', 'M' + (a1.gutter - 8) + ',' + (y - 5) + ' L' + (a1.gutter + 2) + ',' + y + ' L' + (a1.gutter - 8) + ',' + (y + 5) + ' Z');
    a1.markerLine.attr('y1', y).attr('y2', y);
    a1.hourLabels.style('display', t => t <= tickNow ? null : 'none');
    a1.viewport.follow(y);
  }

  /* --- Aspect 2: activity stack --- */
  function renderAspect2() {
    const container = d3.select('#a2-grid');

    const boxes = container.selectAll('div.stack').data(actors, d => d.id);
    const enter = boxes.enter().append('div').attr('class', 'stack');
    const headEnter = enter.append('div').attr('class', 'stack-head');
    headEnter.append('span').attr('class', 'dot');
    headEnter.append('span').attr('class', 'name');
    enter.append('div').attr('class', 'stack-count');
    enter.append('div').attr('class', 'slot-active');
    enter.append('div').attr('class', 'stack-done');
    const all = enter.merge(boxes);

    all.select('.stack-head .dot').style('background', d => d.color);
    all.select('.stack-head .name').text(d => d.name);

    all.each(function (actor) {
      const mine = tasks.filter(t => t.actor === actor.id);
      const active = mine.filter(t => t.startTick != null && t.startTick <= tickNow &&
        (t.endTick == null || t.endTick > tickNow));
      // Ordered by the moment they ended, not the moment they began.
      const done = mine
        .filter(t => t.endTick != null && t.endTick <= tickNow)
        .sort((a, b) => a.endMinutes - b.endMinutes);

      const box = d3.select(this);
      box.select('.stack-count').text(done.length);

      const slot = box.select('.slot-active');
      slot.classed('empty', active.length === 0)
        .style('border-color', active.length > 0 ? actor.color : null)
        .style('border-width', active.length > 0 ? '2px' : null)
        .text(active.length ? active.map(t => t.task).join(' · ') : 'no activity');

      const blocks = box.select('.stack-done').selectAll('div.task-block')
        .data(done, t => t.actor + '|' + t.task + '|' + t.startTick);
      blocks.exit().remove();
      const blocksMerged = blocks.enter().append('div').attr('class', 'task-block')
        .merge(blocks)
        .style('background', actor.color)
        .text(t => t.task);
      bindTip(blocksMerged, t => '<b>' + escapeHtml(t.task) + '</b><br>' +
        tickLabel(t.startTick) + ' → ' + tickLabel(t.endTick));
    });
  }

  /* --- Aspect 3: event density --- */
  function bucketOptions() {
    const minutes = timeline.tickMinutes;
    const opts = [];
    opts.push({ key: 'tick', step: 1, byDivisor: false, label: durationLabel(minutes) });
    // Only a genuine divisor of 60 becomes a clean "1 hour" bucket.
    if (minutes < 60 && 60 % minutes === 0) {
      opts.push({ key: 'hour', step: 60 / minutes, byDivisor: false, label: '1 hour' });
    }
    opts.push({ key: 'phase', step: 1, byDivisor: true, label: 'Phase' });
    return opts;
  }

  function currentBucketSpec() {
    const opts = bucketOptions();
    return opts.filter(o => o.key === bucketKey)[0] || opts[0];
  }

  function buildPhaseBuckets(step, byDivisor) {
    const buckets = [];
    timeline.phases.forEach((ph, idx) => {
      const bucketSize = byDivisor ? Math.ceil(ph.ticks / step) : step;
      for (let t = ph.firstTick; t < ph.firstTick + ph.ticks; t += bucketSize) {
        const to = Math.min(t + bucketSize - 1, ph.firstTick + ph.ticks - 1);
        const isStart = t === ph.firstTick;
        buckets.push({
          from: t, to: to, label: tickLabel(t),
          isPhaseStart: isStart,
          phaseIndex: idx
        });
      }
    });
    return buckets;
  }

  function fillBuckets(buckets, limitTick) {
    buckets.forEach(b => {
      b.counts = { communication: 0, tasks: 0, infrastructure: 0 };
      b.total = 0;
    });
    ds.all.forEach(e => {
      if (e._tick == null) return;
      if (limitTick != null && e._tick > limitTick) return;
      for (let i = 0; i < buckets.length; i++) {
        if (e._tick >= buckets[i].from && e._tick <= buckets[i].to) {
          buckets[i].counts[e._source]++;
          buckets[i].total++;
          break;
        }
      }
    });
    return buckets;
  }

  function buildAspect3Controls() {
    const opts = bucketOptions();
    bucketKey = opts[0].key;

    const wrap = d3.select('#a3-granularity');
    wrap.selectAll('button').data(opts, d => d.key).join('button')
      .attr('type', 'button')
      .text(d => d.label)
      .attr('aria-pressed', d => d.key === bucketKey ? 'true' : 'false')
      .on('click', (event, d) => {
        bucketKey = d.key;
        wrap.selectAll('button').attr('aria-pressed', o => o.key === bucketKey ? 'true' : 'false');
        if (a3Viewport) a3Viewport.reset();
        renderAspect3();
      });

    const legend = d3.select('#a3-legend');
    legend.selectAll('span').data(Object.keys(SOURCE_LABEL)).join('span')
      .html(k => '<i style="background:' + SOURCE_COLOR[k] + '"></i>' + SOURCE_LABEL[k]);
  }

  const PLOT_H = 190;

  function computeAspect3Layout(shown, hostWidth, pad, spec) {
    const available = (hostWidth || 900) - pad.left - pad.right;
    const n = shown.length;
    let minStep = 14, maxStep = 46;
    if (spec && spec.byDivisor) {
      // One bar per phase, column at least as wide as the phase name.
      maxStep = 130;
      const longestLabel = shown.reduce((max, b) => Math.max(max, (timeline.phases[b.phaseIndex].label || '').length), 0);
      minStep = Math.min(maxStep, Math.max(64, Math.round(longestLabel * CFG.phaseCharPx) + 18));
    }
    const step = Math.max(minStep, Math.min(maxStep, available / n));
    const plotW = n * step;
    return {
      step: step,
      plotW: plotW,
      plotH: PLOT_H,
      padL: pad.left,
      padT: pad.top,
      centerOf: i => pad.left + i * step + step / 2
    };
  }

  function drawAspect3Grid(layer, y, gridVals, layout) {
    layer.append('line')
      .attr('x1', layout.padL).attr('x2', layout.padL + layout.plotW)
      .attr('y1', layout.padT + layout.plotH).attr('y2', layout.padT + layout.plotH)
      .attr('stroke', COLOR.stroke);

    layer.append('g').selectAll('line').data(gridVals).join('line')
      .attr('x1', layout.padL).attr('x2', layout.padL + layout.plotW)
      .attr('y1', y).attr('y2', y)
      .attr('stroke', COLOR.border);

    layer.append('g').selectAll('text').data(gridVals).join('text')
      .attr('x', layout.padL - 6).attr('y', v => y(v) + 3)
      .attr('text-anchor', 'end').attr('font-size', 9).attr('fill', COLOR.textMuted)
      .text(v => v);
  }

  function drawAspect3Bars(layer, shown, y, layout, barW) {
    const order = Core.SOURCES;
    const withIndex = shown
      .map((b, i) => ({ b: b, i: i }))
      .filter(item => item.b.total > 0);

    const groups = layer.append('g').selectAll('g').data(withIndex).join('g')
      .attr('transform', item => 'translate(' + layout.centerOf(item.i) + ',0)');

    groups.each(function (item) {
      const b = item.b;
      let acc = 0;
      const segs = order.map(k => {
        const seg = { key: k, from: acc, value: b.counts[k] };
        acc += b.counts[k];
        return seg;
      }).filter(s => s.value > 0);

      const rects = d3.select(this).selectAll('rect').data(segs).join('rect')
        .attr('x', -barW / 2).attr('width', barW)
        .attr('y', s => y(s.from + s.value))
        .attr('height', s => y(s.from) - y(s.from + s.value))
        .attr('fill', s => SOURCE_COLOR[s.key])
        .attr('rx', 2);
      bindTip(rects, () => '<b>' + escapeHtml(b.label) + '</b><br>' +
        order.filter(k => b.counts[k])
          .map(k => SOURCE_LABEL[k] + ': ' + b.counts[k]).join('<br>') +
        '<br>total: ' + b.total);
    });
  }

  function drawAspect3Labels(layer, shown, layout, currentIndex) {
    const footItems = shown
      .map((b, i) => ({ b: b, i: i }))
      .filter(e => (e.b.isPhaseStart && e.i !== currentIndex) || e.i === currentIndex);

    layer.append('g').selectAll('text').data(footItems)
      .join('text')
      .attr('x', e => layout.centerOf(e.i))
      .attr('y', layout.padT + layout.plotH + 16)
      .attr('text-anchor', 'middle')
      .attr('font-size', 9)
      .attr('font-weight', e => e.i === currentIndex ? 700 : 600)
      .attr('fill', e => e.i === currentIndex ? COLOR.accent : COLOR.textMuted)
      .text(e => Core.formatClock(timeline.timeOfTick(e.b.from)));
  }

  function phaseRanges(shown) {
    const ranges = [];
    shown.forEach((b, i) => {
      if (b.isPhaseStart) ranges.push({ start: i, end: i, phaseIndex: b.phaseIndex });
      else ranges[ranges.length - 1].end = i;
    });
    return ranges;
  }

  function drawAspect3PhaseBands(layer, ranges, layout) {
    const step = layout.step;
    layer.append('g').selectAll('rect').data(ranges).join('rect')
      .attr('x', r => layout.centerOf(r.start) - step / 2)
      .attr('y', layout.padT)
      .attr('width', r => (r.end - r.start + 1) * step)
      .attr('height', layout.plotH)
      .attr('fill', r => r.phaseIndex % 2 ? COLOR.surface : COLOR.card);

    layer.append('g').selectAll('line').data(ranges.slice(1))
      .join('line')
      .attr('x1', r => layout.centerOf(r.start) - step / 2)
      .attr('x2', r => layout.centerOf(r.start) - step / 2)
      .attr('y1', layout.padT).attr('y2', layout.padT + layout.plotH)
      .attr('stroke', COLOR.lightOff).attr('stroke-width', 1);
  }

  function drawAspect3PhaseHeaders(layer, ranges, layout) {
    const step = layout.step;
    layer.append('g').selectAll('text').data(ranges).join('text')
      .attr('x', r => (layout.centerOf(r.start) + layout.centerOf(r.end)) / 2)
      .attr('y', layout.padT - 12)
      .attr('text-anchor', 'middle')
      .attr('font-size', 11).attr('font-weight', 700).attr('fill', COLOR.text2)
      .text(r => timeline.phases[r.phaseIndex].label)
      .each(function (r) {
        const span = (r.end - r.start + 1) * step;
        truncate(this, Math.max(span - 8, 20), timeline.phases[r.phaseIndex].label);
      });
  }

  function renderAspect3() {
    const svg = d3.select('#a3');
    const pad = { left: 34, right: 14, top: 36, bottom: 40 };

    const spec = currentBucketSpec();
    const shown = fillBuckets(buildPhaseBuckets(spec.step, spec.byDivisor), tickNow);
    const maxTotal = d3.max(shown, b => b.total) || 1;

    const hostWidth = document.getElementById('a3-viewport').clientWidth;
    const layout = computeAspect3Layout(shown, hostWidth, pad, spec);
    const width = pad.left + layout.plotW + pad.right, height = pad.top + layout.plotH + pad.bottom;

    svg.attr('viewBox', '0 0 ' + width + ' ' + height).attr('width', width).attr('height', height);
    svg.selectAll('*').remove();
    a3Content = svg.append('g').attr('class', 'vp-content');
    a3Size = { w: width, h: height };

    a3Content.append('rect').attr('x', 0).attr('y', 0).attr('width', width).attr('height', height).attr('fill', COLOR.card);

    const y = d3.scaleLinear().domain([0, maxTotal]).range([pad.top + layout.plotH, pad.top]);
    const barW = Math.min(CFG.barMax, layout.step * 0.72);

    const ranges = phaseRanges(shown);
    drawAspect3PhaseBands(a3Content, ranges, layout);
    drawAspect3PhaseHeaders(a3Content, ranges, layout);
    const gridVals = d3.ticks(0, maxTotal, Math.min(5, maxTotal));
    drawAspect3Grid(a3Content, y, gridVals, layout);

    let currentIndex = -1;
    shown.forEach((b, i) => { if (tickNow >= b.from && tickNow <= b.to) currentIndex = i; });
    if (currentIndex >= 0) {
      a3Content.append('rect')
        .attr('x', layout.centerOf(currentIndex) - barW / 2 - 3)
        .attr('y', pad.top - 6)
        .attr('width', barW + 6)
        .attr('height', layout.plotH + 12)
        .attr('rx', 4)
        .attr('fill', 'none')
        .attr('stroke', COLOR.accent).attr('stroke-width', 1.4);
    }

    drawAspect3Bars(a3Content, shown, y, layout, barW);
    if (!spec.byDivisor) drawAspect3Labels(a3Content, shown, layout, currentIndex);

    if (!a3Viewport) {
      a3Viewport = createViewport({
        host: document.getElementById('a3-viewport'),
        controls: d3.select('#a3-controls'),
        content: () => a3Content,
        followAxis: 'x',
        measure: () => a3Size,
        resize: b => {
          svg.attr('viewBox', '0 0 ' + b.w + ' ' + b.h).attr('width', b.w).attr('height', b.h);
        }
      });
    }
    a3Viewport.update();
    if (currentIndex >= 0) a3Viewport.follow(layout.centerOf(currentIndex));
  }

  /* --- Aspect 4: infrastructure traffic lights --- */
  const a4 = {};

  function buildAspect4() {
    const svg = d3.select('#a4');
    svg.selectAll('*').remove();

    const comps = ds.config.components || [];
    const NODE_W = 132, HOUSING_H = 74, LABEL_H = 30, STATE_H = 16, NODE_H = HOUSING_H + LABEL_H + STATE_H;

    if (!comps.length) {
      a4.nodes = null;
      emptyNote(svg, 'This exercise has no infrastructure components configured.');
      document.getElementById('a4-viewport').classList.add('is-capped');
      document.getElementById('a4-viewport').style.height = '';
      d3.select('#a4-controls').style('display', 'none');
      return;
    }

    document.getElementById('a4-viewport').classList.remove('is-capped');
    d3.select('#a4-controls').style('display', null);

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'BT', nodesep: 34, ranksep: 56, marginx: 22, marginy: 22 });
    g.setDefaultEdgeLabel(() => ({}));

    comps.forEach(c => { g.setNode(c.id, { width: NODE_W, height: NODE_H, comp: c }); });
    comps.forEach(c => {
      (c.depends_on || []).forEach(dep => {
        // Edge from the dependency to the dependent system.
        if (g.hasNode(dep)) g.setEdge(dep, c.id);
      });
    });

    dagre.layout(g);

    const gw = g.graph().width, gh = g.graph().height;
    svg.attr('viewBox', '0 0 ' + gw + ' ' + gh).attr('width', gw).attr('height', gh);

    const A4_MIN_H = 560, A4_MAX_H = 780, A4_PAD = 40;
    document.getElementById('a4-viewport').style.height =
      Math.min(A4_MAX_H, Math.max(A4_MIN_H, gh + A4_PAD)) + 'px';

    const root = svg.append('g').attr('class', 'vp-content');

    svg.append('defs').append('marker')
      .attr('id', 'a4-arrow').attr('viewBox', '0 0 10 10')
      .attr('refX', 9).attr('refY', 5).attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto-start-reverse')
      .append('path').attr('d', 'M0,0 L10,5 L0,10 Z').attr('fill', COLOR.stroke);

    root.append('g').selectAll('path').data(g.edges()).join('path')
      .attr('d', e => roundedPath(g.edge(e).points, 14))
      .attr('fill', 'none').attr('stroke', COLOR.stroke).attr('stroke-width', 1.4)
      .attr('marker-start', 'url(#a4-arrow)');

    const nodes = root.append('g').selectAll('g').data(g.nodes().map(id => {
      const n = g.node(id);
      return { id: id, x: n.x, y: n.y, comp: n.comp };
    })).join('g')
      .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');

    const boxW = 34;
    nodes.append('rect')
      .attr('x', -boxW / 2).attr('y', -NODE_H / 2)
      .attr('width', boxW).attr('height', HOUSING_H)
      .attr('rx', 9)
      .attr('fill', COLOR.card).attr('stroke', COLOR.stroke).attr('stroke-width', 1.4);

    const LAMP_TOP = 16, LAMP_GAP = 21;
    ['critical', 'warning', 'ok'].forEach((cat, i) => {
      nodes.append('circle')
        .attr('class', 'light light-' + cat)
        .attr('cx', 0)
        .attr('cy', -NODE_H / 2 + LAMP_TOP + i * LAMP_GAP)
        .attr('r', 7.5)
        .attr('fill', COLOR.lightOff);
    });

    nodes.append('text')
      .attr('y', -NODE_H / 2 + HOUSING_H + 16)
      .attr('text-anchor', 'middle')
      .attr('font-size', 10).attr('font-weight', 700).attr('fill', COLOR.text)
      .text(d => d.comp.name)
      .each(function (d) { truncate(this, NODE_W - 6, d.comp.name); });

    nodes.append('text').attr('class', 'state-label')
      .attr('y', -NODE_H / 2 + HOUSING_H + 28)
      .attr('text-anchor', 'middle')
      .attr('font-size', 10).attr('font-weight', 600).attr('fill', COLOR.textMuted);

    bindTip(nodes, d => {
      const state = Core.stateAt(ds, d.id, minutesAtEndOfTick(tickNow));
      return '<b>' + escapeHtml(d.comp.name) + '</b><br>State: ' + escapeHtml(state || '—');
    });

    a4.nodes = nodes;

    a4.viewport = createViewport({
      host: document.getElementById('a4-viewport'),
      controls: d3.select('#a4-controls'),
      content: () => root,
      measure: () => ({ w: gw, h: gh }),
      resize: b => {
        svg.attr('viewBox', '0 0 ' + b.w + ' ' + b.h).attr('width', b.w).attr('height', b.h);
      }
    });
    a4.viewport.update();
  }

  function renderAspect4() {
    if (!a4.nodes) return;
    const at = minutesAtEndOfTick(tickNow);
    const LIGHT_COLOR = { ok: COLOR.ok, warning: COLOR.warning, critical: COLOR.critical };

    a4.nodes.each(function (d) {
      const state = Core.stateAt(ds, d.id, at);
      const cat = Core.stateCategory(ds.config, state);
      d3.select(this).selectAll('circle.light')
        .attr('fill', function () {
          const circle = d3.select(this);
          return circle.classed('light-' + cat) ? LIGHT_COLOR[cat] : COLOR.lightOff;
        });
      d3.select(this).select('text.state-label').text(state || '—');
    });
  }

  /* --- Aspect 5: business impact --- */
  function renderAspect5() {
    const at = minutesAtEndOfTick(tickNow);
    const bd = ds.config.time_model.business_day;
    const costs = Core.computeCosts(ds, metrics, at);

    const costByMetric = {};
    (ds.config.costs || []).forEach(c => {
      (costByMetric[c.span.metric] = costByMetric[c.span.metric] || []).push(c);
    });

    const metricTiles = (ds.config.metrics || []).map((m, i) => {
      const live = metrics[m.id];
      const color = m.color || Core.paletteColor(i);
      const isCount = live.count != null;
      const countNow = isCount ? Core.metricCountAt(live, at) : null;
      const hours = isCount ? null : Core.metricHoursAt(live, at, bd);
      const bound = costByMetric[m.id] || [];
      const amount = bound.reduce((sum, c) => sum + (costs.perCost[c.id] ? costs.perCost[c.id].amount : 0), 0);

      return {
        key: 'metric-' + m.id,
        metricId: m.id,
        label: m.label,
        color: color,
        value: bound.length ? Core.formatEuro(amount) : (isCount ? num(countNow) : num(hours, 1) + ' ' + (m.unit || '')),
        sub: (bound.length && !isCount) ? num(hours, 1) + ' ' + (m.unit || '') : '',
        summary: false,
        tip: '<b>' + escapeHtml(m.label) + '</b><br>' +
          (isCount ? 'Count so far: ' + countNow + '<br>Total count: ' + live.count :
            'Duration so far: ' + num(hours, 1) + ' ' + (m.unit || '') +
            (live.hours != null ? '<br>Total duration: ' + num(live.hours, 1) + ' ' + (m.unit || '') : '')) +
          (bound.length ? '<br>Cost: ' + Core.formatEuro(amount) : '')
      };
    });

    const costTiles = (ds.config.cost_categories || []).map((cat, i) => ({
      key: 'cat-' + cat.id,
      label: cat.label,
      color: cat.color || Core.paletteColor(i),
      value: Core.formatEuro(costs.perCategory[cat.id] || 0),
      sub: '',
      summary: true,
      tip: '<b>' + escapeHtml(cat.label) + '</b><br>Sum of all items in this category'
    }));

    let grandTotalTile = null;
    if (costTiles.length > 1) {
      grandTotalTile = {
        key: 'grand-total',
        label: 'Grand total',
        color: COLOR.critical,
        value: Core.formatEuro(costs.total),
        sub: '',
        summary: true,
        tip: '<b>Grand total</b><br>all cost categories combined'
      };
    }

    const container = d3.select('#a5-tiles');
    const hasContent = metricTiles.length > 0 || (ds.config.costs || []).length > 0;

    container.selectAll('p.empty-note').data(hasContent ? [] : [1]).join('p')
      .attr('class', 'empty-note')
      .text('This exercise has no metrics and no cost categories configured.');

    const allTiles = hasContent ? metricTiles.concat(costTiles) : [];
    if (hasContent && grandTotalTile) allTiles.push(grandTotalTile);

    const catById = {};
    (ds.config.cost_categories || []).forEach(cat => { catById[cat.id] = cat; });

    const tilesSel = container.selectAll('div.tile').data(allTiles, d => d.key);
    tilesSel.exit().remove();
    const tileEnter = tilesSel.enter().append('div').attr('class', 'tile');
    tileEnter.append('div').attr('class', 'label');
    tileEnter.append('div').attr('class', 'value');
    tileEnter.append('div').attr('class', 'badge');
    tileEnter.append('div').attr('class', 'sub');
    const allTilesMerged = tileEnter.merge(tilesSel);

    allTilesMerged
      .classed('summary', d => d.summary)
      .style('border-left-color', d => d.color);
    bindTip(allTilesMerged, d => d.tip);
    allTilesMerged.select('.label').text(d => d.label);
    allTilesMerged.select('.value').text(d => d.value);
    allTilesMerged.select('.sub').text(d => d.sub);

    // Badge names the cost category a metric tile's amount feeds into.
    allTilesMerged.select('.badge').html(d => {
      if (d.summary) return '';
      const bound = costByMetric[d.metricId] || [];
      if (bound.length === 0) return '';
      const cat = catById[bound[0].category];
      return cat ? escapeHtml(cat.label) : '';
    });
  }

  /* --- Time control --- */
  function renderAll() {
    try {
      document.getElementById('clock').textContent = tickLabel(tickNow);
      document.getElementById('scrub').value = tickNow;
      renderAspect1();
      renderAspect2();
      renderAspect3();
      renderAspect4();
      renderAspect5();
    } catch (err) {
      showError('Rendering failed.', err.message);
      console.error(err);
    }
  }

  function setTick(t) {
    tickNow = Math.max(1, Math.min(timeline.totalTicks, t));
    renderAll();
  }

  function play() {
    playing = true;
    document.getElementById('play').textContent = 'Pause';
    timer = setInterval(() => {
      if (tickNow >= timeline.totalTicks) { pause(); return; }
      setTick(tickNow + 1);
    }, msPerTick);
  }

  function pause() {
    playing = false;
    document.getElementById('play').textContent = 'Play';
    if (timer) { clearInterval(timer); timer = null; }
  }

  function initControls() {
    const scrub = document.getElementById('scrub');
    scrub.max = timeline.totalTicks;
    scrub.addEventListener('input', () => {
      pause();
      setTick(+scrub.value);
    });
    document.getElementById('play').addEventListener('click', () => {
      if (playing) { pause(); return; }
      if (tickNow >= timeline.totalTicks) tickNow = 1;
      play();
    });
    window.addEventListener('resize', () => {
      renderAspect3();
      if (a1.viewport) a1.viewport.update();
      if (a4.viewport) a4.viewport.update();
    });
  }

  /* --- Startup --- */
  function showError(message, detail) {
    const box = document.getElementById('error');
    box.style.display = 'block';
    box.innerHTML = '<b>' + escapeHtml(message) + '</b>' +
      (detail ? '<br><code>' + escapeHtml(detail) + '</code>' : '') +
      '<br><br>Check the configuration with <code>node test/validate.js</code>. ' +
      'If the local server is missing or the path is wrong, see README.';
  }

  function loadJSON(path) {
    return fetch(path, { cache: 'no-store' }).then(r => {
      if (!r.ok) throw new Error(path + ' → HTTP ' + r.status);
      return r.json();
    });
  }

  // Without ?data=, the datasets in Datenmodell/Daten are used.
  const params = new URLSearchParams(window.location.search);
  const basePath = (params.get('data') || '../../Datenmodell/Daten').replace(/\/+$/, '') + '/';

  Promise.all([
    loadJSON(basePath + 'scenario.json'),
    loadJSON(basePath + 'communication.json'),
    loadJSON(basePath + 'tasks.json'),
    loadJSON(basePath + 'infrastructure.json')
  ]).then(files => {
    const config = files[0];
    ds = Core.buildDataset(config, {
      communication: files[1], tasks: files[2], infrastructure: files[3]
    });
    timeline = ds.timeline;
    actors = Core.orderedActors(config);
    actorById = {};
    actors.forEach(a => { actorById[a.id] = a; });
    metrics = Core.computeMetrics(ds);
    tasks = Core.pairTasks(ds);
    msPerTick = (config.time_model && config.time_model.playback_ms_per_tick) || 1000;

    document.getElementById('exercise-name').textContent = (config.exercise && config.exercise.name) || 'Cyber exercise';

    buildAspect1();
    buildAspect3Controls();
    buildAspect4();
    initControls();
    setTick(1);
  }).catch(err => {
    showError('Configuration or datasets could not be loaded.', err.message);
    console.error(err);
  });

})();
