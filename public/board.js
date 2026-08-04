/* Board rendering: draws the wheel once, then re-renders tokens + highlights. */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  const R_SPACE = 17.5;
  const R_HQ = 25;
  const R_HUB_INNER = 62;

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    if (attrs) {
      for (const k in attrs) {
        if (attrs[k] === undefined || attrs[k] === null) continue;
        node.setAttribute(k, attrs[k]);
      }
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  /** Path for one slice of a pie chart, slice `i` of `n`, starting at 12 o'clock. */
  function slicePath(cx, cy, r, i, n) {
    const a0 = (i / n) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / n) * Math.PI * 2 - Math.PI / 2;
    const x0 = cx + Math.cos(a0) * r;
    const y0 = cy + Math.sin(a0) * r;
    const x1 = cx + Math.cos(a1) * r;
    const y1 = cy + Math.sin(a1) * r;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
  }

  /**
   * A little six-slice wheel showing which wedges a player holds.
   * Returns an <svg> element sized to `size`.
   */
  function wedgeWheel(wedges, categories, color, size) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '-50 -50 100 100');
    if (size) {
      svg.setAttribute('width', size);
      svg.setAttribute('height', size);
    }
    el('circle', { cx: 0, cy: 0, r: 46, fill: '#0d1120', stroke: color || '#2a3350', 'stroke-width': 5 }, svg);
    for (let i = 0; i < 6; i++) {
      el('path', {
        d: slicePath(0, 0, 44, i, 6),
        fill: wedges && wedges[i] ? categories[i].color : 'transparent',
        stroke: 'rgba(255,255,255,.10)',
        'stroke-width': 1,
      }, svg);
    }
    return svg;
  }

  const Board = {
    svg: null,
    data: null,
    byId: {},
    layers: {},
    onSelect: null,

    init(svgEl, data) {
      this.svg = svgEl;
      this.data = data;
      this.byId = {};
      data.nodes.forEach((n) => { this.byId[n.id] = n; });
      svgEl.innerHTML = '';

      const defs = el('defs', null, svgEl);
      const glow = el('filter', { id: 'glow', x: '-60%', y: '-60%', width: '220%', height: '220%' }, defs);
      el('feGaussianBlur', { stdDeviation: 5, result: 'b' }, glow);
      const merge = el('feMerge', null, glow);
      el('feMergeNode', { in: 'b' }, merge);
      el('feMergeNode', { in: 'SourceGraphic' }, merge);

      this.layers.base = el('g', { class: 'layer-base' }, svgEl);
      this.layers.path = el('g', { class: 'layer-path' }, svgEl);
      this.layers.spaces = el('g', { class: 'layer-spaces' }, svgEl);
      this.layers.tokens = el('g', { class: 'layer-tokens' }, svgEl);

      this.drawStatic();
    },

    drawStatic() {
      const { categories, geometry } = this.data;
      const base = this.layers.base;

      // backdrop
      el('circle', { cx: 0, cy: 0, r: geometry.R_RING + 30, fill: '#0d1120', stroke: '#222c49', 'stroke-width': 2 }, base);
      el('circle', { cx: 0, cy: 0, r: geometry.R_RING - 26, fill: 'none', stroke: '#182035', 'stroke-width': 1 }, base);

      // spoke rails
      this.data.nodes.forEach((n) => {
        if (n.type === 'roll') {
          el('line', {
            x1: n.x, y1: n.y, x2: 0, y2: 0,
            stroke: '#232d4c', 'stroke-width': 12, 'stroke-linecap': 'round',
          }, base);
        }
      });

      // ring rail
      el('circle', {
        cx: 0, cy: 0, r: this.data.geometry.R_RING,
        fill: 'none', stroke: '#232d4c', 'stroke-width': 40,
      }, base);

      // hub: six wedges of the six categories
      const hub = el('g', { class: 'hub' }, base);
      for (let i = 0; i < 6; i++) {
        el('path', {
          d: slicePath(0, 0, R_HUB_INNER, i, 6),
          fill: categories[i].color,
          opacity: 0.9,
          stroke: '#0d1120',
          'stroke-width': 2,
        }, hub);
      }
      el('circle', { cx: 0, cy: 0, r: 26, fill: '#0d1120', stroke: '#ffffff22', 'stroke-width': 2 }, hub);
      el('text', {
        x: 0, y: 6, 'text-anchor': 'middle',
        'font-size': 15, 'font-weight': 700, fill: '#e8ecf7',
        'font-family': 'system-ui, sans-serif',
      }, hub).textContent = 'HUB';

      // spaces
      this.spaceNodes = {};
      this.hqBadges = {};
      this.data.nodes.forEach((n) => {
        if (n.type === 'hub') return;
        const g = el('g', { class: 'space', 'data-node': n.id }, this.layers.spaces);

        if (n.type === 'roll') {
          const s = 15;
          el('rect', {
            x: n.x - s, y: n.y - s, width: s * 2, height: s * 2, rx: 4,
            transform: `rotate(45 ${n.x} ${n.y})`,
            class: 'space-fill',
            fill: '#38446e', stroke: '#5b6ba6', 'stroke-width': 2,
          }, g);
          el('text', {
            x: n.x, y: n.y + 4.5, 'text-anchor': 'middle',
            'font-size': 12, 'font-weight': 800, fill: '#dbe3ff',
            'font-family': 'system-ui, sans-serif', 'pointer-events': 'none',
          }, g).textContent = '↻';
        } else {
          const cat = this.data.categories[n.category];
          const isHq = n.type === 'hq';
          el('circle', {
            cx: n.x, cy: n.y, r: isHq ? R_HQ : R_SPACE,
            class: 'space-fill',
            fill: cat.color,
            stroke: isHq ? '#ffffff' : 'rgba(0,0,0,.35)',
            'stroke-width': isHq ? 3 : 2,
            filter: isHq ? 'url(#glow)' : null,
          }, g);
          if (isHq) {
            el('circle', { cx: n.x, cy: n.y, r: R_HQ - 8, fill: 'none', stroke: 'rgba(0,0,0,.35)', 'stroke-width': 2, 'pointer-events': 'none' }, g);
            el('text', {
              x: n.x, y: n.y + 5, 'text-anchor': 'middle',
              'font-size': 13, 'font-weight': 800, fill: '#0b0e18',
              'font-family': 'system-ui, sans-serif', 'pointer-events': 'none',
            }, g).textContent = cat.short.toUpperCase();

            // Tick shown on the headquarters whose wedge you already hold, so
            // it is obvious at a glance which ones you still need to visit.
            const badge = el('g', { class: 'hq-badge', opacity: 0, 'pointer-events': 'none' }, g);
            const bx = n.x + 17;
            const by = n.y - 17;
            el('circle', { cx: bx, cy: by, r: 8.5, fill: '#0d1120', stroke: '#ffffff', 'stroke-width': 1.5 }, badge);
            el('path', {
              d: `M ${bx - 4} ${by} l 2.8 3.2 l 5.2 -6.2`,
              fill: 'none', stroke: '#ffffff', 'stroke-width': 2,
              'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            }, badge);
            this.hqBadges[n.category] = badge;
          }
        }
        this.spaceNodes[n.id] = g;
      });

      // clicking a space
      this.layers.spaces.addEventListener('click', (ev) => {
        const g = ev.target.closest('.space');
        if (!g || !g.classList.contains('selectable')) return;
        if (this.onSelect) this.onSelect(g.getAttribute('data-node'));
      });

      // The hub is a landing space too. It needs a .space-fill child so the
      // "selectable" highlight ring applies to it like any other space.
      const hubHit = el('g', { class: 'space', 'data-node': 'HUB' }, this.layers.spaces);
      el('circle', {
        cx: 0, cy: 0, r: R_HUB_INNER + 3,
        class: 'space-fill', fill: 'transparent', stroke: 'none',
      }, hubHit);
      this.spaceNodes.HUB = hubHit;

      // hover preview of the route taken
      this.layers.spaces.addEventListener('mouseover', (ev) => {
        const g = ev.target.closest('.space');
        if (!g || !g.classList.contains('selectable')) return;
        this.showPath(g.getAttribute('data-node'));
      });
      this.layers.spaces.addEventListener('mouseout', () => this.clearPath());
    },

    showPath(nodeId) {
      this.clearPath();
      const opt = (this.currentOptions || []).find((o) => o.node === nodeId);
      if (!opt) return;
      const pts = opt.path.map((id) => {
        const n = this.byId[id];
        return `${n.x},${n.y}`;
      }).join(' ');
      el('polyline', { points: pts, class: 'path-preview' }, this.layers.path);
    },

    clearPath() {
      this.layers.path.innerHTML = '';
    },

    /**
     * @param {object} state  the room state from the server
     * @param {object} opts   { youId, selectable: [nodeId], onSelect }
     */
    render(state, opts) {
      opts = opts || {};
      this.onSelect = opts.onSelect || null;
      this.currentOptions = (state.turn && state.turn.options) || [];

      const selectable = new Set(opts.selectable || []);
      const picking = selectable.size > 0;

      const you = state.players.find((p) => p.id === opts.youId);
      for (const cat in this.hqBadges) {
        this.hqBadges[cat].setAttribute('opacity', you && you.wedges[cat] ? 1 : 0);
      }

      for (const id in this.spaceNodes) {
        const g = this.spaceNodes[id];
        g.classList.toggle('selectable', selectable.has(id));
        g.classList.toggle('dimmed', picking && !selectable.has(id));
      }
      if (!picking) this.clearPath();

      // tokens
      const layer = this.layers.tokens;
      layer.innerHTML = '';
      const byNode = {};
      state.players.forEach((p) => {
        (byNode[p.node] = byNode[p.node] || []).push(p);
      });

      const currentId = state.turn && state.turn.playerId;
      Object.keys(byNode).forEach((nodeId) => {
        const node = this.byId[nodeId];
        if (!node) return;
        const list = byNode[nodeId];
        list.forEach((p, i) => {
          const spread = list.length > 1 ? 13 : 0;
          const a = (i / list.length) * Math.PI * 2 - Math.PI / 2;
          const cx = node.x + Math.cos(a) * spread;
          const cy = node.y + Math.sin(a) * spread;

          const g = el('g', {
            class: 'token' + (p.id === currentId ? ' token-active' : ''),
            transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`,
          }, layer);

          if (p.id === currentId) {
            el('circle', { class: 'token-ring', cx: 0, cy: 0, r: 20, fill: 'none', stroke: p.color, 'stroke-width': 3, opacity: .6 }, g);
          }
          el('circle', { cx: 0, cy: 0, r: 13, fill: '#0d1120', stroke: p.color, 'stroke-width': 3 }, g);
          for (let w = 0; w < 6; w++) {
            if (!p.wedges[w]) continue;
            el('path', { d: slicePath(0, 0, 11, w, 6), fill: this.data.categories[w].color, opacity: .95 }, g);
          }
          el('circle', { cx: 0, cy: 0, r: 4.2, fill: p.color, stroke: '#0d1120', 'stroke-width': 1.5 }, g);
        });
      });
    },
  };

  global.Board = Board;
  global.wedgeWheel = wedgeWheel;
})(window);
