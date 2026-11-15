/* Messages Online — клиент: комнаты, чат, файлы, поиск людей, шашки. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SIZE = 8;

  const state = {
    me: null,
    room: null,
    online: [],
    rooms: [],
    messages: [],
    game: null,
    view: 'chat',
    filter: '',
    typing: new Map(),
    challenges: new Map(),
    lastDrawKey: null,
    limits: { fileBytes: 8 * 1024 * 1024, roomBytes: 120 * 1024 * 1024, textLength: 2000 },
    ws: null,
    attempts: 0,
    lastRoomCode: null,
  };

  /* ---------------- утилиты ---------------- */

  const fmtTime = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return time;
    return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`;
  };

  const fmtSize = (bytes) => {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  };

  const initial = (name) => (String(name || '?').trim().charAt(0) || '?').toUpperCase();
  const sameCell = (a, b) => Boolean(a && b) && a[0] === b[0] && a[1] === b[1];

  const fmtCode = (code) => {
    if (!code) return '';
    if (code === 'MAIN') return 'общий';
    return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
  };

  function fileIcon(name, mime) {
    const type = String(mime || '');
    if (type.startsWith('image/')) return '🖼';
    if (type.startsWith('video/')) return '🎬';
    if (type.startsWith('audio/')) return '🎵';
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return '📦';
    if (['pdf'].includes(ext)) return '📕';
    if (['doc', 'docx', 'rtf', 'txt', 'md'].includes(ext)) return '📄';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
    return '📎';
  }

  /* ---------------- тосты ---------------- */

  function toast(text, level, actions, ttl) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${level || 'info'}`;

    const span = document.createElement('span');
    span.className = 't-text';
    span.textContent = text;
    el.appendChild(span);

    if (actions && actions.length) {
      const wrap = document.createElement('div');
      wrap.className = 'toast-actions';
      actions.forEach((action) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn ${action.cls || ''}`;
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
          el.remove();
          if (action.onClick) action.onClick();
        });
        wrap.appendChild(btn);
      });
      el.appendChild(wrap);
    }

    box.appendChild(el);
    const life = ttl || (actions && actions.length ? 60000 : 4000);
    const timer = setTimeout(() => el.remove(), life);
    el.dataset.ttl = String(life);
    el.addEventListener('click', (event) => {
      if (event.target === el || event.target === span) {
        clearTimeout(timer);
        el.remove();
      }
    });
    return el;
  }

  /* ---------------- WebSocket ---------------- */

  function connect() {
    const params = new URLSearchParams(location.search);
    const room = params.get('room') || '';
    const name = localStorage.getItem('mo-name') || '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`;

    const ws = new WebSocket(url);
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.attempts = 0;
      setConn('on', 'на связи');
    });

    ws.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      handle(data);
    });

    ws.addEventListener('close', () => {
      setConn('off', 'нет связи — переподключаюсь');
      const delay = Math.min(1000 * 2 ** state.attempts, 10000);
      state.attempts += 1;
      setTimeout(connect, delay);
    });

    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  function send(type, payload) {
    const ws = state.ws;
    if (!ws || ws.readyState !== 1) {
      toast('Нет соединения с сервером', 'err');
      return false;
    }
    ws.send(JSON.stringify({ type, ...(payload || {}) }));
    return true;
  }

  function setConn(mode, text) {
    const el = $('connState');
    el.dataset.state = mode === 'on' ? 'on' : mode === 'off' ? 'off' : 'connecting';
    el.textContent = text;
  }

  function handle(data) {
    switch (data.type) {
      case 'welcome': {
        state.me = data.you;
        state.online = data.online || [];
        state.rooms = data.rooms || [];
        state.messages = data.history || [];
        state.room = data.room;
        state.game = data.game || null;
        state.limits = data.limits || state.limits;
        state.lastRoomCode = data.room.code;
        localStorage.setItem('mo-name', data.you.name);
        syncMe();
        renderAll();
        break;
      }

      case 'room': {
        const previous = state.lastRoomCode;
        state.room = data.room;
        state.lastRoomCode = data.room.code;
        if (Array.isArray(data.history)) state.messages = data.history;
        if (previous !== data.room.code) state.game = null;
        closeDrawer();
        syncRoom();
        renderMessages();
        renderFiles();
        renderPeople();
        renderRooms();
        break;
      }

      case 'message': {
        state.messages.push(data.message);
        if (state.messages.length > 260) state.messages.shift();
        renderMessages();
        markActivity(data.message);
        break;
      }

      case 'online':
        state.online = data.users || [];
        renderPeople();
        renderOnlineCount();
        break;

      case 'rooms':
        state.rooms = data.rooms || [];
        renderRooms();
        break;

      case 'game': {
        const next = data.game || null;
        const myId = state.me ? state.me.id : null;
        const mySide = next && myId
          ? next.white.id === myId
            ? 'w'
            : next.black.id === myId
              ? 'b'
              : null
          : null;
        const isNew = Boolean(next && (!state.game || state.game.id !== next.id));
        state.game = next;

        if (state.view === 'game') $('gameBadge').classList.add('hidden');
        else if (next) $('gameBadge').classList.remove('hidden');

        renderGame();

        if (isNew && mySide && next.status === 'playing') {
          setView('game');
          toast(`Партия началась. Вы играете ${mySide === 'w' ? 'белыми' : 'чёрными'}`, 'ok');
        }

        const offerKey = next && next.drawOfferBy ? `${next.id}:${next.drawOfferBy}` : null;
        if (offerKey && offerKey !== state.lastDrawKey && mySide && next.drawOfferBy !== mySide) {
          toast('Соперник предлагает ничью', 'warn', [
            { label: 'Согласиться', cls: 'accent', onClick: () => send('gameDrawReply', { accept: true }) },
            { label: 'Играть', cls: 'ghost', onClick: () => send('gameDrawReply', { accept: false }) },
          ], 30000);
        }
        state.lastDrawKey = offerKey;
        break;
      }

      case 'typing': {
        const user = data.user;
        if (!user || (state.me && user.id === state.me.id)) break;
        state.typing.set(user.id, { name: user.name, until: Date.now() + 2600 });
        renderTyping();
        break;
      }

      case 'notice':
        if (data.text) toast(data.text, data.level === 'err' ? 'err' : data.level === 'ok' ? 'ok' : 'info');
        break;

      case 'challenge':
        showChallenge(data.challenge);
        break;

      case 'challengeGone': {
        const entry = state.challenges.get(data.id);
        if (entry) {
          entry.el.remove();
          state.challenges.delete(data.id);
        }
        break;
      }

      case 'invite':
        showInvite(data.invite);
        break;

      default:
        break;
    }
  }

  function showChallenge(challenge) {
    if (!challenge) return;
    const el = toast(
      `${challenge.from.name} вызывает вас на шашки`,
      'warn',
      [
        {
          label: 'Принять',
          cls: 'accent',
          onClick: () => {
            state.challenges.delete(challenge.id);
            send('challengeReply', { id: challenge.id, accept: true });
          },
        },
        {
          label: 'Отказ',
          cls: 'ghost',
          onClick: () => {
            state.challenges.delete(challenge.id);
            send('challengeReply', { id: challenge.id, accept: false });
          },
        },
      ],
      55000,
    );
    state.challenges.set(challenge.id, { el });
  }

  function showInvite(invite) {
    if (!invite) return;
    toast(
      `${invite.from.name} зовёт в комнату «${invite.roomName}»`,
      'ok',
      [
        {
          label: 'Войти',
          cls: 'accent',
          onClick: () => send('joinRoom', { code: invite.roomCode }),
        },
      ],
      45000,
    );
  }

  /* ---------------- отрисовка ---------------- */

  function syncMe() {
    if (!state.me) return;
    $('meName').textContent = state.me.name;
    $('meDot').style.background = state.me.color;
    $('meId').textContent = `#${state.me.id}`;
    document.title = `${state.room ? state.room.name : 'Messages'} — Messages Online`;
  }

  function syncRoom() {
    if (!state.room) return;
    $('roomName').textContent = state.room.name;
    $('roomCode').textContent = fmtCode(state.room.code);
    const url = state.room.code === 'MAIN'
      ? location.pathname
      : `${location.pathname}?room=${state.room.code}`;
    try {
      history.replaceState(null, '', url);
    } catch {
      /* ignore */
    }
    $('filesCount').textContent = String(state.room.files.length);
    $('filesCount').classList.toggle('hidden', !state.room.files.length);
    document.title = `${state.room.name} — Messages Online`;
  }

  function renderAll() {
    syncMe();
    syncRoom();
    renderMessages();
    renderPeople();
    renderRooms();
    renderFiles();
    renderOnlineCount();
    renderGame();
  }

  function renderOnlineCount() {
    $('onlineCount').textContent = String(state.online.length);
  }

  function markActivity(message) {
    if (state.view === 'chat' || !message) return;
    if (message.kind === 'file') {
      const badge = $('filesCount');
      badge.classList.remove('hidden');
    }
  }

  function messageKey(message) {
    return message.id;
  }

  function renderMessages() {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    const wasEmpty = box.childElementCount === 0;
    box.innerHTML = '';
    const fragment = document.createDocumentFragment();

    state.messages.forEach((message) => {
      if (message.kind === 'system') {
        const sys = document.createElement('div');
        sys.className = 'msg-system';
        sys.textContent = message.text;
        fragment.appendChild(sys);
        return;
      }
      fragment.appendChild(renderMessage(message));
    });

    box.appendChild(fragment);
    if (nearBottom || wasEmpty) box.scrollTop = box.scrollHeight;
  }

  function renderMessage(message) {
    const mine = Boolean(state.me && message.by && message.by.id === state.me.id);
    const row = document.createElement('div');
    row.className = `msg${mine ? ' mine' : ''}`;
    row.dataset.key = messageKey(message);

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = (message.by && message.by.color) || '#38e8c8';
    avatar.textContent = initial(message.by && message.by.name);
    row.appendChild(avatar);

    const body = document.createElement('div');
    body.className = 'msg-body';

    const head = document.createElement('div');
    head.className = 'msg-head';
    const name = document.createElement('span');
    name.className = 'msg-name';
    name.textContent = mine ? 'вы' : (message.by && message.by.name) || 'гость';
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = fmtTime(message.at);
    head.append(name, time);
    body.appendChild(head);

    if (message.kind === 'file' && message.file) {
      body.appendChild(renderFileBubble(message.file));
    } else {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = message.text;
      body.appendChild(bubble);
    }

    row.appendChild(body);
    return row;
  }

  function renderFileBubble(file) {
    const link = document.createElement('a');
    link.className = 'file-bubble';
    link.href = file.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';

    if (String(file.mime || '').startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'file-thumb';
      img.src = file.url;
      img.alt = file.name;
      img.loading = 'lazy';
      link.appendChild(img);
    } else {
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = fileIcon(file.name, file.mime);
      link.appendChild(icon);
    }

    const meta = document.createElement('span');
    meta.style.minWidth = '0';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const sub = document.createElement('span');
    sub.className = 'file-sub';
    sub.textContent = `${fmtSize(file.size)} · скачать`;
    name.style.display = 'block';
    sub.style.display = 'block';
    meta.append(name, sub);
    link.appendChild(meta);
    return link;
  }

  function renderPeople() {
    const query = state.filter.trim().toLowerCase();
    const list = state.online.filter((user) => !query || user.name.toLowerCase().includes(query));
    const box = $('people');
    box.innerHTML = '';

    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = query ? 'Никого не нашли' : 'Пока никого нет';
      box.appendChild(empty);
      renderGamePeople();
      return;
    }

    list.forEach((user) => {
      const row = document.createElement('div');
      row.className = `person${state.me && user.id === state.me.id ? ' is-me' : ''}`;

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = user.color;

      const info = document.createElement('div');
      info.className = 'p-info';
      const name = document.createElement('div');
      name.className = 'p-name';
      if (query) {
        const index = user.name.toLowerCase().indexOf(query);
        if (index >= 0) {
          name.append(document.createTextNode(user.name.slice(0, index)));
          const mark = document.createElement('b');
          mark.textContent = user.name.slice(index, index + query.length);
          name.append(mark, document.createTextNode(user.name.slice(index + query.length)));
        } else {
          name.textContent = user.name;
        }
      } else {
        name.textContent = user.name;
      }

      const room = document.createElement('div');
      room.className = 'p-room';
      room.textContent = user.inGame
        ? 'играет в шашки'
        : user.id === (state.me && state.me.id)
          ? 'это вы'
          : `в «${user.roomName}»`;

      info.append(name, room);
      row.append(dot, info);

      const actions = document.createElement('div');
      actions.className = 'p-actions';

      if (!state.me || user.id !== state.me.id) {
        if (!user.inGame) {
          const fight = document.createElement('button');
          fight.type = 'button';
          fight.className = 'p-btn';
          fight.title = 'Вызвать на шашки';
          fight.textContent = '⚔';
          fight.addEventListener('click', () => send('challenge', { toId: user.id }));
          actions.appendChild(fight);
        }

        if (!state.room || user.roomCode !== state.room.code) {
          const invite = document.createElement('button');
          invite.type = 'button';
          invite.className = 'p-btn';
          invite.title = 'Пригласить в свою комнату';
          invite.textContent = '✉';
          invite.addEventListener('click', () => send('invite', { toId: user.id }));
          actions.appendChild(invite);
        }
      }

      row.appendChild(actions);
      box.appendChild(row);
    });

    renderGamePeople();
  }

  function renderGamePeople() {
    const box = $('gamePeople');
    if (!box) return;
    box.innerHTML = '';
    const others = state.online.filter((user) => !state.me || user.id !== state.me.id);

    if (!others.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'Никого нет — позовите кого-нибудь по ссылке.';
      box.appendChild(empty);
      return;
    }

    others.forEach((user) => {
      const row = document.createElement('div');
      row.className = 'person';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = user.color;

      const info = document.createElement('div');
      info.className = 'p-info';
      const name = document.createElement('div');
      name.className = 'p-name';
      name.textContent = user.name;
      const sub = document.createElement('div');
      sub.className = 'p-room';
      sub.textContent = user.inGame ? 'уже играет' : `в «${user.roomName}»`;
      info.append(name, sub);

      row.append(dot, info);

      if (!user.inGame) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'p-btn';
        btn.title = 'Вызвать на шашки';
        btn.textContent = '⚔';
        btn.addEventListener('click', () => send('challenge', { toId: user.id }));
        row.appendChild(btn);
      }

      box.appendChild(row);
    });
  }

  function renderRooms() {
    const box = $('roomsList');
    box.innerHTML = '';
    const current = state.room ? state.room.code : null;

    state.rooms.forEach((room) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `room-item${room.code === current ? ' current' : ''}`;

      const name = document.createElement('span');
      name.className = 'r-name';
      name.textContent = room.main ? 'Общий чат' : room.name;

      const code = document.createElement('span');
      code.className = 'r-code';
      code.textContent = room.main ? '' : fmtCode(room.code);

      const count = document.createElement('span');
      count.className = 'r-count';
      count.textContent = String(room.members);

      btn.append(name, code, count);
      btn.addEventListener('click', () => {
        if (room.code === current) return closeDrawer();
        send('joinRoom', { code: room.code });
      });
      box.appendChild(btn);
    });
  }

  function renderFiles() {
    const grid = $('filesGrid');
    const files = state.room ? state.room.files : [];
    grid.innerHTML = '';
    $('filesEmpty').classList.toggle('hidden', files.length > 0);
    $('filesCount').textContent = String(files.length);
    $('filesCount').classList.toggle('hidden', !files.length);

    if (state.room) {
      const total = files.reduce((sum, file) => sum + file.size, 0);
      $('filesInfo').textContent = files.length
        ? `${files.length} файл(ов) · ${fmtSize(total)} из ${fmtSize(state.limits.roomBytes)}`
        : `До ${fmtSize(state.limits.fileBytes)} на файл. Всё живёт в памяти сервера.`;
    }

    files.forEach((file) => {
      const card = document.createElement('a');
      card.className = 'file-card';
      card.href = file.url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';

      const preview = document.createElement('div');
      preview.className = 'file-preview';
      if (String(file.mime || '').startsWith('image/')) {
        const img = document.createElement('img');
        img.src = file.url;
        img.alt = file.name;
        img.loading = 'lazy';
        preview.appendChild(img);
      } else {
        preview.textContent = fileIcon(file.name, file.mime);
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = file.name;
      const sub = document.createElement('span');
      sub.className = 'fsub';
      sub.textContent = `${fmtSize(file.size)} · ${file.by ? file.by.name : 'гость'}`;
      meta.append(name, sub);

      card.append(preview, meta);
      grid.appendChild(card);
    });
  }

  /* ---------------- шашки ---------------- */

  const board = window.CheckersUI.create($('board'), {
    onMove: (from, to) => send('gameMove', { from, to }),
  });

  function sideOf(game, id) {
    if (!game || !id) return null;
    if (game.white && game.white.id === id) return 'w';
    if (game.black && game.black.id === id) return 'b';
    return null;
  }

  function setPlayer(el, player, isTurn, side) {
    const dot = el.querySelector('.pdot');
    const name = el.querySelector('.pname');
    const status = el.querySelector('.pstate');
    dot.dataset.color = side;
    dot.style.background = player ? player.color : '';
    name.textContent = player ? player.name : '—';
    el.classList.toggle('turn', Boolean(isTurn));
    if (!player) status.textContent = '';
    else if (state.me && player.id === state.me.id) status.textContent = 'вы';
    else status.textContent = isTurn ? 'ходит' : '';
  }

  function renderGame() {
    const game = state.game;
    const me = state.me ? state.me.id : null;
    const side = sideOf(game, me);

    board.update(game, me);

    if (!game) {
      setPlayer($('pWhite'), null, false, 'w');
      setPlayer($('pBlack'), null, false, 'b');
      $('gameStatus').textContent = 'Партии нет. Выберите соперника в списке — он получит вызов.';
      $('gameOverlay').classList.add('hidden');
      $('resignBtn').classList.add('hidden');
      $('drawBtn').classList.add('hidden');
      $('rematchBtn').classList.add('hidden');
      $('drawOffer').classList.add('hidden');
      return;
    }

    setPlayer($('pWhite'), game.white, game.turn === 'w', 'w');
    setPlayer($('pBlack'), game.black, game.turn === 'b', 'b');

    const overlay = $('gameOverlay');
    const status = $('gameStatus');

    if (game.status === 'over') {
      let text;
      if (game.winner === null || game.winner === undefined) {
        text = game.reason === 'draw' ? 'Ничья' : 'Партия окончена';
      } else {
        const winner = game.winner === 'w' ? game.white : game.black;
        text = `${winner ? winner.name : 'Победитель'} победил`;
      }
      overlay.innerHTML = '';
      const strong = document.createElement('div');
      const marked = document.createElement('b');
      marked.textContent = text;
      strong.appendChild(marked);
      const hint = document.createElement('div');
      hint.style.marginTop = '6px';
      hint.style.fontSize = '12px';
      hint.style.color = '#9fb0c4';
      hint.textContent = side ? 'Можно сыграть ещё одну партию.' : 'Наблюдение за партией.';
      overlay.append(strong, hint);
      overlay.classList.remove('hidden');
      status.textContent = text;
    } else {
      overlay.classList.add('hidden');
      if (!side) status.textContent = 'Вы наблюдаете. Партия идёт.';
      else if (game.turn !== side) status.textContent = 'Ход соперника.';
      else {
        const onlyCaptures = game.moves && game.moves.length && game.moves.every((m) => m.capture);
        status.textContent = game.pendingFrom
          ? 'Бой нужно продолжить этой же фигурой.'
          : onlyCaptures
            ? 'Ваш ход. Есть обязательный бой — подсвечен красным.'
            : 'Ваш ход.';
      }
    }

    $('resignBtn').classList.toggle('hidden', !side || game.status !== 'playing');
    $('drawBtn').classList.toggle('hidden', !side || game.status !== 'playing');
    $('rematchBtn').classList.toggle('hidden', !side || game.status === 'playing');

    const offer = $('drawOffer');
    if (side && game.status === 'playing' && game.drawOfferBy && game.drawOfferBy !== side) {
      offer.classList.remove('hidden');
      offer.innerHTML = '';
      const text = document.createElement('span');
      text.textContent = 'Соперник предлагает ничью';
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'btn accent';
      yes.textContent = 'Согласиться';
      yes.addEventListener('click', () => send('gameDrawReply', { accept: true }));
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'btn ghost';
      no.textContent = 'Нет';
      no.addEventListener('click', () => send('gameDrawReply', { accept: false }));
      offer.append(text, yes, no);
    } else {
      offer.classList.add('hidden');
    }
  }

  /* ---------------- вкладки и меню ---------------- */

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.view === view);
    });
    document.querySelectorAll('.view').forEach((section) => {
      section.classList.toggle('active', section.id === `view-${view}`);
    });
    if (view === 'game') {
      $('gameBadge').classList.add('hidden');
      renderGame();
    }
    if (view === 'chat') {
      const box = $('messages');
      box.scrollTop = box.scrollHeight;
    }
    if (view === 'files') renderFiles();
  }

  function openDrawer() {
    $('sidebar').classList.add('open');
    document.body.classList.add('nav-open');
  }

  function closeDrawer() {
    $('sidebar').classList.remove('open');
    document.body.classList.remove('nav-open');
  }

  function copyRoomLink() {
    if (!state.room) return;
    const link = state.room.code === 'MAIN'
      ? location.origin + location.pathname
      : `${location.origin}${location.pathname}?room=${state.room.code}`;
    const done = () => toast(`Ссылка скопирована: ${state.room.code === 'MAIN' ? 'общий чат' : state.room.code}`, 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, () => toast(link, 'info'));
    } else {
      toast(link, 'info');
    }
  }

  /* ---------------- загрузка файлов ---------------- */

  function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    files.forEach((file) => {
      if (file.size > state.limits.fileBytes) {
        toast(`«${file.name}» больше ${fmtSize(state.limits.fileBytes)}`, 'err');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        if (comma < 0) return;
        const ok = send('upload', {
          name: file.name,
          mime: file.type || 'application/octet-stream',
          data: result.slice(comma + 1),
        });
        if (ok) toast(`«${file.name}» отправляется`, 'info', null, 2200);
      };
      reader.onerror = () => toast(`Не удалось прочитать «${file.name}»`, 'err');
      reader.readAsDataURL(file);
    });
  }

  /* ---------------- события ---------------- */

  function bindEvents() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => setView(tab.dataset.view));
    });

    $('menuBtn').addEventListener('click', openDrawer);
    $('sideClose').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);

    $('meBtn').addEventListener('click', () => {
      const next = prompt('Как вас зовут?', state.me ? state.me.name : '');
      if (next === null) return;
      const name = next.trim().slice(0, 24);
      if (!name) return toast('Имя не может быть пустым', 'err');
      if (send('setName', { name })) {
        state.me.name = name;
        localStorage.setItem('mo-name', name);
        syncMe();
      }
    });

    $('roomBtn').addEventListener('click', copyRoomLink);
    $('copyLink').addEventListener('click', copyRoomLink);

    $('createRoom').addEventListener('click', () => {
      const name = prompt('Название комнаты', `Комната ${state.me ? state.me.name : ''}`.trim());
      if (name === null) return;
      const isPublic = confirm('Показывать комнату в списке публичных?');
      send('createRoom', { name: name.trim().slice(0, 40), isPublic });
    });

    $('joinForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const code = $('codeInput').value.trim();
      if (!code) return;
      send('joinRoom', { code });
      $('codeInput').value = '';
    });

    $('searchUsers').addEventListener('input', (event) => {
      state.filter = event.target.value;
      renderPeople();
    });

    // чат
    const input = $('msgInput');
    const composer = $('composer');
    let typingAt = 0;

    function autosize() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    }

    input.addEventListener('input', () => {
      autosize();
      const now = Date.now();
      if (now - typingAt > 2200 && input.value.trim()) {
        typingAt = now;
        send('typing', {});
      }
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        composer.requestSubmit();
      }
    });

    composer.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      if (send('chat', { text })) {
        input.value = '';
        autosize();
      }
    });

    $('attachBtn').addEventListener('click', () => $('fileInput').click());
    $('uploadBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (event) => {
      uploadFiles(event.target.files);
      event.target.value = '';
    });

    // drag & drop
    let dragDepth = 0;
    window.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
      dragDepth += 1;
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragover', (event) => {
      if (event.dataTransfer) event.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('dragging');
    });
    window.addEventListener('drop', (event) => {
      event.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging');
      if (event.dataTransfer && event.dataTransfer.files.length) uploadFiles(event.dataTransfer.files);
    });

    // кнопки игры
    $('resignBtn').addEventListener('click', () => {
      if (confirm('Сдаться?')) send('gameResign', {});
    });
    $('drawBtn').addEventListener('click', () => send('gameDrawOffer', {}));
    $('rematchBtn').addEventListener('click', () => send('gameNew', {}));

    // типинг-индикатор: чистим просроченные
    setInterval(() => {
      let changed = false;
      const now = Date.now();
      for (const [id, item] of state.typing) {
        if (item.until < now) {
          state.typing.delete(id);
          changed = true;
        }
      }
      if (changed) renderTyping();
    }, 900);

    // пинг, чтобы прокси не рвали соединение
    setInterval(() => {
      if (state.ws && state.ws.readyState === 1) send('ping', {});
    }, 25000);

    window.addEventListener('resize', () => {
      if (window.innerWidth > 900) closeDrawer();
    });
  }

  function renderTyping() {
    const names = [...state.typing.values()].map((item) => item.name);
    const box = $('typing');
    if (!names.length) {
      box.textContent = '';
      return;
    }
    const label = names.length === 1
      ? `${names[0]} печатает…`
      : `${names.slice(0, 2).join(', ')} печатают…`;
    box.textContent = label;
  }

  /* ---------------- старт ---------------- */

  function init() {
    bindEvents();
    board.update(null, null);
    setView('chat');
    connect();
    renderGame();
  }

  init();
}());
