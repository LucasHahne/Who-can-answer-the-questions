import * as api from './api.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LADDER = [100, 200, 500, 1000, 4000, 16000, 32000, 125000, 500000, 1000000];
const MILESTONES = new Set([5, 10]); // highlighted steps of the ladder (display only)
const STORE_KEY = 'wwm-jga-session';
const NAME_KEY = 'wwm-jga-name'; // remembered across games for convenience
const POLL_MS = 3000;
const REVEAL_MS = 1800; // how long right/wrong stays visible (reveal_mode = immediate)
const LOCK_MS = 700; // short "locked in" moment when right/wrong is hidden
const TIMEOUT_REFETCH_MS = 2600; // server finalizes a timeout 2 s after the timer ends

const ERRORS = {
  NETWORK: 'Keine Verbindung. Bitte prüfe dein Internet.',
  SERVER: 'Da ist etwas schiefgelaufen. Bitte versuche es nochmal.',
  NAME_TAKEN: 'Dieser Name ist in diesem Spiel schon vergeben.',
  NAME_INVALID: 'Bitte gib einen Namen mit 1–30 Zeichen ein.',
  GAME_FULL: 'Dieses Spiel ist schon voll.',
  INVALID_TOKEN: 'Deine Sitzung ist abgelaufen. Bitte tritt erneut bei.',
  INVALID_CHOICE: 'Diese Antwort ist nicht wählbar.',
  FIFTY_FIFTY_DISABLED: 'In diesem Spiel gibt es keinen 50:50-Joker.',
  FIFTY_FIFTY_USED: 'Du hast deinen 50:50-Joker schon benutzt.',
  NO_OPEN_QUESTION: 'Gerade ist keine Frage offen.',
};

const errorText = (e) => ERRORS[e?.code] || ERRORS.SERVER;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

/** Create an element. Text children are always inserted as text (no HTML injection). */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const money = (n) => `${new Intl.NumberFormat('de-DE').format(n)} €`;

function duration(ms) {
  const s = Math.max(0, ms || 0) / 1000;
  if (s < 60) return `${s.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60).toString().padStart(2, '0');
  return `${m}:${rest} min`;
}

function ladderFor(total) {
  // Use the top end of the ladder if a game has fewer than 10 questions.
  return LADDER.slice(Math.max(0, LADDER.length - total));
}

let toastTimer;
function toast(message, ms = 3000) {
  clearTimeout(toastTimer);
  $toast.textContent = message;
  $toast.hidden = false;
  toastTimer = setTimeout(() => { $toast.hidden = true; }, ms);
}

function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}

// ---------------------------------------------------------------------------
// Session (token lives only on this device)
// ---------------------------------------------------------------------------

function loadSession() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { return null; }
}

function saveSession(s) {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
  localStorage.setItem(NAME_KEY, s.name);
}

const lastName = () => localStorage.getItem(NAME_KEY) || '';

function clearSession() {
  localStorage.removeItem(STORE_KEY);
}

// ---------------------------------------------------------------------------
// Screen management: every screen registers its cleanups (timers, polling).
// ---------------------------------------------------------------------------

let cleanups = [];
let loadingTimer;

function render(...nodes) {
  clearTimeout(loadingTimer);
  cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  cleanups = [];
  $app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

function onCleanup(fn) { cleanups.push(fn); }

/** Show a spinner only if loading takes noticeably long (avoids flicker). */
function showLoadingSoon() {
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => {
    render(h('div', { class: 'screen screen-center' }, h('div', { class: 'spinner', 'aria-label': 'Lädt' })));
  }, 250);
}

function showFatal(err, retry) {
  render(
    h('div', { class: 'screen screen-center' },
      h('div', { class: 'card' },
        h('p', { class: 'form-error' }, errorText(err)),
        h('button', { class: 'btn btn-primary btn-block', onclick: retry }, 'Erneut versuchen'),
      ),
    ),
  );
}

// Keep the screen on while answering (supported on most modern phones).
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed / not supported */ }
}

let wantAwake = false;
document.addEventListener('visibilitychange', () => {
  if (wantAwake && document.visibilityState === 'visible') keepAwake(true);
});

/** Run fn every POLL_MS while the page is visible; stops on screen change. */
function poll(fn) {
  let timer = null;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (document.visibilityState === 'visible') await fn();
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible' && !stopped) { clearTimeout(timer); tick(); }
  };
  document.addEventListener('visibilitychange', onVisible);
  tick();
  onCleanup(() => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  });
}

// ---------------------------------------------------------------------------
// 1. Join screen
// ---------------------------------------------------------------------------

function showJoin({ code = '', message = '' } = {}) {
  wantAwake = false;
  keepAwake(false);

  const codeInput = h('input', {
    id: 'code', class: 'input input-code', type: 'text', inputmode: 'text',
    autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false',
    maxlength: '20', placeholder: 'Spielcode', required: true, value: code,
    enterkeyhint: 'next',
  });
  const nameInput = h('input', {
    id: 'name', class: 'input', type: 'text', autocomplete: 'nickname',
    autocapitalize: 'words', maxlength: '30', placeholder: 'Wie heißt du?', required: true,
    value: lastName(), enterkeyhint: 'go',
  });
  const error = h('p', { class: 'form-error', role: 'alert' }, message);
  const button = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Los geht’s');

  codeInput.addEventListener('input', () => {
    const pos = codeInput.selectionStart;
    codeInput.value = codeInput.value.toUpperCase().replace(/\s+/g, '');
    codeInput.setSelectionRange(pos, pos);
  });

  async function submit(e) {
    e.preventDefault();
    const c = codeInput.value.trim();
    const n = nameInput.value.trim();
    if (!c) { error.textContent = 'Bitte gib den Spielcode ein.'; codeInput.focus(); return; }
    if (!n || n.length > 30) { error.textContent = ERRORS.NAME_INVALID; nameInput.focus(); return; }

    error.textContent = '';
    button.disabled = true;
    button.textContent = 'Einen Moment …';
    try {
      const rows = await api.joinGame(c, n);
      if (!rows.length) {
        error.textContent = 'Spiel nicht gefunden. Prüfe den Code.';
        codeInput.focus();
        return;
      }
      saveSession({ token: rows[0].token, code: c.toUpperCase(), name: n });
      vibrate(20);
      loadQuestion();
    } catch (err) {
      error.textContent = errorText(err);
      if (err.code === 'NAME_TAKEN' || err.code === 'NAME_INVALID') nameInput.select();
    } finally {
      button.disabled = false;
      button.textContent = 'Los geht’s';
    }
  }

  render(
    h('div', { class: 'screen' },
      h('div', { class: 'logo' },
        h('div', { class: 'logo-disc', 'aria-hidden': 'true' }, h('span', { class: 'logo-mark' }, '?')),
        h('h1', null, 'Wer wird Millionär?'),
        h('p', null, 'JGA Edition'),
      ),
      h('form', { class: 'card', novalidate: true, onsubmit: submit },
        h('div', { class: 'field' }, h('label', { for: 'code' }, 'Spielcode'), codeInput),
        h('div', { class: 'field' }, h('label', { for: 'name' }, 'Dein Name'), nameInput),
        error,
        button,
      ),
      h('p', { class: 'hint push-bottom' }, '10 Fragen · 4 Antworten · nur eine ist richtig'),
    ),
  );

  // On phones, don't pop the keyboard up before the player has seen the screen.
  if (!matchMedia('(pointer: coarse)').matches) {
    (code ? nameInput : codeInput).focus({ preventScroll: true });
  }
}

// ---------------------------------------------------------------------------
// 2. Question screen
// ---------------------------------------------------------------------------

async function loadQuestion() {
  const session = loadSession();
  if (!session) return showJoin();

  showLoadingSoon();
  try {
    const rows = await api.getCurrentQuestion(session.token);
    if (!rows.length) {
      clearSession();
      return showJoin({ code: session.code, message: ERRORS.INVALID_TOKEN });
    }
    const q = rows[0];
    if (q.state === 'finished') return showFinal();
    showQuestion(q, session);
  } catch (err) {
    showFatal(err, loadQuestion);
  }
}

function showQuestion(q, session) {
  wantAwake = true;
  keepAwake(true);

  const total = q.total_questions;
  const ladder = ladderFor(total);
  let locked = false;
  let removed = q.removed || '';

  // --- Header & progress ---
  const header = h('div', { class: 'topbar' },
    h('div', { class: 'topbar-title' }, q.game_title || 'Wer wird Millionär?'),
    q.prize_ladder_enabled
      ? h('div', { class: 'chip' }, `Frage ${q.position} · ${money(ladder[q.position - 1])}`)
      : h('div', { class: 'chip' }, `Frage ${q.position} / ${total}`),
  );

  const progress = h('div', { class: 'progress', 'aria-hidden': 'true' },
    Array.from({ length: total }, (_, i) =>
      h('span', { class: i + 1 < q.position ? 'done' : i + 1 === q.position ? 'current' : '' })),
  );
  const progressLabel = h('p', { class: 'progress-label' }, `Frage ${q.position} von ${total}`);

  // --- Question & answers ---
  const questionBox = h('div', { class: 'question hexbox' },
    h('div', { class: 'hexbox-inner' }, h('h2', { class: 'question-text' }, q.text)));

  const letters = ['A', 'B', 'C', 'D'];
  const texts = { A: q.answer_a, B: q.answer_b, C: q.answer_c, D: q.answer_d };
  const buttons = {};
  for (const L of letters) {
    buttons[L] = h('button', {
      type: 'button',
      class: `answer hexbox${removed.includes(L) ? ' removed' : ''}`,
      disabled: removed.includes(L),
      'aria-label': `Antwort ${L}: ${texts[L]}`,
      onclick: () => choose(L),
    }, h('span', { class: 'hexbox-inner' }, h('span', { class: 'letter' }, `${L}:`), h('span', null, texts[L])));
  }
  // Each answer sits on a "row" that draws the show's horizontal light line behind it.
  const answers = h('div', { class: 'answers' },
    letters.map((L) => h('div', { class: 'stage-row' }, buttons[L])));

  const status = h('div', { 'aria-live': 'assertive' });

  // --- Timer (elements now, ticking starts after render) ---
  let timerEl = null;
  let timerInterval = null;
  let timedOut = false;
  let jokerBtn = null;
  let startTimer = () => {};
  if (q.timer_seconds) {
    const bar = h('div', { class: 'timer-bar' });
    const num = h('div', { class: 'timer-num' });
    timerEl = h('div', { class: 'timer', role: 'timer', 'aria-label': 'Verbleibende Zeit' },
      h('div', { class: 'timer-track' }, bar), num);
    const deadline = Date.now() + (q.seconds_left ?? q.timer_seconds) * 1000;
    const update = (allowTimeout = true) => {
      const left = Math.max(0, deadline - Date.now());
      const secs = Math.ceil(left / 1000);
      bar.style.transform = `scaleX(${left / (q.timer_seconds * 1000)})`;
      num.textContent = secs;
      timerEl.classList.toggle('low', secs <= 5);
      if (left <= 0 && allowTimeout) onTimeout();
    };
    update(false); // paint the initial state; timeout handling only starts after render
    startTimer = () => {
      update();
      if (!timedOut) {
        timerInterval = setInterval(update, 100);
        onCleanup(() => clearInterval(timerInterval));
      }
    };
  }
  const stopTimer = () => clearInterval(timerInterval);

  function lockAll() {
    locked = true;
    answers.classList.add('locked');
    Object.values(buttons).forEach((b) => { b.disabled = true; });
    if (jokerBtn) jokerBtn.disabled = true;
  }

  function unlock() {
    locked = false;
    answers.classList.remove('locked');
    for (const L of letters) {
      buttons[L].disabled = removed.includes(L);
      buttons[L].classList.remove('selected');
    }
    if (jokerBtn) jokerBtn.disabled = q.used_fifty_fifty || !!removed;
  }

  function onTimeout() {
    if (timedOut) return;
    timedOut = true;
    stopTimer();
    lockAll();
    vibrate([60, 40, 60]);
    status.replaceChildren(h('div', { class: 'banner banner-timeout' }, 'Zeit abgelaufen!'));
    const t = setTimeout(loadQuestion, TIMEOUT_REFETCH_MS);
    onCleanup(() => clearTimeout(t));
  }

  // --- Submit an answer ---
  async function choose(letter) {
    if (locked || timedOut) return;
    stopTimer(); // from here on the server decides whether it was in time
    lockAll();
    buttons[letter].classList.add('selected');
    vibrate(15);
    status.replaceChildren();

    try {
      const [r] = await api.submitAnswer(session.token, q.question_id, letter);

      if (r.timed_out) {
        timedOut = true;
        buttons[letter].classList.remove('selected');
        status.replaceChildren(h('div', { class: 'banner banner-timeout' }, 'Zu spät – die Zeit war abgelaufen.'));
        await sleep(REVEAL_MS);
      } else if (r.is_correct !== null && r.is_correct !== undefined) {
        // reveal_mode = immediate
        await sleep(500);
        buttons[letter].classList.remove('selected');
        buttons[r.correct]?.classList.add('correct', 'blink');
        if (!r.is_correct) buttons[letter].classList.add('wrong');
        vibrate(r.is_correct ? 30 : [80, 50, 80]);
        status.replaceChildren(h('p', { class: `hint hint-result ${r.is_correct ? 'is-ok' : 'is-ko'}` },
          r.is_correct ? 'Richtig!' : `Leider falsch – richtig ist ${r.correct}.`));
        await sleep(REVEAL_MS);
      } else {
        await sleep(LOCK_MS);
      }

      if (r.finished) showFinal(); else loadQuestion();
    } catch (err) {
      if (err.code === 'ALREADY_ANSWERED' || err.code === 'NOT_CURRENT_QUESTION') return loadQuestion();
      if (err.code === 'INVALID_TOKEN') {
        clearSession();
        return showJoin({ code: session.code, message: ERRORS.INVALID_TOKEN });
      }
      if (err.code === 'INVALID_CHOICE') {
        unlock();
        toast(ERRORS.INVALID_CHOICE);
        return;
      }
      // Network / server error: the answer may or may not have arrived. Offer a retry
      // with the same letter; the server rejects duplicates, so this is safe.
      status.replaceChildren(
        h('div', { class: 'banner banner-error' },
          h('span', null, errorText(err)),
          h('button', {
            class: 'btn btn-primary btn-small',
            onclick: () => { locked = false; choose(letter); },
          }, `Antwort ${letter} nochmal senden`),
        ),
      );
    }
  }

  // --- 50:50 joker ---
  if (q.fifty_fifty_enabled) {
    jokerBtn = h('button', {
      type: 'button', class: 'joker',
      disabled: q.used_fifty_fifty,
      'aria-label': q.used_fifty_fifty ? '50:50-Joker bereits benutzt' : '50:50-Joker einsetzen',
      onclick: async () => {
        if (locked || timedOut) return;
        jokerBtn.disabled = true;
        try {
          const letters2 = await api.useFiftyFifty(session.token);
          removed = letters2 || '';
          q.used_fifty_fifty = true;
          for (const L of removed) {
            buttons[L].classList.add('removed');
            buttons[L].disabled = true;
          }
          jokerBtn.setAttribute('aria-label', '50:50-Joker bereits benutzt');
          vibrate(25);
        } catch (err) {
          toast(errorText(err));
          if (err.code !== 'FIFTY_FIFTY_USED' && err.code !== 'FIFTY_FIFTY_DISABLED') jokerBtn.disabled = false;
          if (err.code === 'NO_OPEN_QUESTION') loadQuestion();
        }
      },
    }, '50:50');
  }

  // --- Prize ladder (display only) ---
  let ladderEl = null;
  if (q.prize_ladder_enabled) {
    ladderEl = h('details', { class: 'ladder' },
      h('summary', null, 'Gewinnleiter'),
      h('ol', null, ladder.map((amount, i) => {
        const pos = i + 1;
        const cls = [
          MILESTONES.has(pos + (LADDER.length - ladder.length)) ? 'milestone' : '',
          pos < q.position ? 'passed' : '',
          pos === q.position ? 'current' : '',
        ].join(' ').trim();
        return h('li', { class: cls }, h('span', null, pos), h('span', null, money(amount)));
      })),
    );
  }

  render(
    h('div', { class: 'screen' },
      header,
      progress,
      progressLabel,
      timerEl,
      h('div', { class: 'stage-row stage-row-question' }, questionBox),
      h('div', { class: 'push-bottom' }),
      status,
      jokerBtn && h('div', { class: 'jokers' }, jokerBtn),
      answers,
      ladderEl,
    ),
  );

  // Starts ticking; if there is no time left (e.g. after a refresh) this triggers the
  // timeout state, and the server finalizes the question shortly after.
  startTimer();
}

// ---------------------------------------------------------------------------
// 3. Final screen (own result + live leaderboard)
// ---------------------------------------------------------------------------

async function showFinal() {
  wantAwake = false;
  keepAwake(false);

  const session = loadSession();
  if (!session) return showJoin();

  showLoadingSoon();
  let mine = [];
  try {
    mine = await api.getMyAnswers(session.token);
  } catch (err) {
    if (err.code === 'NOT_FINISHED') return loadQuestion();
    return showFatal(err, showFinal);
  }
  if (!mine.length) {
    clearSession();
    return showJoin({ code: session.code, message: ERRORS.INVALID_TOKEN });
  }

  const total = mine.length;
  const correct = mine.filter((a) => a.is_correct).length;
  const totalMs = mine.reduce((sum, a) => sum + (a.time_ms || 0), 0);

  const hero = h('div', { class: 'result-hero' },
    h('h1', null, correct === total ? 'Perfekt!' : correct >= total / 2 ? 'Geschafft!' : 'Fertig!'),
    h('p', { class: 'score-big' }, `${correct} / ${total}`),
    h('p', { class: 'score-sub' }, `richtig beantwortet · ${duration(totalMs)}`),
  );

  // Tabs
  const boardPanel = h('div', { id: 'panel-board', role: 'tabpanel' });
  const reviewPanel = h('div', { id: 'panel-review', role: 'tabpanel', hidden: true }, reviewList(mine));
  const tabBoard = h('button', { class: 'tab', role: 'tab', 'aria-selected': 'true', 'aria-controls': 'panel-board' }, 'Rangliste');
  const tabReview = h('button', { class: 'tab', role: 'tab', 'aria-selected': 'false', 'aria-controls': 'panel-review' }, 'Meine Antworten');
  const select = (board) => {
    tabBoard.setAttribute('aria-selected', String(board));
    tabReview.setAttribute('aria-selected', String(!board));
    boardPanel.hidden = !board;
    reviewPanel.hidden = board;
  };
  tabBoard.addEventListener('click', () => select(true));
  tabReview.addEventListener('click', () => select(false));

  const boardUrl = `${location.origin}${location.pathname}?board=${encodeURIComponent(session.code)}`;

  render(
    h('div', { class: 'screen' },
      hero,
      h('div', { class: 'tabs', role: 'tablist' }, tabBoard, tabReview),
      boardPanel,
      reviewPanel,
      h('div', { class: 'footer-links push-bottom' },
        h('a', { class: 'btn btn-secondary btn-block', href: boardUrl, target: '_blank', rel: 'noopener' },
          'Rangliste für großen Bildschirm'),
        h('button', {
          class: 'btn btn-secondary btn-block',
          onclick: () => { clearSession(); history.replaceState(null, '', location.pathname); showJoin(); },
        }, 'Anderem Spiel beitreten'),
      ),
    ),
  );

  mountLeaderboard(boardPanel, session.code, session.name);
}

function reviewList(mine) {
  const textOf = (a, L) => ({ A: a.answer_a, B: a.answer_b, C: a.answer_c, D: a.answer_d }[L]);
  return h('ol', { class: 'review' }, mine.map((a) =>
    h('li', { class: `review-item ${a.is_correct ? 'ok' : 'ko'}` },
      h('p', { class: 'review-q' }, h('span', null, `${a.position}. `), a.text),
      a.chosen
        ? h('p', { class: 'review-a' }, 'Deine Antwort: ', h('b', { class: a.is_correct ? 'is-ok' : 'is-ko' }, `${a.chosen}: ${textOf(a, a.chosen)}`))
        : h('p', { class: 'review-a' }, 'Keine Antwort (Zeit abgelaufen)'),
      !a.is_correct && h('p', { class: 'review-a' }, 'Richtig: ', h('b', null, `${a.correct}: ${textOf(a, a.correct)}`)),
      a.time_ms != null && h('p', { class: 'review-a' }, `Zeit: ${duration(a.time_ms)}`),
    )));
}

// ---------------------------------------------------------------------------
// Leaderboard (used on the final screen and on the big-screen board)
// ---------------------------------------------------------------------------

function mountLeaderboard(container, code, myName) {
  const head = h('div', { class: 'section-head' },
    h('span', null, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), 'Live'),
    h('span', { class: 'updated' }, ''));
  const list = h('ol', { class: 'board', 'aria-label': 'Rangliste' });
  container.replaceChildren(head, list);

  const me = (myName || '').trim().toLowerCase();
  let lastJson = '';
  let errorShown = false;

  poll(async () => {
    try {
      const rows = await api.getLeaderboard(code);
      errorShown = false;
      head.lastChild.textContent = `aktualisiert ${new Date().toLocaleTimeString('de-DE')}`;
      const json = JSON.stringify(rows);
      if (json === lastJson) return;
      lastJson = json;
      list.replaceChildren(...(rows.length ? rows.map((r) => boardRow(r, me)) : [
        h('li', { class: 'board-empty' }, 'Noch keine Spieler – oder der Code ist unbekannt.'),
      ]));
    } catch (err) {
      if (!errorShown) toast(errorText(err));
      errorShown = true;
    }
  });
}

function boardRow(r, me) {
  const isMe = me && r.name.trim().toLowerCase() === me;
  const rankClass = r.finished && r.rank <= 3 ? ` r${r.rank}` : '';
  return h('li', { class: `board-row${isMe ? ' me' : ''}${r.finished ? '' : ' playing'}${rankClass}` },
    h('div', { class: 'board-rank', 'aria-label': r.finished ? `Platz ${r.rank}` : 'spielt noch' },
      r.finished ? r.rank : '…'),
    h('div', { class: 'board-name' },
      r.name, isMe ? ' (du)' : '',
      h('small', null, r.finished ? duration(r.total_time_ms) : `spielt noch · Frage ${Math.min(r.answered_count + 1, r.total_questions)} / ${r.total_questions}`)),
    h('div', { class: 'board-score' },
      h('strong', null, `${r.correct_count} / ${r.total_questions}`),
      h('small', null, 'richtig')),
  );
}

// ---------------------------------------------------------------------------
// 4. Big-screen leaderboard (?board=CODE)
// ---------------------------------------------------------------------------

function showBoard(code) {
  const container = h('div');
  const joinUrl = `${location.origin}${location.pathname}?code=${encodeURIComponent(code)}`;
  render(
    h('div', { class: 'screen screen-board' },
      h('div', { class: 'logo' },
        h('h1', null, 'Rangliste'),
        h('p', null, `Spiel ${code}`)),
      h('p', { class: 'join-url' }, 'Mitspielen: ', h('b', null, joinUrl)),
      container,
    ),
  );
  mountLeaderboard(container, code, '');
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function start() {
  const params = new URLSearchParams(location.search);
  const board = params.get('board');
  const code = (params.get('code') || '').trim().toUpperCase();

  if (board) return showBoard(board.trim().toUpperCase());

  const session = loadSession();
  if (session && code && session.code !== code) {
    // Link for a different game: start fresh for that one.
    clearSession();
    return showJoin({ code });
  }
  if (session?.token) return loadQuestion();
  showJoin({ code });
}

start();
