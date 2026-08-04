/* Trivia Showdown - client */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // -------------------------------------------------------------- identity
  const store = {
    get(k, fallback) {
      try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch {}
    },
  };

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  let playerId = store.get('tsw.playerId');
  if (!playerId) {
    playerId = uid();
    store.set('tsw.playerId', playerId);
  }

  const app = {
    ws: null,
    connected: false,
    reconnectDelay: 500,
    board: null,
    state: null,
    code: null,
    clockSkew: 0,
    lastRollSeq: -1,
    chat: [],
    pendingAnswer: null,
    tab: 'log',
  };

  // ------------------------------------------------------------- websocket
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connect() {
    setConn('connecting');
    const ws = new WebSocket(wsUrl());
    app.ws = ws;

    ws.onopen = () => {
      app.connected = true;
      app.reconnectDelay = 500;
      setConn('online');
      // Rejoin automatically after a dropped connection or a page refresh.
      const remembered = sessionStorage.getItem('tsw.room') || app.code;
      if (remembered) send({ t: 'join', code: remembered, playerId, name: currentName() });
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };

    ws.onclose = () => {
      app.connected = false;
      setConn('offline');
      setTimeout(connect, app.reconnectDelay);
      app.reconnectDelay = Math.min(app.reconnectDelay * 1.7, 8000);
    };

    ws.onerror = () => {};
  }

  function send(msg) {
    if (app.ws && app.ws.readyState === 1) app.ws.send(JSON.stringify(msg));
  }

  // Keep the tunnel from timing the socket out while nobody is clicking.
  setInterval(() => send({ t: 'ping' }), 20000);

  function setConn(status) {
    const dot = $('#conn-dot');
    const text = $('#conn-text');
    if (!dot) return;
    dot.className = 'dot' + (status === 'online' ? ' on' : status === 'offline' ? ' off' : '');
    text.textContent = status === 'online' ? 'connected' : status === 'offline' ? 'reconnecting…' : 'connecting…';
  }

  function handle(msg) {
    switch (msg.t) {
      case 'joined':
        app.code = msg.code;
        app.board = msg.board;
        sessionStorage.setItem('tsw.room', msg.code);
        history.replaceState(null, '', '#' + msg.code);
        Board.init($('#board'), msg.board);
        showScreen('game');
        $('#room-code').textContent = msg.code;
        $('#invite-link').value = inviteLink(msg.code);
        break;

      case 'state':
        app.state = msg.state;
        app.clockSkew = msg.state.serverTime - Date.now();
        render();
        break;

      case 'chat':
        app.chat.push(msg);
        if (app.chat.length > 100) app.chat.shift();
        renderChat();
        if (app.tab !== 'chat') flashTab();
        break;

      case 'error':
        toast(msg.message);
        if (!app.code) homeError(msg.message);
        break;
    }
  }

  function inviteLink(code) {
    return `${location.origin}${location.pathname}#${code}`;
  }

  // ------------------------------------------------------------ home screen
  function currentName() {
    const v = ($('#input-name').value || '').trim();
    return v || 'Player';
  }

  function showScreen(which) {
    $('#screen-home').classList.toggle('active', which === 'home');
    $('#screen-game').classList.toggle('active', which === 'game');
  }

  function homeError(text) {
    const el = $('#home-error');
    el.textContent = text;
    el.hidden = !text;
  }

  $('#input-name').value = store.get('tsw.name', '');
  $('#input-name').addEventListener('input', () => store.set('tsw.name', $('#input-name').value));

  $('#btn-create').addEventListener('click', () => {
    homeError('');
    if (!app.connected) return homeError('Still connecting to the server…');
    store.set('tsw.name', currentName());
    send({
      t: 'create',
      playerId,
      name: currentName(),
      options: {
        wedgesToWin: Number($('#opt-wedges').value),
        answerSeconds: Number($('#opt-seconds').value),
        difficulty: $('#opt-difficulty').value,
      },
    });
  });

  function doJoin() {
    homeError('');
    const code = ($('#input-code').value || '').trim().toUpperCase();
    if (code.length !== 4) return homeError('Room codes are 4 characters.');
    if (!app.connected) return homeError('Still connecting to the server…');
    store.set('tsw.name', currentName());
    send({ t: 'join', code, playerId, name: currentName() });
  }
  $('#btn-join').addEventListener('click', doJoin);
  $('#input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('#input-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('#input-code').value.trim() ? doJoin() : $('#btn-create').click());
  });

  // deep link: /#ABCD
  const hashCode = (location.hash || '').replace('#', '').toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(hashCode)) {
    $('#input-code').value = hashCode;
    if (!sessionStorage.getItem('tsw.room')) sessionStorage.setItem('tsw.room', '');
  }

  // ------------------------------------------------------------ game header
  function copyInvite() {
    const link = inviteLink(app.code);
    navigator.clipboard?.writeText(link).then(
      () => toast('Invite link copied', true),
      () => toast('Copy failed - select the link manually')
    );
  }
  $('#btn-share').addEventListener('click', copyInvite);
  $('#btn-copy').addEventListener('click', copyInvite);

  $('#btn-quit').addEventListener('click', () => {
    send({ t: 'leave' });
    sessionStorage.removeItem('tsw.room');
    app.code = null;
    app.state = null;
    history.replaceState(null, '', location.pathname);
    showScreen('home');
  });

  $('#opt-wedges').addEventListener('change', pushOptions);
  $('#opt-seconds').addEventListener('change', pushOptions);
  $('#opt-difficulty').addEventListener('change', pushOptions);
  function pushOptions() {
    if (!app.code) return;
    send({
      t: 'setOptions',
      options: {
        wedgesToWin: Number($('#opt-wedges').value),
        answerSeconds: Number($('#opt-seconds').value),
        difficulty: $('#opt-difficulty').value,
      },
    });
  }

  $('#btn-start').addEventListener('click', () => send({ t: 'start' }));
  $('#btn-again').addEventListener('click', () => send({ t: 'playAgain' }));

  // ------------------------------------------------------------------ tabs
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      app.tab = tab.dataset.tab;
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== app.tab; });
      if (app.tab === 'chat') $('#chat-input').focus();
    });
  });
  function flashTab() {
    const t = $$('.tab').find((x) => x.dataset.tab === 'chat');
    if (!t) return;
    t.style.color = '#ffd166';
    setTimeout(() => { t.style.color = ''; }, 1200);
  }

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    send({ t: 'chat', text });
    input.value = '';
  });

  // ----------------------------------------------------------------- toast
  let toastTimer = null;
  function toast(text, good) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    el.style.background = good ? '#0f2418' : '';
    el.style.borderColor = good ? '#2c6b45' : '';
    el.style.color = good ? '#b7f0cd' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  // ---------------------------------------------------------------- render
  function me() {
    return app.state ? app.state.players.find((p) => p.id === playerId) : null;
  }
  function isMyTurn() {
    const s = app.state;
    return !!(s && s.turn && s.turn.playerId === playerId);
  }
  function playerById(id) {
    return app.state ? app.state.players.find((p) => p.id === id) : null;
  }
  function cats() {
    return app.board ? app.board.categories : [];
  }

  function render() {
    const s = app.state;
    if (!s || !app.board) return;

    renderLobbyPanel(s);
    renderPlayers(s);
    renderLog(s);
    renderControls(s);
    renderQuestion(s);
    renderCategoryChoice(s);
    renderWinner(s);

    const selectable = isMyTurn() && s.turn && s.turn.step === 'move'
      ? s.turn.options.map((o) => o.node)
      : [];
    Board.render(s, {
      selectable,
      youId: playerId,
      onSelect: (node) => send({ t: 'move', node }),
    });
  }

  function renderLobbyPanel(s) {
    const panel = $('#lobby-panel');
    const inLobby = s.phase === 'lobby';
    panel.hidden = !inLobby;
    if (!inLobby) return;

    const host = s.hostId === playerId;
    $('#opt-wedges').value = String(s.options.wedgesToWin);
    $('#opt-seconds').value = String(s.options.answerSeconds);
    $('#opt-difficulty').value = s.options.difficulty;
    $('#opt-wedges').disabled = !host;
    $('#opt-seconds').disabled = !host;
    $('#opt-difficulty').disabled = !host;
    // Harder questions mean more missed turns, which stretches the game out a
    // lot. Say so here rather than letting people find out an hour in.
    const blurb = {
      easy: 'General knowledge — most players will get a good share of these.',
      hard: 'Pub-quiz final round. Expect to miss plenty.',
      mixed: 'Draws from both tiers.',
    }[s.options.difficulty] || '';
    const slow = s.options.difficulty !== 'easy' && s.options.wedgesToWin >= 5;
    $('#settings-note').textContent = blurb
      + (slow ? ' At this wedge count that is a long session — 3 or 4 finishes in one sitting.' : '');

    $('#btn-start').disabled = !host;
    $('#btn-start').textContent = host ? 'Start game' : 'Waiting for the host…';
    $('#lobby-note').textContent = host
      ? (s.players.length < 2 ? 'You can start solo, but this is more fun with friends.' : `${s.players.length} players ready.`)
      : `${(playerById(s.hostId) || {}).name || 'The host'} will start the game.`;
  }

  function renderPlayers(s) {
    // Wedges only come from headquarters spaces, which is easy to miss - say so
    // rather than leaving people wondering why the counter never moves.
    const hint = $('#players-hint');
    hint.hidden = s.phase !== 'playing';
    hint.textContent = 'Wedges are won only on the six large headquarters spaces. '
      + 'Every other correct answer just earns you another roll.';

    const list = $('#player-list');
    list.innerHTML = '';
    s.players.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'player-row'
        + (s.turn && s.turn.playerId === p.id && s.phase === 'playing' ? ' is-turn' : '')
        + (p.id === playerId ? ' is-you' : '')
        + (p.connected ? '' : ' offline');

      const wheel = wedgeWheel(p.wedges, cats(), p.color);
      wheel.classList.add('pwheel');
      li.appendChild(wheel);

      const info = document.createElement('div');
      info.className = 'pinfo';
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = p.name;
      info.appendChild(name);

      const sub = document.createElement('span');
      sub.className = 'psub';
      sub.textContent = p.asked
        ? `${p.correct} of ${p.asked} correct`
        : (s.phase === 'playing' ? 'no questions yet' : 'ready');
      info.appendChild(sub);
      li.appendChild(info);

      if (s.hostId === p.id) {
        const tag = document.createElement('span');
        tag.className = 'host-tag';
        tag.textContent = 'host';
        li.appendChild(tag);
      }

      const score = document.createElement('div');
      score.className = 'pscore';
      const won = p.wedges.filter(Boolean).length;
      const big = document.createElement('b');
      big.textContent = `${won}/${s.wedgesToWin}`;
      if (won > 0) big.classList.add('has-wedges');
      const cap = document.createElement('span');
      cap.textContent = won === 1 ? 'wedge' : 'wedges';
      score.appendChild(big);
      score.appendChild(cap);
      li.appendChild(score);

      list.appendChild(li);
    });
  }

  function renderLog(s) {
    const list = $('#log-list');
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
    list.innerHTML = '';
    s.log.forEach((entry) => {
      const li = document.createElement('li');
      li.textContent = entry.text;
      list.appendChild(li);
    });
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  function renderChat() {
    const list = $('#chat-list');
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
    list.innerHTML = '';
    app.chat.forEach((m) => {
      const li = document.createElement('li');
      li.className = 'chat-line';
      const b = document.createElement('b');
      b.textContent = m.from + ': ';
      b.style.color = m.color || '';
      li.appendChild(b);
      li.appendChild(document.createTextNode(m.text));
      list.appendChild(li);
    });
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  function renderControls(s) {
    const banner = $('#turn-banner');
    const slot = $('#control-slot');
    slot.innerHTML = '';

    if (s.phase === 'lobby') {
      banner.innerHTML = `Waiting in the lobby &mdash; room <b>${s.code}</b>`;
      return;
    }
    if (s.phase === 'over') {
      const w = playerById(s.winnerId);
      banner.innerHTML = w ? `<b>${escapeHtml(w.name)}</b> won the game!` : 'Game over.';
      return;
    }

    const cur = playerById(s.turn && s.turn.playerId);
    if (!cur) return;
    const mine = isMyTurn();
    const who = mine ? 'Your' : `${escapeHtml(cur.name)}'s`;

    if (s.turn.roll != null) {
      const die = document.createElement('div');
      die.className = 'die' + (s.turn.rollSeq !== app.lastRollSeq ? ' rolling' : '');
      die.textContent = s.turn.roll;
      slot.appendChild(die);
      app.lastRollSeq = s.turn.rollSeq;
    }

    switch (s.turn.step) {
      case 'roll': {
        banner.innerHTML = `${who} turn`;
        if (mine) {
          const btn = document.createElement('button');
          btn.className = 'btn primary big';
          btn.textContent = 'Roll the die';
          btn.addEventListener('click', () => send({ t: 'roll' }));
          slot.appendChild(btn);
        } else {
          slot.appendChild(text(`Waiting for ${cur.name} to roll…`));
        }
        break;
      }
      case 'move': {
        banner.innerHTML = `${who} turn &mdash; rolled a <b>${s.turn.roll}</b>`;
        slot.appendChild(text(mine
          ? 'Click a highlighted space to move there.'
          : `${cur.name} is choosing a space…`));
        break;
      }
      case 'answer':
      case 'reveal':
        banner.innerHTML = `${who} turn`;
        break;
      case 'category':
        banner.innerHTML = `${who} turn &mdash; the final question!`;
        break;
    }

    // Rescue hatch for a stuck or absent player.
    const stalled = !cur.connected;
    if ((s.hostId === playerId && !mine) || (stalled && !mine)) {
      const skip = document.createElement('button');
      skip.className = 'btn small';
      skip.textContent = stalled ? `Skip ${cur.name} (offline)` : 'Skip turn';
      skip.addEventListener('click', () => send({ t: 'skip' }));
      slot.appendChild(skip);
    }
  }

  function text(t) {
    const span = document.createElement('span');
    span.style.color = 'var(--muted)';
    span.textContent = t;
    return span;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------- questions
  let timerRaf = null;

  function renderQuestion(s) {
    const overlay = $('#question-overlay');
    const q = s.question;

    if (!q || (s.turn && s.turn.step !== 'answer' && s.turn.step !== 'reveal')) {
      overlay.hidden = true;
      stopTimer();
      return;
    }

    const cat = cats()[q.category];
    const card = $('#question-card');
    card.style.setProperty('--cat', cat.color);
    overlay.hidden = false;

    $('#q-category').textContent = cat.name;
    const badge = $('#q-badge');
    badge.hidden = !(q.isHq || q.isFinal);
    badge.textContent = q.isFinal ? 'Winning question' : 'Headquarters — win a wedge';
    $('#q-text').textContent = q.text;

    const forMe = q.forId === playerId;
    const asker = playerById(q.forId);

    const box = $('#q-choices');
    box.innerHTML = '';
    q.choices.forEach((choice, i) => {
      const btn = document.createElement('button');
      btn.className = 'choice';
      btn.disabled = !forMe || q.revealed || app.pendingAnswer != null;

      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = 'ABCD'[i];
      btn.appendChild(key);
      btn.appendChild(document.createTextNode(choice));

      if (q.revealed) {
        if (i === q.correctIndex) btn.classList.add('correct');
        else if (i === q.chosenIndex) btn.classList.add('wrong');
        else btn.classList.add('dim');
      } else if (app.pendingAnswer === i) {
        btn.style.borderColor = cat.color;
      }

      btn.addEventListener('click', () => {
        if (!forMe || q.revealed) return;
        app.pendingAnswer = i;
        send({ t: 'answer', index: i });
        render();
      });
      box.appendChild(btn);
    });

    const status = $('#q-status');
    status.className = 'q-status';
    if (q.revealed) {
      app.pendingAnswer = null;
      if (q.wasCorrect) {
        status.classList.add('good');
        status.textContent = q.isFinal
          ? `Correct — ${asker ? asker.name : 'they'} win!`
          : q.isHq
            ? `Correct! ${forMe ? 'You win' : (asker ? asker.name + ' wins' : 'They win')} the ${cat.name} wedge.`
            : `Correct! ${forMe ? 'Roll again.' : (asker ? asker.name : 'They') + ' rolls again.'}`;
      } else {
        status.classList.add('bad');
        status.textContent = q.timedOut ? "Out of time — that's the end of the turn." : 'Wrong answer — turn over.';
      }
    } else if (forMe) {
      status.textContent = 'Pick an answer (or press A, B, C, D).';
    } else {
      status.textContent = `${asker ? asker.name : 'Someone'} is answering…`;
    }

    // countdown bar
    const bar = $('#q-timer');
    const deadline = s.turn && s.turn.deadline;
    if (!q.revealed && deadline && s.options.answerSeconds > 0) {
      bar.classList.remove('hidden');
      startTimer(deadline, s.options.answerSeconds * 1000);
    } else {
      bar.classList.add('hidden');
      stopTimer();
    }
  }

  function startTimer(deadline, total) {
    stopTimer();
    const fill = $('#q-timer i');
    const tick = () => {
      const left = deadline - (Date.now() + app.clockSkew);
      const pct = Math.max(0, Math.min(1, left / total));
      fill.style.width = (pct * 100).toFixed(1) + '%';
      fill.style.background = pct < 0.25 ? '#ef4444' : '';
      if (left > 0) timerRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopTimer() {
    if (timerRaf) cancelAnimationFrame(timerRaf);
    timerRaf = null;
  }

  document.addEventListener('keydown', (e) => {
    const s = app.state;
    if (!s || $('#question-overlay').hidden) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    const idx = 'abcd'.indexOf(e.key.toLowerCase());
    const num = '1234'.indexOf(e.key);
    const pick = idx >= 0 ? idx : num;
    if (pick < 0) return;
    const buttons = $$('#q-choices .choice');
    if (buttons[pick] && !buttons[pick].disabled) buttons[pick].click();
  });

  // ------------------------------------------------------- category choice
  function renderCategoryChoice(s) {
    const overlay = $('#category-overlay');
    if (!s.turn || s.turn.step !== 'category') {
      overlay.hidden = true;
      return;
    }
    overlay.hidden = false;

    const cur = playerById(s.turn.playerId);
    const chooser = playerById(s.turn.categoryChooserId);
    const iChoose = s.turn.categoryChooserId === playerId || s.hostId === playerId;

    $('#cat-title').textContent = `${cur ? cur.name : 'Someone'} is going for the win`;
    $('#cat-sub').textContent = iChoose
      ? 'Pick the category for the final question.'
      : `${chooser ? chooser.name : 'An opponent'} is picking the category…`;

    const box = $('#cat-choices');
    box.innerHTML = '';
    cats().forEach((c) => {
      const btn = document.createElement('button');
      btn.className = 'cat-btn';
      btn.style.setProperty('--c', c.color);
      btn.disabled = !iChoose;
      const icon = document.createElement('span');
      icon.className = 'ci';
      icon.textContent = c.short.toUpperCase();
      btn.appendChild(icon);
      btn.appendChild(document.createTextNode(c.name));
      btn.addEventListener('click', () => send({ t: 'chooseCategory', category: c.id }));
      box.appendChild(btn);
    });
  }

  // -------------------------------------------------------------- game over
  function renderWinner(s) {
    const overlay = $('#winner-overlay');
    if (s.phase !== 'over' || !s.winnerId) {
      overlay.hidden = true;
      return;
    }
    // Let the final reveal breathe before covering it.
    if (s.turn && s.turn.step === 'reveal') {
      overlay.hidden = true;
      return;
    }
    overlay.hidden = false;

    const w = playerById(s.winnerId);
    const holder = $('#winner-wheel');
    holder.innerHTML = '';
    if (w) holder.appendChild(wedgeWheel(w.wedges, cats(), w.color, 92));
    $('#winner-title').textContent = w
      ? (w.id === playerId ? 'You win!' : `${w.name} wins!`)
      : 'Game over';
    $('#winner-sub').textContent = w
      ? `${w.correct} of ${w.asked} questions answered correctly.`
      : '';
    const host = s.hostId === playerId;
    $('#btn-again').disabled = !host;
    $('#btn-again').textContent = host ? 'Play again' : 'Waiting for the host…';
  }

  // ---------------------------------------------------------------- boot
  $$('.brand-wheel').forEach((svg) => {
    const CATS = ['#2d7dd2', '#e0489f', '#eab308', '#9061f9', '#22c55e', '#f97316'];
    const NSU = 'http://www.w3.org/2000/svg';
    const circle = document.createElementNS(NSU, 'circle');
    circle.setAttribute('r', 46);
    circle.setAttribute('fill', '#0d1120');
    svg.appendChild(circle);
    for (let i = 0; i < 6; i++) {
      const a0 = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const a1 = ((i + 1) / 6) * Math.PI * 2 - Math.PI / 2;
      const p = document.createElementNS(NSU, 'path');
      p.setAttribute('d', `M 0 0 L ${(Math.cos(a0) * 44).toFixed(2)} ${(Math.sin(a0) * 44).toFixed(2)} A 44 44 0 0 1 ${(Math.cos(a1) * 44).toFixed(2)} ${(Math.sin(a1) * 44).toFixed(2)} Z`);
      p.setAttribute('fill', CATS[i]);
      svg.appendChild(p);
    }
    const inner = document.createElementNS(NSU, 'circle');
    inner.setAttribute('r', 15);
    inner.setAttribute('fill', '#0d1120');
    svg.appendChild(inner);
  });

  showScreen('home');
  connect();
})();
