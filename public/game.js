// ═══════════════════════════════════════════
// State
// ═══════════════════════════════════════════

const socket = io();

let myPosition = -1;
let isHost = false;
let hasSubmitted = false;
let currentPhase = null; // 'draw' | 'guess'
let timerInterval = null;
let p5sketch = null;

// Reveal state
let revealChains = [];
let revealPlayers = [];
let currentChainIdx = 0;

// ═══════════════════════════════════════════
// Screen / Phase helpers
// ═══════════════════════════════════════════

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showPhase(id) {
  document.querySelectorAll('.phase').forEach(p => p.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════
// Home screen
// ═══════════════════════════════════════════

document.getElementById('btn-create').addEventListener('click', () => {
  const name = document.getElementById('home-name').value.trim();
  if (!name) { showHomeError('Enter your name first'); return; }
  clearHomeError();
  socket.emit('create_room', { name });
});

document.getElementById('btn-join-toggle').addEventListener('click', () => {
  const form = document.getElementById('join-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    document.getElementById('home-code').focus();
  }
});

document.getElementById('btn-join').addEventListener('click', doJoin);

document.getElementById('home-code').addEventListener('keydown', e => {
  if (e.key === 'Enter') doJoin();
  // Auto uppercase
  setTimeout(() => {
    e.target.value = e.target.value.toUpperCase();
  }, 0);
});

function doJoin() {
  const name = document.getElementById('home-name').value.trim();
  const code = document.getElementById('home-code').value.trim().toUpperCase();
  if (!name) { showHomeError('Enter your name first'); return; }
  if (code.length < 2) { showHomeError('Enter a room code'); return; }
  clearHomeError();
  socket.emit('join_room', { name, code });
}

function showHomeError(msg) {
  const el = document.getElementById('home-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearHomeError() {
  document.getElementById('home-error').classList.add('hidden');
}

// ═══════════════════════════════════════════
// Lobby screen
// ═══════════════════════════════════════════

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('start_game');
});

function renderPlayers(players) {
  const list = document.getElementById('player-list');
  list.innerHTML = players.map(p => `
    <div class="player-row">
      <span class="player-num">#${p.position + 1}</span>
      ${p.isHost ? '<span class="player-host-badge">Host</span>' : ''}
      <span>${esc(p.name)}</span>
      ${!p.connected ? '<span class="player-offline">left</span>' : ''}
    </div>
  `).join('');
}

// ═══════════════════════════════════════════
// Timer
// ═══════════════════════════════════════════

function startTimer(seconds) {
  clearInterval(timerInterval);
  hasSubmitted = false;
  let remaining = seconds;

  const fill = document.getElementById('timer-bar-fill');
  const num = document.getElementById('timer-num');

  function tick() {
    const ratio = remaining / seconds;
    fill.style.width = (ratio * 100) + '%';
    fill.style.backgroundColor =
      ratio > 0.5 ? 'var(--green)' :
      ratio > 0.25 ? 'var(--yellow)' : 'var(--red)';
    num.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(timerInterval);
      if (!hasSubmitted) autoSubmit();
    }
    remaining--;
  }

  tick();
  timerInterval = setInterval(tick, 1000);
}

function autoSubmit() {
  if (hasSubmitted) return;
  if (currentPhase === 'draw') submitDrawing();
  else if (currentPhase === 'guess') submitGuess();
}

// ═══════════════════════════════════════════
// p5.js Drawing
// ═══════════════════════════════════════════

const ALL_COLORS = [
  '#e63946', '#f4a261', '#ffd166', '#06d6a0',
  '#118ab2', '#9b59b6', '#ec4899', '#92400e',
  '#2ecc71', '#e67e22', '#1abc9c', '#3498db',
  '#e74c3c', '#8e44ad', '#f39c12', '#16a085'
];

function pickTwoColors() {
  const shuffled = ALL_COLORS.slice().sort(() => Math.random() - 0.5);
  return [{ hex: '#000000' }, { hex: shuffled[0] }];
}

function initDrawing() {
  if (p5sketch) { p5sketch.remove(); p5sketch = null; }

  const wrap = document.getElementById('canvas-wrap');
  wrap.innerHTML = '';

  const sz = Math.min(window.innerWidth - 32, 460);
  const colors = pickTwoColors();

  // Build palette UI — just the 2 colors
  const paletteEl = document.getElementById('palette');
  paletteEl.innerHTML = colors.map((c, i) =>
    `<div class="swatch${i === 0 ? ' active' : ''}"
         data-color="${c.hex}"
         style="background:${c.hex}"></div>`
  ).join('');

  let activeColor = colors[0].hex;
  let eraserOn = false;
  let brushSize = 6;

  paletteEl.querySelectorAll('.swatch').forEach(el => {
    el.addEventListener('click', () => {
      activeColor = el.dataset.color;
      eraserOn = false;
      document.getElementById('btn-eraser').dataset.active = 'false';
      paletteEl.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
      if (p5sketch) p5sketch._setColor(activeColor);
    });
  });

  document.getElementById('btn-eraser').onclick = () => {
    eraserOn = !eraserOn;
    document.getElementById('btn-eraser').dataset.active = String(eraserOn);
    if (p5sketch) p5sketch._setEraser(eraserOn);
  };

  document.getElementById('btn-clear').onclick = () => {
    if (p5sketch) p5sketch._clear();
  };

  document.getElementById('brush-size').oninput = (e) => {
    brushSize = parseInt(e.target.value);
    if (p5sketch) p5sketch._setSize(brushSize);
  };

  const sketch = (p) => {
    let canvas;
    let col = colors[0].hex;
    let sz2 = sz;
    let bsz = 6;
    let eraser = false;
    let drawing = false;

    p.setup = () => {
      canvas = p.createCanvas(sz2, sz2);
      canvas.parent(wrap);
      p.background(255);
      canvas.elt.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    };

    p.draw = () => {};

    function inBounds() {
      return p.mouseX >= 0 && p.mouseX <= p.width && p.mouseY >= 0 && p.mouseY <= p.height;
    }

    function paint() {
      if (!drawing) return;
      p.stroke(eraser ? '#ffffff' : col);
      p.strokeWeight(eraser ? bsz * 4 : bsz);
      p.strokeCap(p.ROUND);
      p.noFill();
      p.line(p.pmouseX, p.pmouseY, p.mouseX, p.mouseY);
    }

    function startDraw() {
      if (inBounds()) {
        drawing = true;
        p.stroke(eraser ? '#ffffff' : col);
        p.strokeWeight(eraser ? bsz * 4 : bsz);
        p.strokeCap(p.ROUND);
        p.noFill();
        p.point(p.mouseX, p.mouseY);
      }
    }

    p.mousePressed = () => { startDraw(); };
    p.mouseReleased = () => { drawing = false; };
    p.mouseDragged = () => { paint(); };

    p.touchStarted = () => { startDraw(); return false; };
    p.touchEnded = () => { drawing = false; return false; };
    p.touchMoved = () => { paint(); return false; };

    // Exposed API (called on p5Instance from outside)
    p._setColor = (c) => { col = c; eraser = false; };
    p._setEraser = (v) => { eraser = v; };
    p._setSize = (s) => { bsz = s; };
    p._clear = () => { p.background(255); };
    p._getDataURL = () => canvas.elt.toDataURL('image/jpeg', 0.75);
  };

  p5sketch = new p5(sketch);
}

// ═══════════════════════════════════════════
// Submit drawing / guess
// ═══════════════════════════════════════════

document.getElementById('btn-submit-draw').addEventListener('click', submitDrawing);
document.getElementById('btn-submit-guess').addEventListener('click', submitGuess);

document.getElementById('guess-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitGuess();
});

function submitDrawing() {
  if (hasSubmitted) return;
  hasSubmitted = true;
  // Keep timer running so others can see countdown; autoSubmit is guarded by hasSubmitted
  const data = p5sketch ? p5sketch._getDataURL() : null;
  socket.emit('submit', { content: data });
  showPhase('phase-wait');
}

function submitGuess() {
  if (hasSubmitted) return;
  hasSubmitted = true;
  const val = document.getElementById('guess-input').value.trim() || '???';
  socket.emit('submit', { content: val });
  showPhase('phase-wait');
}

// ═══════════════════════════════════════════
// Reveal
// ═══════════════════════════════════════════

function initReveal(chains, players) {
  revealChains = chains;
  revealPlayers = players;
  currentChainIdx = 0;
  renderRevealNav();
  renderCurrentChain();
}

function renderRevealNav() {
  const nav = document.getElementById('reveal-nav');
  nav.innerHTML = revealChains.map((_, i) => {
    const owner = revealPlayers.find(p => p.position === i);
    const done = i < currentChainIdx ? ' done' : '';
    const active = i === currentChainIdx ? ' active' : '';
    const name = owner ? owner.name.split(' ')[0] : String(i + 1);
    return `<div class="reveal-dot${active}${done}" data-chain="${i}">${esc(name)}</div>`;
  }).join('');

  nav.querySelectorAll('.reveal-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      currentChainIdx = parseInt(dot.dataset.chain);
      renderRevealNav();
      renderCurrentChain();
    });
  });
}

function renderCurrentChain() {
  const chain = revealChains[currentChainIdx];
  const owner = revealPlayers.find(p => p.position === currentChainIdx);
  const counter = document.getElementById('reveal-chain-counter');
  counter.textContent = owner ? owner.name + '\'s chain' : 'Chain ' + (currentChainIdx + 1);

  const container = document.getElementById('reveal-chain');
  container.innerHTML = '';

  chain.forEach((step, i) => {
    if (i > 0) {
      const arrow = document.createElement('div');
      arrow.className = 'chain-step chain-arrow';
      arrow.textContent = '↓';
      container.appendChild(arrow);
    }

    const stepEl = document.createElement('div');
    stepEl.className = 'chain-step';
    stepEl.style.animationDelay = (i * 0.06) + 's';

    let inner = '';
    if (step.type === 'drawing') {
      inner = step.content
        ? `<div class="step-card step-drawing">
             <div class="step-by">${esc(step.by)} drew</div>
             <img src="${step.content}" alt="drawing by ${esc(step.by)}">
           </div>`
        : `<div class="step-card step-drawing">
             <div class="step-by">${esc(step.by)}</div>
             <div class="missing">Ran out of time</div>
           </div>`;
    } else if (i === 0) {
      inner = `<div class="step-card">
                 <div class="step-by">${esc(step.by)} started with</div>
                 <div class="step-word">${esc(step.content)}</div>
               </div>`;
    } else {
      inner = `<div class="step-card">
                 <div class="step-by">${esc(step.by)} guessed</div>
                 <div class="step-word is-guess">${esc(step.content || '???')}</div>
               </div>`;
    }

    stepEl.innerHTML = inner;
    container.appendChild(stepEl);
  });

  // Match badge at bottom
  if (chain.length > 1) {
    const firstWord = chain[0].content || '';
    const lastStep = chain[chain.length - 1];
    const lastWord = lastStep.type !== 'drawing' ? (lastStep.content || '') : '';
    if (lastWord) {
      const match = firstWord.trim().toLowerCase() === lastWord.trim().toLowerCase();
      const badge = document.createElement('div');
      badge.style.cssText = 'text-align:center;padding:10px 0';
      badge.innerHTML = `<span class="chain-match-badge ${match ? 'match' : 'no-match'}">${match ? 'Made it back intact!' : 'Started: "' + esc(firstWord) + '" · Ended: "' + esc(lastWord) + '"'}</span>`;
      container.appendChild(badge);
    }
  }

  const isLastChain = currentChainIdx >= revealChains.length - 1;
  document.getElementById('btn-next-chain').classList.toggle('hidden', isLastChain);
  document.getElementById('btn-play-again').classList.toggle('hidden', !isLastChain);
}

document.getElementById('btn-next-chain').addEventListener('click', () => {
  currentChainIdx++;
  renderRevealNav();
  renderCurrentChain();
  document.getElementById('reveal-chain').scrollTop = 0;
});

document.getElementById('btn-play-again').addEventListener('click', () => {
  window.location.reload();
});

// ═══════════════════════════════════════════
// Rules modal
// ═══════════════════════════════════════════

document.getElementById('btn-rules').addEventListener('click', () => {
  document.getElementById('rules-modal').classList.remove('hidden');
});

document.getElementById('btn-close-rules').addEventListener('click', () => {
  document.getElementById('rules-modal').classList.add('hidden');
});

document.getElementById('rules-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('rules-modal').classList.add('hidden');
  }
});

// ═══════════════════════════════════════════
// Socket events
// ═══════════════════════════════════════════

socket.on('room_created', ({ code, position }) => {
  myPosition = position;
  isHost = true;
  document.getElementById('lobby-code').textContent = code;
  document.getElementById('btn-start').classList.remove('hidden');
  document.getElementById('lobby-waiting').classList.add('hidden');
  document.getElementById('lobby-hint').textContent = 'Share this code with your friends!';
  showScreen('screen-lobby');
});

socket.on('room_joined', ({ code, position }) => {
  myPosition = position;
  isHost = false;
  document.getElementById('lobby-code').textContent = code;
  document.getElementById('btn-start').classList.add('hidden');
  document.getElementById('lobby-waiting').classList.remove('hidden');
  showScreen('screen-lobby');
});

socket.on('join_error', (msg) => {
  showHomeError(msg);
});

socket.on('game_error', (msg) => {
  const el = document.getElementById('lobby-error');
  el.textContent = msg;
  el.classList.remove('hidden');
});

socket.on('room_update', ({ players }) => {
  renderPlayers(players);
  const activeCount = players.filter(p => p.connected).length;
  document.getElementById('lobby-hint').textContent =
    `${activeCount} player${activeCount !== 1 ? 's' : ''} in the room`;
});

socket.on('game_started', ({ totalRounds }) => {
  showScreen('screen-game');
  showPhase('phase-wait');
  document.getElementById('wait-progress').textContent = '';
});

socket.on('round_info', ({ round, totalRounds, type }) => {
  const typeLabel = type === 'draw' ? 'Draw' : 'Guess';
  document.getElementById('game-round-label').textContent =
    `Round ${round + 1} of ${totalRounds} · ${typeLabel}`;
});

socket.on('your_turn', ({ type, content, round, totalRounds }) => {
  currentPhase = type;
  hasSubmitted = false;

  document.getElementById('game-round-label').textContent =
    `Round ${round + 1} of ${totalRounds} · ${type === 'draw' ? 'Draw' : 'Guess'}`;

  if (type === 'draw') {
    initDrawing();
    document.getElementById('draw-word').textContent = content;
    showPhase('phase-draw');
  } else {
    const img = document.getElementById('guess-img');
    const noDrawing = document.getElementById('guess-no-drawing');
    document.getElementById('guess-input').value = '';

    if (content) {
      img.src = content;
      img.classList.remove('hidden');
      noDrawing.classList.add('hidden');
    } else {
      img.src = '';
      img.classList.add('hidden');
      noDrawing.classList.remove('hidden');
    }

    showPhase('phase-guess');
    setTimeout(() => document.getElementById('guess-input').focus(), 300);
  }
});

socket.on('timer_start', ({ seconds }) => {
  startTimer(seconds);
});

socket.on('submission_progress', ({ submitted, total }) => {
  const el = document.getElementById('wait-progress');
  if (el) el.textContent = `${submitted} / ${total} ready`;
});

socket.on('reveal', ({ chains, players }) => {
  clearInterval(timerInterval);
  showScreen('screen-reveal');
  initReveal(chains, players);
});
