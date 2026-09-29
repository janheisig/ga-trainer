// UI layer of the GA trainer. Domain rules live in core.js; this file owns
// routing, persistence, rendering and focus management.
import { html, render, nothing } from 'lit-html'; // pinned + SRI-checked via the import map in index.html
import {
  EXAM, LEARN_MODES, STORAGE_KEY, LEGACY_STORAGE_KEY,
  shuffle, sectionOf, formatDuration, answerOrder, splitMatches, matchesSearch,
  isCorrect, recordAnswer, isMastered, isWeak, learnPool, sectionProgress,
  createExam, examRemainingSec, examElapsedSec, scoreExam, evaluateStation,
  defaultState, statKey, appendExamResult, migrateState,
  createMemoryDeck, isBetterMemoryScore, encodeBackup, decodeBackup, mergeProgress,
} from './core.js';
import { TOOLS, TOOL_SETS, TOOL_CREDIT } from './tools.js';
import { SITE } from './config.js';
import { onInstallChange, isStandalone, isIos, canPromptInstall, promptInstall } from './pwa.js';

const LETTERS = 'ABCDE';
const VIEWS = { home: 'Übersicht', exam: 'Prüfungsbogen', learn: 'Üben', prac: 'Praxis', cat: 'Katalog' };
const LEARN_COUNTS = [10, 20, 40, 0];
const XO_QUIZ_SIZE = 20;
const CATALOG_RENDER_LIMIT = 300;
const SAVE_DELAY_MS = 300;
const MEMORY_MAX_PAIRS = 10;
const MEMORY_FLIP_BACK_MS = 1000;
const TOOL_ROUTE = 'werkzeuge';

const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $status = document.getElementById('status');
const $dialog = document.getElementById('confirm');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// ---------- Persistence ----------

const store = (() => {
  let available = true;
  let pending = null;
  let timer = null;

  function load() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    } catch {
      available = false;
      return defaultState();
    }
    try {
      return migrateState(raw ? JSON.parse(raw) : null);
    } catch {
      // Corrupt JSON: keep a copy for manual recovery instead of silently overwriting it.
      try { localStorage.setItem(`${STORAGE_KEY}-corrupt`, raw); } catch { /* best effort */ }
      return defaultState();
    }
  }

  function flush() {
    clearTimeout(timer);
    if (!pending) return;
    const wasAvailable = available;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
      available = true;
    } catch {
      available = false;
    }
    pending = null;
    if (wasAvailable !== available) rerender();
  }

  function save(s) {
    pending = s;
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  }

  // The debounce must never cost the last answer when the tab goes away.
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  return { load, save, flush, get available() { return available; } };
})();

// ---------- Data ----------

async function loadData() {
  const res = await fetch('data.json');
  if (!res.ok) throw new Error(`data.json: HTTP ${res.status}`);
  const data = await res.json();
  const catalogs = {};
  for (const [id, c] of Object.entries(data.catalogs)) {
    catalogs[id] = {
      id, label: c.label, questions: c.questions,
      byId: new Map(c.questions.map(q => [q.id, q])),
      hasChanges: c.questions.some(q => q.status), // only the newer catalog marks new/changed questions
    };
  }
  return {
    sections: data.sections,
    sectionById: new Map(data.sections.map(s => [s.id, s])),
    catalogs,
    stations: data.stations,
    stationById: new Map(data.stations.map(s => [s.id, s])),
  };
}

let D;                       // immutable content, set once in boot()
let state = store.load();    // persisted user state
const ui = {                 // ephemeral view state
  view: 'home',
  learn: { sections: null, mode: 'all', count: 20, session: null },
  examResult: null,
  examWarned: new Set(),
  station: null,
  stationMode: 'recall',
  parcours: null,
  parcoursResult: null,
  xo: null,
  tools: null,               // { set, mode: 'menu'|'memory'|'name'|'show', game, quiz }
  backup: { code: '', copied: false, input: '', busy: false, message: null, error: null },
  catalogFilter: { term: '', section: 0, only: 'all' },
};

const catalog = () => D.catalogs[state.catalog];
const statOf = (q, catalogId = state.catalog) => state.stats[statKey(catalogId, q.id)];
const allSectionIds = () => new Set(D.sections.map(s => s.id));

function recordResult(catalogId, question, correct) {
  const key = statKey(catalogId, question.id);
  state.stats[key] = recordAnswer(state.stats[key], correct);
}

// ---------- Rendering, focus, announcements ----------

function rerender() {
  render(Tabs(), $tabs);
  render(App(), $app);
  syncExamTimer();
}

/** Persist and re-render. Use after every change to `state`. */
function commit() {
  store.save(state);
  rerender();
}

/** Focus an element in the view; the browser scrolls it clear of the sticky header (scroll-padding-top). */
function focus(selector) {
  $app.querySelector(selector)?.focus();
}

function announce(message) {
  $status.textContent = '';
  requestAnimationFrame(() => { $status.textContent = message; });
}

function scrollToTop() {
  scrollTo({ top: 0, behavior: 'instant' });
}

function confirmDialog({ title, body, confirmLabel, danger = false }) {
  $dialog.querySelector('#confirm-title').textContent = title;
  $dialog.querySelector('#confirm-body').textContent = body;
  const ok = $dialog.querySelector('#confirm-ok');
  ok.textContent = confirmLabel;
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;
  $dialog.returnValue = '';
  $dialog.showModal();
  return new Promise(resolve => {
    $dialog.addEventListener('close', () => resolve($dialog.returnValue === 'ok'), { once: true });
  });
}

// ---------- Routing ----------
// Hash routes. Every history entry carries its index in history.state, so a
// navigation the user cancels ("keep the running exam") can step back to the
// entry it came from instead of rewriting history.

let historyIndex = 0;
let ignoreNextPop = false;

function parseHash(hash) {
  const [view, ...rest] = hash.replace(/^#/, '').split('/');
  return view in VIEWS ? { view, arg: rest.join('/') || null } : { view: 'home', arg: null };
}

function navigate(hash) {
  if (location.hash === hash) {
    handleRoute(historyIndex);
    return;
  }
  history.pushState({ idx: historyIndex + 1 }, '', hash);
  handleRoute(historyIndex + 1);
}

function onPopState() {
  if (ignoreNextPop) {
    ignoreNextPop = false;
    return;
  }
  // No state means the hash was typed into the address bar: a new entry.
  handleRoute(history.state?.idx ?? historyIndex + 1);
}

function returnTo(index) {
  const delta = index - (history.state?.idx ?? historyIndex + 1);
  if (!delta) return;
  ignoreNextPop = true;
  history.go(delta);
}

async function handleRoute(targetIndex, { initial = false } = {}) {
  if ($dialog.open) {
    returnTo(historyIndex); // Back/Forward while a dialog asks something: stay put
    return;
  }
  let target = parseHash(location.hash);
  if (state.activeExam && target.view !== 'exam') {
    if (initial) {
      target = { view: 'exam', arg: null };
    } else {
      const leave = await confirmDialog({
        title: 'Prüfungsbogen verwerfen?',
        body: 'Der Bogen läuft noch. Wenn du jetzt wechselst, wird er verworfen und nicht gewertet.',
        confirmLabel: 'Bogen verwerfen',
        danger: true,
      });
      if (!leave) {
        returnTo(historyIndex);
        return;
      }
      state.activeExam = null;
      store.save(state);
    }
  }
  historyIndex = targetIndex;
  const hash = `#${target.view}${target.arg ? `/${target.arg}` : ''}`;
  if (history.state?.idx !== targetIndex || location.hash !== hash) history.replaceState({ idx: targetIndex }, '', hash);
  applyRoute(target, { initial });
}

function applyRoute({ view, arg }, { initial = false } = {}) {
  ui.view = view;
  if (view === 'learn' && arg) {
    ui.learn.session = null;
    if (arg === 'weak') {
      ui.learn.mode = 'weak';
      ui.learn.sections = allSectionIds();
    } else if (/^la\d+$/.test(arg)) {
      ui.learn.mode = 'all';
      ui.learn.sections = new Set([Number(arg.slice(2))]);
    }
  }
  if (view === 'prac') {
    ui.parcours = null;
    ui.parcoursResult = null;
    ui.xo = null;
    ui.station = arg && D.stationById.has(arg) ? newStationSession(D.stationById.get(arg)) : null;
    ui.tools = arg?.startsWith(TOOL_ROUTE) ? newToolsSession(arg.slice(TOOL_ROUTE.length + 1)) : null;
  }
  document.title = `${VIEWS[view]} · GA-Prüfungstrainer`;
  rerender();
  scrollToTop();
  if (!initial) focus('h1');
}

function onLinkClick(e) {
  const link = e.target.closest('a[href^="#"]');
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const href = link.getAttribute('href');
  if (href === '#app') {
    $app.focus(); // skip link: move focus, don't route
    return;
  }
  navigate(href);
}

// ---------- Keyboard shortcuts ----------

function onKeyDown(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || $dialog.open) return;
  if (e.target.closest('input[type="search"], textarea')) return;
  const key = e.key.toLowerCase();
  const position = /^[1-9]$/.test(key) ? Number(key) - 1 : LETTERS.toLowerCase().indexOf(key);

  const exam = state.activeExam;
  if (ui.view === 'exam' && exam) {
    const order = exam.orders[exam.current];
    if (position >= 0 && position < order.length) { e.preventDefault(); toggleExamAnswer(order[position]); }
    else if (key === 'arrowright') { e.preventDefault(); goToExamQuestion(exam.current + 1); }
    else if (key === 'arrowleft') { e.preventDefault(); goToExamQuestion(exam.current - 1); }
    else if (key === 'm') { e.preventDefault(); toggleExamFlag(); }
    return;
  }

  const session = ui.learn.session;
  if (ui.view === 'learn' && session && session.index < session.questions.length) {
    if (!session.revealed && position >= 0 && position < session.order.length) {
      e.preventDefault();
      toggleLearnAnswer(session.order[position]);
    } else if (key === 'enter' && !e.target.closest('button, a')) {
      e.preventDefault();
      session.revealed ? nextLearnQuestion() : checkLearnAnswer();
    }
  }
}

// ---------- Shared components ----------

const ariaBool = on => (on ? 'true' : 'false');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function Choice({ type = 'radio', name, checked, onChange, label, className = 'chip', title }) {
  return html`<label class=${className} title=${title ?? nothing}>
    <input type=${type} name=${name ?? nothing} .checked=${checked} @change=${onChange}>${label}
  </label>`;
}

function StatusTag(question) {
  if (!question.status) return nothing;
  return html`<span class="tag new">${question.status === 'new' ? 'neu seit 2019' : 'geändert'}</span>`;
}

/** One question with checkboxes. `revealed` shows the solution and locks the inputs. */
function QuestionBlock({ key, question, order, selected, revealed, onToggle, aside }) {
  const correct = new Set(question.correct);
  const chosen = new Set(selected);
  const textId = `qtext-${key}`;
  return html`
    <div class="qhead">
      <div class="row gap-xs">
        <span class="qid">Frage ${question.id}</span>
        <span class="tag">LA ${sectionOf(question.id)}</span>
        ${StatusTag(question)}
      </div>
      ${aside ?? nothing}
    </div>
    <p class="qtext" id=${textId} tabindex="-1">${question.text}</p>
    <div class="opts ${revealed ? 'revealed' : ''}" role="group" aria-labelledby=${textId}>
      ${order.map((answerIndex, position) => {
        const on = chosen.has(answerIndex);
        const right = correct.has(answerIndex);
        const [cls, result] = !revealed ? ['', '']
          : on && right ? ['right', 'richtig']
          : on ? ['wrong', 'falsch angekreuzt']
          : right ? ['missed', 'fehlte'] : ['', ''];
        return html`<label class="opt ${cls}">
          <input type="checkbox" .checked=${on} ?disabled=${revealed} @change=${() => onToggle(answerIndex)}>
          <span class="box" aria-hidden="true">${LETTERS[position]}</span>
          <span>${question.answers[answerIndex]}</span>
          <span class="res">${result}</span>
        </label>`;
      })}
    </div>`;
}

function CatalogItem(question, { term = '', stat } = {}) {
  const mark = text => splitMatches(text, term).map(p => (p.match ? html`<mark>${p.text}</mark>` : p.text));
  const correct = new Set(question.correct);
  return html`<li class="cat-item">
    <div class="row gap-xs">
      <span class="qid">${mark(question.id)}</span>
      ${StatusTag(question)}
      ${stat ? html`<span class="tag ${stat.lastCorrect ? 'ok' : 'bad'} num" title="richtig / gesamt">${stat.right}/${stat.seen}</span>` : nothing}
    </div>
    <p class="qt">${mark(question.text)}</p>
    <ul>${question.answers.map((a, i) => html`<li class=${correct.has(i) ? 'c' : ''}>
      <span class="mk" aria-hidden="true">${correct.has(i) ? 'X' : LETTERS[i]}</span>
      <span>${mark(a)}${correct.has(i) ? html`<span class="visually-hidden"> (richtig)</span>` : nothing}</span>
    </li>`)}</ul>
  </li>`;
}

function Score(value, of) {
  return html`<div class="big num">${value}<span class="of">/${of}</span></div>`;
}

// ---------- App shell ----------

function Tabs() {
  return Object.entries(VIEWS).map(([view, label]) =>
    html`<a class="tab" href="#${view}" aria-current=${ui.view === view ? 'page' : nothing}>${label}</a>`);
}

function App() {
  const views = { home: HomeView, exam: ExamView, learn: LearnView, prac: PracticeView, cat: CatalogView };
  return html`
    ${store.available ? nothing : html`<p class="alert small">Dein Fortschritt kann in diesem Browser gerade nicht gespeichert werden (privater Modus oder Speicher voll). Alles funktioniert, geht aber beim Schließen verloren.</p>`}
    ${ui.view === 'home' || ui.view === 'prac' ? SupportBanner() : nothing}
    ${views[ui.view]()}`;
}


// ---------- Support banner & install hint ----------

const SUPPORT_DISMISS_KEY = 'ga-trainer-support-hidden';
let supportHidden = (() => { try { return localStorage.getItem(SUPPORT_DISMISS_KEY) === '1'; } catch { return false; } })();

function SupportBanner() {
  if (!SITE.supportUrl || supportHidden) return nothing;
  const hide = () => {
    supportHidden = true;
    try { localStorage.setItem(SUPPORT_DISMISS_KEY, '1'); } catch { /* convenience only */ }
    rerender();
  };
  return html`<aside class="support" aria-label="Unterstützen">
    <p class="m-0 small">${SITE.supportText}</p>
    <div class="row gap-xs">
      <a class="btn sm primary" href=${SITE.supportUrl} target="_blank" rel="noopener">${SITE.supportLabel}</a>
      <button class="btn sm ghost" type="button" @click=${hide}>Ausblenden</button>
    </div>
  </aside>`;
}

function InstallPanel() {
  if (isStandalone()) return nothing;
  let how;
  if (canPromptInstall()) {
    how = html`<div><button class="btn primary" type="button" @click=${async () => { await promptInstall(); rerender(); }}>Als App installieren</button></div>`;
  } else if (isIos()) {
    how = html`<p class="small m-0">In Safari auf <strong>Teilen</strong> tippen und <strong>Zum Home-Bildschirm</strong> wählen.</p>`;
  } else {
    how = html`<p class="small m-0">Im Browsermenü <strong>App installieren</strong> bzw. <strong>Zum Startbildschirm hinzufügen</strong> wählen.</p>`;
  }
  return html`<section class="panel stack gap-s" aria-labelledby="h-install">
    <h2 class="h-m" id="h-install">Als App aufs Handy</h2>
    <p class="small muted m-0">Mit einem Symbol auf dem Home-Bildschirm startet der Trainer wie eine App, ohne Browserleiste, und funktioniert auch ohne Netz, z. B. in der Unterkunft.</p>
    ${how}
  </section>`;
}

// ---------- Home ----------

function HomeView() {
  const questions = catalog().questions;
  const progress = sectionProgress(questions, q => statOf(q));
  const total = questions.length;
  const mastered = questions.filter(q => isMastered(statOf(q))).length;
  const seen = questions.filter(q => statOf(q)).length;
  const weak = questions.filter(q => isWeak(statOf(q))).length;
  const pct = Math.round((100 * mastered) / total);
  const circumference = 2 * Math.PI * 62;
  const exams = state.exams.filter(e => e.catalog === state.catalog).slice(-6).reverse();
  const stationsPassed = Object.values(state.stations).filter(s => s.passed).length;
  const newest = Object.values(D.catalogs).find(c => c.hasChanges);
  const newQuestions = newest?.questions.filter(q => q.status === 'new').length ?? 0;

  return html`<div class="stack gap-xl">
    <section class="hero">
      <div class="stack gap-s">
        <span class="eyebrow">Helferanwärter · Prüfungsvorbereitung</span>
        <h1 tabindex="-1">Bereit für die Grundausbildungsprüfung</h1>
        <p class="lead">Theorie mit ${total} Fragen aus dem Prüfungskatalog, Prüfungsbogen unter echten Bedingungen und ${D.stations.length} Praxisstationen mit Bewertungskriterien.</p>
      </div>
      <div class="gauge" role="img" aria-label="${pct} Prozent der Fragen sicher beantwortet">
        <svg viewBox="0 0 150 150" aria-hidden="true">
          <circle class="track" cx="75" cy="75" r="62" fill="none" stroke-width="14"/>
          <circle class="fill" cx="75" cy="75" r="62" fill="none" stroke-width="14" stroke-linecap="round"
            stroke-dasharray=${circumference} stroke-dashoffset=${circumference * (1 - mastered / total)}/>
        </svg>
        <div class="v" aria-hidden="true"><b class="num">${pct}%</b><span>sicher</span></div>
      </div>
    </section>

    <section class="grid2" aria-label="Schnellstart">
      <a class="action" href="#exam">
        <span class="eyebrow">Theorie · ${EXAM.questionCount} Fragen · ${EXAM.timeLimitSec / 60} Min</span>
        <h2 class="h-card">Prüfungsbogen starten</h2>
        <span class="meta">Mindestens eine Frage je Lernabschnitt. Bestanden ab ${EXAM.passMark} richtigen Antworten.</span>
      </a>
      <a class="action" href="#learn/weak">
        <span class="eyebrow">Fehlertraining</span>
        <h2 class="h-card">${plural(weak, 'Frage', 'Fragen')} wiederholen</h2>
        <span class="meta">${weak ? 'Falsch beantwortete und noch unsichere Fragen zuerst.' : 'Noch keine Fehler gesammelt. Fang im Übungsmodus an.'}</span>
      </a>
      <a class="action" href="#prac">
        <span class="eyebrow">Praxis · Stationsbetrieb</span>
        <h2 class="h-card">${stationsPassed} von ${D.stations.length} Stationen bestanden</h2>
        <span class="meta">Kriterien selbst aufzählen, Pflichtpunkte (X) prüfen, Werkzeuge erkennen.</span>
      </a>
    </section>

    <section class="panel" aria-labelledby="h-progress">
      <div class="row between">
        <h2 class="h-l" id="h-progress">Stand je Lernabschnitt</h2>
        <div class="legend" aria-hidden="true"><span><i class="m"></i>sicher</span><span><i class="s"></i>gesehen</span></div>
        <span class="small muted num">${seen} von ${total} gesehen</span>
      </div>
      <ul class="la-list">${D.sections.map(section => {
        const r = progress.get(section.id) ?? { total: 0, seen: 0, mastered: 0, weak: 0 };
        const masteredPct = r.total ? (100 * r.mastered) / r.total : 0;
        const seenPct = r.total ? (100 * (r.seen - r.mastered)) / r.total : 0;
        return html`<li><a class="la-row" href="#learn/la${section.id}">
          <span class="la-num num" aria-hidden="true">${String(section.id).padStart(2, '0')}</span>
          <span class="stack gap-xs">
            <span class="la-name"><span class="visually-hidden">Lernabschnitt ${section.id}: </span>${section.title}</span>
            <span class="bar" aria-hidden="true"><i class="m" style="width:${masteredPct}%"></i><i class="s" style="width:${seenPct}%"></i></span>
          </span>
          <span class="la-pct num">${r.mastered}/${r.total} sicher${r.weak ? html`<br><span class="text-bad">${r.weak} offen</span>` : nothing}</span>
        </a></li>`;
      })}</ul>
    </section>

    <section class="grid2">
      <div class="panel stack gap-s">
        <h2 class="h-m">Letzte Prüfungsbögen</h2>
        ${exams.length ? html`<div class="scroll-x"><table class="hist num">
          <thead><tr><th scope="col">Datum</th><th scope="col">Richtig</th><th scope="col">Zeit</th><th scope="col">Ergebnis</th></tr></thead>
          <tbody>${exams.map(e => html`<tr>
            <td>${dateFmt.format(e.at)}</td>
            <td>${e.score}/${EXAM.questionCount}</td>
            <td>${formatDuration(e.durationSec)}</td>
            <td><span class="tag ${e.passed ? 'ok' : 'bad'}">${e.passed ? 'bestanden' : 'nicht bestanden'}</span></td>
          </tr>`)}</tbody>
        </table></div>` : html`<p class="muted small m-0">Noch kein Prüfungsbogen abgelegt.</p>`}
      </div>
      <div class="panel stack gap-s">
        <h2 class="h-m">Fragenkatalog</h2>
        <fieldset class="seg">
          <legend class="visually-hidden">Katalogversion</legend>
          ${Object.values(D.catalogs).map(c => Choice({
            name: 'catalog', className: '', checked: state.catalog === c.id,
            label: `${c.label} · ${c.questions.length}`, onChange: () => switchCatalog(c.id),
          }))}
        </fieldset>
        <p class="small muted m-0">${newest?.label ?? 'Die neueste Version'} ist die aktuelle Fassung mit ${newQuestions} zusätzlichen Fragen. Nicht jeder Ortsverband prüft schon danach: Frag deine/n Ausbildungsbeauftragte/n, welche Version gilt. Der Fortschritt wird je Version getrennt gespeichert.</p>
        <div><button class="btn sm danger" @click=${resetProgress}>Fortschritt zurücksetzen</button></div>
      </div>
    </section>
    <div class="grid2">${InstallPanel()}</div>
    ${BackupPanel()}
    <p class="foot">Inoffizieller Lerntrainer. Grundlage: Prüfungsfragen-Katalog Theorie (Version 3.2, THW-Leitung 2019, sowie Stand 2024) und die praktischen Prüfungsaufgaben der Grundausbildung. Verbindlich sind die aktuelle Prüfungsvorschrift (DV 2-220), die Ausbildungshandbücher und die Unfallverhütungsvorschriften. Dein Fortschritt bleibt nur in diesem Browser gespeichert. Mit einem Sicherungscode überträgst du ihn auf ein anderes Gerät.</p>
  </div>`;
}


// ---------- Backup code ----------

function BackupPanel() {
  const b = ui.backup;
  const hasProgress = Object.keys(state.stats).length || state.exams.length || Object.keys(state.stations).length;
  const set = patch => { Object.assign(b, patch); rerender(); };

  async function create() {
    set({ busy: true, copied: false, error: null, message: null });
    try {
      b.code = await encodeBackup(state);
    } catch {
      b.error = 'Der Code konnte in diesem Browser nicht erstellt werden. Bitte einen aktuellen Browser verwenden.';
    }
    set({ busy: false });
    focus('#backup-code');
  }

  async function copy() {
    const field = $app.querySelector('#backup-code');
    try {
      await navigator.clipboard.writeText(b.code);
      set({ copied: true });
      announce('Sicherungscode kopiert.');
    } catch {
      field?.focus();
      field?.select();
      set({ message: 'Kopieren wurde blockiert. Der Code ist markiert: kopiere ihn mit Strg+C bzw. über das Menü deines Handys.' });
    }
  }

  async function restore() {
    set({ busy: true, error: null, message: null });
    try {
      const incoming = await decodeBackup(b.input);
      const { state: next, changed } = mergeProgress(state, incoming);
      state = next;
      const parts = [
        changed.questions && plural(changed.questions, 'Frage', 'Fragen'),
        changed.exams && plural(changed.exams, 'Prüfungsbogen', 'Prüfungsbögen'),
        changed.stations && plural(changed.stations, 'Station', 'Stationen'),
        changed.memory && plural(changed.memory, 'Memory-Bestwert', 'Memory-Bestwerte'),
      ].filter(Boolean);
      b.input = '';
      b.message = parts.length ? `Übernommen: ${parts.join(', ')}.` : 'Nichts Neues: Dieser Stand ist hier schon vorhanden.';
      b.busy = false;
      commit();
      store.flush();
      announce(b.message);
    } catch (err) {
      set({ busy: false, error: `${err.message ?? 'Der Code konnte nicht gelesen werden.'} Prüfe, ob du ihn vollständig kopiert hast.` });
    }
  }

  return html`<section class="panel stack gap-m" aria-labelledby="h-backup">
    <div class="stack gap-xs">
      <h2 class="h-m" id="h-backup">Fortschritt sichern und übertragen</h2>
      <p class="small muted m-0">Dein Lernstand liegt nur in diesem Browser. Mit einem Sicherungscode nimmst du ihn auf ein anderes Gerät mit oder holst ihn nach dem Löschen der Browserdaten zurück. Es wird nichts hochgeladen: Der Code enthält deinen Stand selbst.</p>
    </div>
    <div class="grid2">
      <div class="stack gap-s">
        <h3 class="h-s">1 · Code erstellen</h3>
        <div class="row">
          <button class="btn primary" ?disabled=${b.busy || !hasProgress} @click=${create}>${b.code ? 'Code neu erstellen' : 'Sicherungscode erstellen'}</button>
          ${b.code ? html`<button class="btn" @click=${copy}>${b.copied ? 'Kopiert ✓' : 'Kopieren'}</button>` : nothing}
        </div>
        ${!hasProgress ? html`<p class="small muted m-0">Noch kein Fortschritt zum Sichern.</p>` : nothing}
        ${b.code ? html`<label class="small muted" for="backup-code">Dein Code (${b.code.length.toLocaleString('de-DE')} Zeichen). Schick ihn dir z. B. per Messenger oder Mail.</label>
          <textarea id="backup-code" class="codebox" readonly rows="4" .value=${b.code} @focus=${e => e.target.select()}></textarea>` : nothing}
      </div>
      <div class="stack gap-s">
        <h3 class="h-s">2 · Code einfügen</h3>
        <label class="small muted" for="backup-input">Füge hier einen Code ein, der mit GA1- beginnt. Dein Stand hier bleibt erhalten, neuere Einträge werden übernommen.</label>
        <textarea id="backup-input" class="codebox" rows="4" placeholder="GA1-…" .value=${b.input}
          @input=${e => { b.input = e.target.value; b.error = null; b.message = null; rerender(); }}></textarea>
        <div><button class="btn primary" ?disabled=${b.busy || !b.input.trim()} @click=${restore}>Fortschritt übernehmen</button></div>
      </div>
    </div>
    <div role="status">${b.error ? html`<p class="feedback bad m-0">${b.error}</p>` : b.message ? html`<p class="feedback ok m-0">${b.message}</p>` : nothing}</div>
  </section>`;
}

function switchCatalog(id) {
  state.catalog = id;
  ui.learn.session = null;
  if (!catalog().hasChanges && ui.learn.mode === 'changed') ui.learn.mode = 'all';
  commit();
}

async function resetProgress() {
  const ok = await confirmDialog({
    title: 'Gesamten Fortschritt löschen?',
    body: 'Statistik, Prüfungshistorie und Praxis-Ergebnisse werden entfernt. Das lässt sich nicht rückgängig machen.',
    confirmLabel: 'Ja, löschen',
    danger: true,
  });
  if (!ok) return;
  state = { ...defaultState(), catalog: state.catalog, shuffleAnswers: state.shuffleAnswers };
  ui.learn.session = null;
  ui.examResult = null;
  ui.parcoursResult = null;
  commit();
  store.flush();
  announce('Fortschritt gelöscht.');
}

// ---------- Exam ----------

function ExamView() {
  if (state.activeExam) return ExamRunning(state.activeExam);
  if (ui.examResult) return ExamResult(ui.examResult);
  return ExamIntro();
}

function ExamIntro() {
  return html`<div class="stack gap-l w-narrow">
    <div class="stack gap-s">
      <span class="eyebrow">Theorieteil</span>
      <h1 class="h-page" tabindex="-1">Prüfungsbogen</h1>
      <p class="lead">${EXAM.questionCount} Fragen wie in der echten Prüfung. Die Auswertung kommt erst nach dem Abgeben.</p>
    </div>
    <div class="panel"><dl class="grid2 m-0">
      <div><dt class="eyebrow">Umfang</dt><dd class="m-0"><span class="big num">${EXAM.questionCount}</span><div class="small muted">Fragen, mindestens eine je Lernabschnitt</div></dd></div>
      <div><dt class="eyebrow">Zeit</dt><dd class="m-0"><span class="big num">${EXAM.timeLimitSec / 60}</span><div class="small muted">Minuten. Ziel im Training: unter ${EXAM.targetSec / 60} Minuten</div></dd></div>
      <div><dt class="eyebrow">Bestanden ab</dt><dd class="m-0"><span class="big num">${EXAM.passMark}</span><div class="small muted">richtigen Fragen (${Math.round((100 * EXAM.passMark) / EXAM.questionCount)} %)</div></dd></div>
      <div><dt class="eyebrow">Wertung</dt><dd class="m-0"><strong>Eine Frage zählt nur als richtig, wenn alle richtigen Antworten angekreuzt sind.</strong><div class="small muted">Es können eine, zwei oder drei Antworten richtig sein.</div></dd></div>
    </dl></div>
    <div class="row">
      ${Choice({ type: 'checkbox', checked: state.shuffleAnswers, label: 'Antwortreihenfolge mischen', onChange: toggleShuffle })}
      <span class="small muted">Katalog: ${catalog().label} · <a href="#home">ändern</a></span>
    </div>
    <p class="small muted m-0">Der Bogen bleibt erhalten, wenn du die Seite neu lädst. Die Zeit läuft dabei weiter.</p>
    <div><button class="btn primary" @click=${startExam}>Prüfungsbogen starten</button></div>
  </div>`;
}

function toggleShuffle() {
  state.shuffleAnswers = !state.shuffleAnswers;
  commit();
}

function startExam() {
  state.activeExam = createExam(catalog().questions, { catalog: state.catalog, shuffleAnswers: state.shuffleAnswers });
  ui.examResult = null;
  ui.examWarned = new Set();
  commit();
  focus('h1');
}

function Timer(exam) {
  const left = examRemainingSec(exam);
  return html`<span class="timer num ${left < EXAM.lowTimeSec ? 'low' : ''}" role="timer" aria-label="Restzeit ${formatDuration(left)}">${formatDuration(left)}</span>`;
}

function ExamRunning(exam) {
  const i = exam.current;
  const question = D.catalogs[exam.catalog].byId.get(exam.ids[i]);
  const last = exam.ids.length - 1;
  const answered = exam.answers.filter(a => a.length).length;
  const elapsed = examElapsedSec(exam);
  const flagged = exam.flags[i];

  return html`<div class="exam-layout">
    <div class="stack">
      <h1 class="visually-hidden" tabindex="-1">Prüfungsbogen, Frage ${i + 1} von ${exam.ids.length}</h1>
      <div class="mtimer panel"><span class="eyebrow">Restzeit</span>${Timer(exam)}</div>
      <article class="qcard">
        ${QuestionBlock({
          key: 'exam', question, order: exam.orders[i], selected: exam.answers[i], revealed: false,
          onToggle: toggleExamAnswer,
          aside: html`<button class="chip" aria-pressed=${ariaBool(flagged)} @click=${toggleExamFlag}>${flagged ? 'Markiert' : 'Markieren'}</button>`,
        })}
        <div class="qfoot">
          <button class="btn" ?disabled=${i === 0} @click=${() => goToExamQuestion(i - 1)}>Zurück</button>
          <span class="small muted num">${i + 1} / ${exam.ids.length}</span>
          ${i < last
            ? html`<button class="btn primary" @click=${() => goToExamQuestion(i + 1)}>Weiter</button>`
            : html`<button class="btn primary" @click=${submitExam}>Zur Abgabe</button>`}
        </div>
      </article>
      <p class="hint">Tastatur: <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> ankreuzen · <kbd>←</kbd><kbd>→</kbd> blättern · <kbd>M</kbd> markieren</p>
    </div>
    <aside class="side" aria-label="Bogenübersicht">
      <div class="panel stack gap-xs tpanel">
        <span class="eyebrow">Restzeit</span>
        ${Timer(exam)}
        <span class="small muted num">Bearbeitet seit ${formatDuration(elapsed)}${elapsed < EXAM.targetSec ? ` · Zielzeit ${formatDuration(EXAM.targetSec)}` : ''}</span>
      </div>
      <nav class="panel stack gap-s" aria-label="Fragen">
        <div class="row between"><span class="eyebrow">Fragen</span><span class="small muted num">${answered}/${exam.ids.length} beantwortet</span></div>
        <div class="navgrid">${exam.ids.map((_, n) => html`<button
          class="nav num ${exam.answers[n].length ? 'done' : ''} ${exam.flags[n] ? 'flag' : ''}"
          aria-current=${n === i ? 'true' : nothing}
          aria-label="Frage ${n + 1}${exam.answers[n].length ? ', beantwortet' : ''}${exam.flags[n] ? ', markiert' : ''}"
          @click=${() => goToExamQuestion(n)}>${n + 1}</button>`)}</div>
        <button class="btn" @click=${submitExam}>Abgeben</button>
      </nav>
    </aside>
  </div>`;
}

function toggleExamAnswer(answerIndex) {
  const exam = state.activeExam;
  const selected = exam.answers[exam.current];
  exam.answers[exam.current] = selected.includes(answerIndex)
    ? selected.filter(x => x !== answerIndex)
    : [...selected, answerIndex];
  commit();
}

function toggleExamFlag() {
  const exam = state.activeExam;
  exam.flags[exam.current] = !exam.flags[exam.current];
  commit();
}

function goToExamQuestion(n) {
  const exam = state.activeExam;
  if (n < 0 || n >= exam.ids.length || n === exam.current) return;
  exam.current = n;
  commit();
  focus('#qtext-exam');
}

async function submitExam() {
  const exam = state.activeExam;
  const open = exam.answers.filter(a => !a.length).length;
  const flagged = exam.flags.filter(Boolean).length;
  const details = [
    open && `${open} ${open === 1 ? 'Frage ist' : 'Fragen sind'} noch ohne Kreuz.`,
    flagged && `${flagged} markiert.`,
  ].filter(Boolean).join(' ') || 'Alle Fragen beantwortet.';
  const ok = await confirmDialog({ title: 'Bogen abgeben?', body: details, confirmLabel: 'Abgeben' });
  if (ok && state.activeExam === exam) finishExam();
}

function finishExam({ timedOut = false } = {}) {
  const exam = state.activeExam;
  if (!exam) return;
  if ($dialog.open) $dialog.close(); // e.g. time ran out while "Abgeben?" was showing
  const cat = D.catalogs[exam.catalog];
  const result = scoreExam(exam, cat.byId);
  exam.ids.forEach((id, i) => recordResult(exam.catalog, cat.byId.get(id), result.results[i]));
  state.exams = appendExamResult(state.exams, {
    at: Date.now(), score: result.score, passed: result.passed, durationSec: result.durationSec, catalog: exam.catalog,
  });
  state.activeExam = null;
  ui.examResult = { exam, ...result, timedOut };
  commit();
  store.flush();
  scrollToTop();
  focus('h1');
  announce(`${result.passed ? 'Bestanden' : 'Nicht bestanden'}: ${result.score} von ${exam.ids.length} richtig.`);
}

let examTimer = null;
function syncExamTimer() {
  if (state.activeExam && !examTimer) examTimer = setInterval(onExamTick, 1000);
  if (!state.activeExam && examTimer) { clearInterval(examTimer); examTimer = null; }
}
function onExamTick() {
  const left = examRemainingSec(state.activeExam);
  if (left <= 0) {
    finishExam({ timedOut: true });
    return;
  }
  const due = EXAM.warnAtSec.filter(sec => left <= sec && !ui.examWarned.has(sec));
  if (due.length) {
    due.forEach(sec => ui.examWarned.add(sec));
    const minutes = Math.min(...due) / 60;
    announce(`Noch ${minutes === 1 ? 'eine Minute' : `${minutes} Minuten`}.`);
  }
  rerender();
}

function ExamResult({ exam, results, score, passed, durationSec, timedOut }) {
  const cat = D.catalogs[exam.catalog];
  const questions = exam.ids.map(id => cat.byId.get(id));
  const wrong = results.flatMap((ok, i) => (ok ? [] : [i]));
  const allowedMistakes = exam.ids.length - EXAM.passMark;
  const bySection = new Map();
  questions.forEach((q, i) => {
    const s = bySection.get(sectionOf(q.id)) ?? { total: 0, right: 0 };
    s.total++;
    if (results[i]) s.right++;
    bySection.set(sectionOf(q.id), s);
  });
  const reviewCard = i => html`<article class="qcard" id="rev-${i}" tabindex="-1" aria-labelledby="qtext-rev-${i}">${QuestionBlock({
    key: `rev-${i}`, question: questions[i], order: exam.orders[i], selected: exam.answers[i], revealed: true,
    onToggle: () => {}, aside: html`<span class="small muted num">Bogen-Nr. ${i + 1}</span>`,
  })}</article>`;

  return html`<div class="stack gap-l">
    <section class="panel verdict">
      <div class="stack gap-xs">
        <h1 class="visually-hidden" tabindex="-1">Ergebnis: ${passed ? 'bestanden' : 'nicht bestanden'}</h1>
        <span class="stamp ${passed ? 'ok' : 'bad'}" aria-hidden="true">${passed ? 'Bestanden' : 'Nicht bestanden'}</span>
        ${timedOut ? html`<span class="small muted">Zeit abgelaufen, automatisch abgegeben.</span>` : nothing}
      </div>
      <div class="row gap-xl">
        <div><div class="eyebrow">Richtig</div>${Score(score, exam.ids.length)}</div>
        <div><div class="eyebrow">Fehler</div><div class="big num ${wrong.length > allowedMistakes ? 'text-bad' : ''}">${wrong.length}</div><div class="small muted">erlaubt: ${allowedMistakes}</div></div>
        <div><div class="eyebrow">Zeit</div><div class="big num">${formatDuration(durationSec)}</div><div class="small muted">${durationSec <= EXAM.targetSec ? 'unter der Zielzeit' : `Ziel: ${formatDuration(EXAM.targetSec)}`}</div></div>
      </div>
    </section>
    <section class="panel" aria-labelledby="h-by-section">
      <h2 class="h-m" id="h-by-section">Nach Lernabschnitt</h2>
      <ul class="la-list">${[...bySection].sort(([a], [b]) => a - b).map(([id, r]) => html`<li><div class="la-row">
        <span class="la-num num" aria-hidden="true">${String(id).padStart(2, '0')}</span>
        <span class="stack gap-xs"><span class="la-name">${D.sectionById.get(id).title}</span>
          <span class="bar" aria-hidden="true"><i class="m" style="width:${(100 * r.right) / r.total}%"></i><i class="w" style="width:${(100 * (r.total - r.right)) / r.total}%"></i></span></span>
        <span class="la-pct num">${r.right}/${r.total} richtig</span>
      </div></li>`)}</ul>
    </section>
    <section class="stack">
      <div class="row between">
        <h2 class="h-l">${wrong.length ? 'Deine Fehler' : 'Keine Fehler'}</h2>
        <div class="row">
          <button class="btn" @click=${newExam}>Neuer Bogen</button>
          ${wrong.length ? html`<a class="btn primary" href="#learn/weak">Fehler trainieren</a>` : nothing}
        </div>
      </div>
      <nav aria-label="Zu Frage springen"><div class="navgrid review">${results.map((ok, i) => html`<button
        class="nav num ${ok ? 'r' : 'w'}" aria-label="Frage ${i + 1}, ${ok ? 'richtig' : 'falsch'}"
        @click=${() => revealReviewCard(i)}>${i + 1}</button>`)}</div></nav>
      ${wrong.map(reviewCard)}
      <details class="panel" id="correct-review">
        <summary>Richtig beantwortete Fragen anzeigen (${score})</summary>
        <div class="stack">${results.flatMap((ok, i) => (ok ? [reviewCard(i)] : []))}</div>
      </details>
    </section>
  </div>`;
}

function newExam() {
  ui.examResult = null;
  rerender();
  focus('h1');
}

function revealReviewCard(i) {
  const card = document.getElementById(`rev-${i}`);
  if (!card) return;
  const details = card.closest('details');
  if (details) details.open = true;
  card.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
  card.focus({ preventScroll: true });
}

// ---------- Learn ----------

function LearnView() {
  ui.learn.sections ??= allSectionIds();
  const session = ui.learn.session;
  if (!session) return LearnSetup();
  return session.index < session.questions.length ? LearnQuestion(session) : LearnSummary(session);
}

function currentLearnPool() {
  return learnPool(catalog().questions, q => statOf(q), { sections: ui.learn.sections, mode: ui.learn.mode });
}

function LearnSetup() {
  const cfg = ui.learn;
  const pool = currentLearnPool();
  const size = cfg.count ? Math.min(cfg.count, pool.length) : pool.length;
  const modes = Object.entries(LEARN_MODES).filter(([mode]) => mode !== 'changed' || catalog().hasChanges);
  const update = fn => () => { fn(); rerender(); };

  return html`<div class="stack gap-l w-medium">
    <div class="stack gap-s">
      <span class="eyebrow">Lernmodus</span>
      <h1 class="h-page" tabindex="-1">Üben mit sofortiger Rückmeldung</h1>
      <p class="lead">Jede Antwort zählt für deine Statistik. Richtig beantwortete Fragen wandern eine Stufe höher, Fehler landen im Fehlertraining.</p>
    </div>
    <fieldset class="panel stack gap-s">
      <legend class="visually-hidden">Lernabschnitte</legend>
      <div class="row between">
        <span class="eyebrow" aria-hidden="true">Lernabschnitte</span>
        <span class="row gap-xs">
          <button class="btn ghost sm" @click=${update(() => { cfg.sections = allSectionIds(); })}>alle</button>
          <button class="btn ghost sm" @click=${update(() => { cfg.sections = new Set(); })}>keine</button>
        </span>
      </div>
      <div class="row gap-s">${D.sections.map(s => Choice({
        type: 'checkbox', checked: cfg.sections.has(s.id), title: s.title,
        label: html`LA ${s.id} <span class="muted small">${s.short}</span>`,
        onChange: update(() => { cfg.sections.has(s.id) ? cfg.sections.delete(s.id) : cfg.sections.add(s.id); }),
      }))}</div>
    </fieldset>
    <div class="panel stack gap-m">
      <fieldset class="stack gap-s">
        <legend class="eyebrow">Auswahl</legend>
        <div class="row gap-s">${modes.map(([mode, label]) => Choice({
          name: 'mode', checked: cfg.mode === mode, label, onChange: update(() => { cfg.mode = mode; }),
        }))}</div>
      </fieldset>
      <fieldset class="stack gap-s">
        <legend class="eyebrow">Anzahl</legend>
        <div class="row gap-s">
          ${LEARN_COUNTS.map(n => Choice({
            name: 'count', checked: cfg.count === n, label: n || 'Alle', onChange: update(() => { cfg.count = n; }),
          }))}
          ${Choice({ type: 'checkbox', checked: state.shuffleAnswers, label: 'Antworten mischen', onChange: toggleShuffle })}
        </div>
      </fieldset>
    </div>
    <div class="row">
      <button class="btn primary" ?disabled=${!pool.length} @click=${() => startLearn(pool, size)}>
        ${pool.length ? `Los geht's · ${size} Fragen` : 'Keine Fragen in dieser Auswahl'}
      </button>
      <span class="small muted num">${pool.length} Fragen passen</span>
    </div>
  </div>`;
}

function startLearn(pool, size = pool.length) {
  // Weak mode keeps its "shakiest first" order; everything else is shuffled.
  const ordered = ui.learn.mode === 'weak' ? pool : shuffle(pool);
  const questions = ordered.slice(0, size);
  ui.learn.session = {
    catalog: state.catalog, questions, index: 0, selected: [], revealed: false, correctCount: 0, results: [],
    order: answerOrder(questions[0], state.shuffleAnswers),
  };
  rerender();
  scrollToTop();
  focus('#qtext-learn');
}

function LearnQuestion(session) {
  const question = session.questions[session.index];
  const stat = statOf(question, session.catalog);
  const correct = session.revealed && isCorrect(question, session.selected);
  const isLast = session.index + 1 >= session.questions.length;

  return html`<div class="stack w-medium">
    <h1 class="visually-hidden" tabindex="-1">Üben, Frage ${session.index + 1} von ${session.questions.length}</h1>
    <div class="row between">
      <span class="small muted num">Frage ${session.index + 1} von ${session.questions.length} · ${session.correctCount} richtig</span>
      <button class="btn ghost sm" @click=${endLearn}>Beenden</button>
    </div>
    <div class="progress" aria-hidden="true"><i style="width:${(100 * session.index) / session.questions.length}%"></i></div>
    <article class="qcard">
      ${QuestionBlock({
        key: 'learn', question, order: session.order, selected: session.selected, revealed: session.revealed,
        onToggle: toggleLearnAnswer,
        aside: stat
          ? html`<span class="small muted num">${stat.right}/${stat.seen} richtig · Stufe ${stat.streak}</span>`
          : html`<span class="small muted">neu für dich</span>`,
      })}
      ${session.revealed ? html`<div class="feedback ${correct ? 'ok' : 'bad'}">${correct ? 'Richtig.' : feedbackFor(question)}</div>` : nothing}
      <div class="qfoot">
        <span class="hint">${session.revealed
          ? html`<kbd>Enter</kbd> weiter`
          : html`<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> ankreuzen · <kbd>Enter</kbd> prüfen`}</span>
        ${session.revealed
          ? html`<button class="btn primary" id="next-question" @click=${nextLearnQuestion}>${isLast ? 'Auswertung' : 'Nächste Frage'}</button>`
          : html`<button class="btn primary" ?disabled=${!session.selected.length} @click=${checkLearnAnswer}>Prüfen</button>`}
      </div>
    </article>
  </div>`;
}

const feedbackFor = question => `Nicht ganz. ${question.correct.length > 1
  ? `Hier sind ${question.correct.length} Antworten richtig.`
  : 'Richtig ist nur eine Antwort.'}`;

function toggleLearnAnswer(answerIndex) {
  const session = ui.learn.session;
  if (session.revealed) return;
  session.selected = session.selected.includes(answerIndex)
    ? session.selected.filter(x => x !== answerIndex)
    : [...session.selected, answerIndex];
  rerender();
}

function checkLearnAnswer() {
  const session = ui.learn.session;
  if (!session.selected.length || session.revealed) return;
  const question = session.questions[session.index];
  const correct = isCorrect(question, session.selected);
  session.revealed = true;
  if (correct) session.correctCount++;
  session.results.push({ question, correct });
  recordResult(session.catalog, question, correct);
  commit();
  focus('#next-question');
  announce(correct ? 'Richtig.' : feedbackFor(question));
}

function nextLearnQuestion() {
  const session = ui.learn.session;
  session.index++;
  session.selected = [];
  session.revealed = false;
  if (session.index < session.questions.length) {
    session.order = answerOrder(session.questions[session.index], state.shuffleAnswers);
  }
  rerender();
  scrollToTop();
  focus(session.index < session.questions.length ? '#qtext-learn' : 'h1');
}

function endLearn() {
  const session = ui.learn.session;
  session.questions = session.questions.slice(0, session.index + (session.revealed ? 1 : 0));
  session.index = session.questions.length;
  rerender();
  focus('h1');
}

function LearnSummary(session) {
  const wrong = session.results.filter(r => !r.correct);
  const answered = session.results.length;
  return html`<div class="stack gap-l w-medium">
    <section class="panel verdict">
      <div><h1 class="eyebrow" tabindex="-1">Runde beendet</h1>${Score(session.correctCount, answered)}</div>
      <div class="stack gap-s">
        <span class="muted">${answered ? `${Math.round((100 * session.correctCount) / answered)} % richtig. ` : ''}${wrong.length ? `${plural(wrong.length, 'Frage ist', 'Fragen sind')} jetzt im Fehlertraining.` : 'Keine neuen Fehler.'}</span>
        <div class="row">
          <button class="btn primary" @click=${() => { ui.learn.session = null; rerender(); focus('h1'); }}>Neue Runde</button>
          ${wrong.length ? html`<button class="btn" @click=${() => startLearn(shuffle(wrong.map(r => r.question)))}>Nur diese Fehler wiederholen</button>` : nothing}
        </div>
      </div>
    </section>
    ${wrong.length ? html`<section class="panel">
      <h2 class="h-m">Falsch beantwortet</h2>
      <ul class="cat-list">${wrong.map(r => CatalogItem(r.question, { stat: statOf(r.question, session.catalog) }))}</ul>
    </section>` : nothing}
  </div>`;
}

// ---------- Practice ----------

function PracticeView() {
  if (ui.tools) return ToolsView(ui.tools);
  if (ui.xo) return XoQuiz(ui.xo);
  if (ui.parcoursResult) return ParcoursSummary(ui.parcoursResult);
  if (ui.station) return StationView(ui.station);
  return PracticeOverview();
}

function newStationSession(station) {
  return {
    station,
    revealed: false,
    known: station.criteria.map(() => null),
    guesses: station.criteria.map(() => null),
    showCard: false,
  };
}

function StationStatus(id) {
  const r = state.stations[id];
  if (!r) return nothing;
  return r.passed ? html`<span class="tag ok">bestanden</span>` : html`<span class="tag bad">nochmal</span>`;
}

function PracticeOverview() {
  const groups = Map.groupBy(D.stations, s => sectionOf(s.id));
  const practised = Object.keys(state.stations).length;
  const passed = Object.values(state.stations).filter(s => s.passed).length;
  return html`<div class="stack gap-l">
    <div class="stack gap-s">
      <span class="eyebrow">Praxisteil · Stationsbetrieb</span>
      <h1 class="h-page" tabindex="-1">Praxisstationen</h1>
      <p class="lead">Jede Station hat Bewertungskriterien. <strong>X</strong> sind Pflichtkriterien und müssen erfüllt sein, <strong>O</strong> sind weitere Kriterien. „5 von 7“ heißt: alle X-Kriterien plus genug O-Kriterien, bis 5 erreicht sind.</p>
    </div>
    <div class="grid2">
      <button class="action" @click=${startParcours}><span class="eyebrow">Simulation</span><h2 class="h-card">Prüfungsparcours</h2><span class="meta">Eine zufällige Station je Lernabschnitt (LA 3 bis 10). Erst aus dem Kopf aufzählen, dann Kriterien abhaken.</span></button>
      <button class="action" @click=${startXoQuiz}><span class="eyebrow">Schnelltraining</span><h2 class="h-card">Pflicht oder nicht?</h2><span class="meta">${XO_QUIZ_SIZE} zufällige Kriterien aus allen Stationen: Ist das ein X- oder ein O-Kriterium?</span></button>
      <a class="action" href="#prac/${TOOL_ROUTE}"><span class="eyebrow">LA 6 · mit Bildern</span><h2 class="h-card">Werkzeug-Memory</h2><span class="meta">${TOOLS.length} Werkzeuge aus P 6.1.1 bis 6.1.3: Memory, Benennen und Zeigen.</span></a>
      <div class="action"><span class="eyebrow">Dein Stand</span><h2 class="h-card num">${passed} / ${D.stations.length} bestanden</h2><span class="meta num">${practised} Stationen geübt</span></div>
    </div>
    ${[...groups].sort(([a], [b]) => a - b).map(([sectionId, stations]) => {
      const section = D.sectionById.get(sectionId);
      return html`<section class="stack gap-s">
        <h2 class="h-m">LA ${sectionId} · ${section.practiceTitle ?? section.title}</h2>
        <ul class="st-list">${stations.map(s => html`<li><a class="st" href="#prac/${s.id}">
          <span class="pid">P ${s.id}</span>
          <span><span class="t">${s.title}</span><span class="s"><span class="tag num">${s.required} von ${s.criteria.length}</span>${StationStatus(s.id)}</span></span>
        </a></li>`)}</ul>
      </section>`;
    })}
    <p class="foot">Die Kriterien entsprechen der aktuellen Fassung der praktischen Prüfungsaufgaben. Die ältere PDF-Fassung (Version 2.2, 2014) weicht bei Nummerierung und Kriterien teils ab. Maßgeblich für Arbeitssicherheit sind die Betriebsanweisungen der Geräte und die UVV.</p>
  </div>`;
}

function StationView(session) {
  const { station } = session;
  const index = D.stations.indexOf(station);
  const prev = D.stations[index - 1];
  const next = D.stations[index + 1];
  const mandatory = station.criteria.filter(c => c.mandatory).length;
  const mode = ui.stationMode;
  const allMarked = session.known.every(v => v !== null);
  const parcours = ui.parcours;
  const modes = { recall: 'Selbstcheck', xo: 'X oder O?', read: 'Lesen' };

  return html`<div class="stack gap-m w-wide">
    <div class="row between">
      <a class="btn ghost sm" href="#prac">← Alle Stationen</a>
      ${parcours ? html`<span class="tag">Parcours ${parcours.index + 1} / ${parcours.ids.length}</span>` : nothing}
    </div>
    <div class="stack gap-xs">
      <span class="qid lg">P ${station.id}</span>
      <h1 class="h-page" tabindex="-1">${station.title}</h1>
    </div>
    <div class="panel req">
      <div><div class="eyebrow">Bewertung</div><b class="num">${station.required} von ${station.criteria.length}</b></div>
      <div><div class="eyebrow">Pflicht (X)</div><b class="num">${mandatory}</b></div>
      <div class="small muted">Bestanden, wenn alle ${mandatory} X-Kriterien und insgesamt mindestens ${station.required} Kriterien erfüllt sind.</div>
    </div>
    ${station.material ? html`<div class="small"><span class="eyebrow">Materialbedarf</span><div class="muted">${station.material}</div></div>` : nothing}
    <fieldset class="seg">
      <legend class="visually-hidden">Übungsart</legend>
      ${Object.entries(modes).map(([key, label]) => Choice({
        name: 'station-mode', className: '', checked: mode === key, label,
        onChange: () => { ui.stationMode = key; rerender(); },
      }))}
    </fieldset>
    ${mode === 'recall' ? RecallMode(session, allMarked) : mode === 'xo' ? GuessMode(session) : ReadMode(station)}
    ${TOOL_SETS[station.id] && !parcours ? html`<a class="btn primary self-start" href="#prac/${TOOL_ROUTE}-${station.id}">Werkzeuge mit Bildern üben</a>` : nothing}
    ${station.note ? html`<div class="note"><strong>Anmerkung für die Prüfer/innen:</strong> ${station.note}</div>` : nothing}
${station.image ? html`    <div class="stack gap-s">
      <button class="btn" aria-expanded=${ariaBool(session.showCard)} aria-controls="learning-card"
        @click=${() => { session.showCard = !session.showCard; rerender(); }}>
        ${session.showCard ? 'Lernkarte ausblenden' : 'Lernkarte mit Abbildungen anzeigen'}
      </button>
      <div id="learning-card">${session.showCard ? html`<img class="cardimg" src="lk/${station.id}.webp"
        width=${station.image.width} height=${station.image.height} loading="lazy"
        alt="Lernkarte P ${station.id}: Bewertungskriterien und Abbildungen">` : nothing}</div>
    </div>` : nothing}
    <div class="row between nav-footer">
      ${parcours
        ? html`<span></span><button class="btn primary" ?disabled=${mode === 'recall' && !allMarked} @click=${nextParcoursStation}>
            ${parcours.index + 1 < parcours.ids.length ? 'Nächste Station' : 'Parcours auswerten'}</button>`
        : html`
          ${prev ? html`<a class="btn" href="#prac/${prev.id}">← P ${prev.id}</a>` : html`<span></span>`}
          <button class="btn" @click=${() => navigate(`#prac/${D.stations[Math.floor(Math.random() * D.stations.length)].id}`)}>Zufällige Station</button>
          ${next ? html`<a class="btn" href="#prac/${next.id}">P ${next.id} →</a>` : html`<span></span>`}`}
    </div>
  </div>`;
}

function saveStationResult(session) {
  const { got, passed } = evaluateStation(session.station, session.known);
  state.stations[session.station.id] = { passed, got, at: Date.now() };
  commit();
}

function RecallMode(session, allMarked) {
  const { station } = session;
  if (!session.revealed) {
    return html`<div class="panel stack gap-s">
      <strong>Zähl die ${station.criteria.length} Kriterien aus dem Kopf auf.</strong>
      <span class="muted">Am besten laut oder auf einem Zettel, so wie du die Station vor dem/der Prüfer/in abarbeiten würdest. Achte besonders auf die Pflichtpunkte.</span>
      <div><button class="btn primary" @click=${() => { session.revealed = true; rerender(); focus('.crit input'); }}>Kriterien aufdecken</button></div>
    </div>`;
  }
  const ev = evaluateStation(station, session.known);
  const mark = (i, value) => {
    session.known[i] = value;
    if (session.known.every(v => v !== null)) saveStationResult(session);
    else rerender();
  };
  return html`<div class="stack gap-s">
    <div class="row between">
      <span class="small muted">Was hattest du? Markiere jedes Kriterium.</span>
      <button class="btn ghost sm" @click=${() => { session.known = session.known.map(() => true); saveStationResult(session); }}>Alle gewusst</button>
    </div>
    <div class="scroll-x"><table class="crit">
      <thead class="visually-hidden"><tr><th scope="col">Art</th><th scope="col">Kriterium</th><th scope="col">Selbsteinschätzung</th></tr></thead>
      <tbody>${station.criteria.map((c, i) => html`<tr>
        <td class="xo ${c.mandatory ? 'x' : 'o'}"><span aria-hidden="true">${c.mandatory ? 'X' : 'O'}</span><span class="visually-hidden">${c.mandatory ? 'Pflicht' : 'weiteres'}</span></td>
        <th scope="row" id="crit-${i}">${c.text}</th>
        <td class="chk"><fieldset class="know" aria-labelledby="crit-${i}">
          ${Choice({ name: `known-${i}`, className: 'y', checked: session.known[i] === true, label: 'gewusst', onChange: () => mark(i, true) })}
          ${Choice({ name: `known-${i}`, className: 'n', checked: session.known[i] === false, label: 'fehlte', onChange: () => mark(i, false) })}
        </fieldset></td>
      </tr>`)}</tbody>
    </table></div>
    <div role="status">${allMarked ? html`<div class="feedback ${ev.passed ? 'ok' : 'bad'}">${stationVerdict(station, ev)}</div>` : nothing}</div>
  </div>`;
}

function stationVerdict(station, { passed, got, missingMandatory }) {
  if (passed) return `Bestanden: ${got} von ${station.criteria.length} Kriterien, alle Pflichtpunkte dabei.`;
  if (missingMandatory) {
    return `Nicht bestanden: ${missingMandatory} ${missingMandatory > 1 ? 'Pflichtkriterien (X) fehlten' : 'Pflichtkriterium (X) fehlte'}.`;
  }
  return `Nicht bestanden: ${got} von ${station.required} nötigen Kriterien.`;
}

function GuessMode(session) {
  const { station } = session;
  const done = session.guesses.every(v => v !== null);
  const right = station.criteria.filter((c, i) => session.guesses[i] === c.mandatory).length;
  return html`<div class="stack gap-s">
    <span class="small muted">Welche Kriterien sind Pflicht (X), welche optional (O)?</span>
    <div class="scroll-x"><table class="crit">
      <thead class="visually-hidden"><tr><th scope="col">Kriterium</th><th scope="col">Deine Einordnung</th><th scope="col">Lösung</th></tr></thead>
      <tbody>${station.criteria.map((c, i) => {
        const guess = session.guesses[i];
        const set = value => () => { session.guesses[i] = value; rerender(); };
        return html`<tr>
          <th scope="row" id="guess-${i}">${c.text}</th>
          <td class="chk"><fieldset class="know guess" aria-labelledby="guess-${i}">
            ${Choice({ name: `guess-${i}`, className: '', checked: guess === true, label: 'X', onChange: set(true) })}
            ${Choice({ name: `guess-${i}`, className: '', checked: guess === false, label: 'O', onChange: set(false) })}
          </fieldset></td>
          <td class="xo ${done ? (guess === c.mandatory ? 'good' : 'miss') : ''}">${done
            ? html`${c.mandatory ? 'X' : 'O'}<span class="visually-hidden">, ${guess === c.mandatory ? 'richtig' : 'falsch'}</span>`
            : html`<span aria-hidden="true">?</span><span class="visually-hidden">noch offen</span>`}</td>
        </tr>`;
      })}</tbody>
    </table></div>
    <div role="status">${done ? html`<div class="feedback ${right === station.criteria.length ? 'ok' : 'bad'}">${right} von ${station.criteria.length} richtig eingeordnet.</div>` : nothing}</div>
  </div>`;
}

function ReadMode(station) {
  return html`<div class="scroll-x"><table class="crit"><tbody>${station.criteria.map(c => html`<tr>
    <td class="xo ${c.mandatory ? 'x' : 'o'}"><span aria-hidden="true">${c.mandatory ? 'X' : 'O'}</span><span class="visually-hidden">${c.mandatory ? 'Pflicht' : 'weiteres'}</span></td>
    <td>${c.text}</td>
  </tr>`)}</tbody></table></div>`;
}

// --- Parcours: one random station per section, then a summary ---

function startParcours() {
  const groups = Map.groupBy(D.stations, s => sectionOf(s.id));
  const ids = [...groups].sort(([a], [b]) => a - b).map(([, stations]) => shuffle(stations)[0].id);
  ui.parcours = { ids, index: 0, results: [] };
  ui.stationMode = 'recall';
  ui.station = newStationSession(D.stationById.get(ids[0]));
  rerender();
  scrollToTop();
  focus('h1');
}

function nextParcoursStation() {
  const parcours = ui.parcours;
  const session = ui.station;
  const allMarked = session.known.every(v => v !== null);
  const passed = ui.stationMode === 'recall' && allMarked ? evaluateStation(session.station, session.known).passed : null;
  parcours.results.push({ id: session.station.id, passed });
  parcours.index++;
  if (parcours.index < parcours.ids.length) {
    ui.stationMode = 'recall'; // the simulation grades every station, so undo a switch to "Lesen"
    ui.station = newStationSession(D.stationById.get(parcours.ids[parcours.index]));
  } else {
    ui.parcoursResult = parcours.results;
    ui.parcours = null;
    ui.station = null;
  }
  rerender();
  scrollToTop();
  focus('h1');
}

function ParcoursSummary(results) {
  const passed = results.filter(r => r.passed).length;
  const all = passed === results.length;
  return html`<div class="stack gap-m w-wide">
    <section class="panel verdict">
      <h1 class="stamp ${all ? 'ok' : 'bad'}" tabindex="-1"><span aria-hidden="true">${all ? 'Alle bestanden' : `${passed} / ${results.length}`}</span><span class="visually-hidden">Parcours: ${passed} von ${results.length} Stationen bestanden</span></h1>
      <span class="muted">Im Parcours hast du ${passed} von ${results.length} Stationen nach den Kriterien bestanden.</span>
    </section>
    <ul class="st-list">${results.map(r => {
      const s = D.stationById.get(r.id);
      const tag = r.passed === null ? html`<span class="tag">nicht bewertet</span>`
        : r.passed ? html`<span class="tag ok">bestanden</span>` : html`<span class="tag bad">nochmal</span>`;
      return html`<li><a class="st" href="#prac/${s.id}"><span class="pid">P ${s.id}</span><span><span class="t">${s.title}</span><span class="s">${tag}</span></span></a></li>`;
    })}</ul>
    <div class="row">
      <button class="btn primary" @click=${() => { ui.parcoursResult = null; startParcours(); }}>Neuer Parcours</button>
      <a class="btn" href="#prac">Alle Stationen</a>
    </div>
  </div>`;
}


// --- Werkzeuge erkennen (P 6.1.1–6.1.3): Memory, Benennen, Zeigen ---

const toolByKey = new Map(TOOLS.map(t => [t.k, t]));

/**
 * Picture of a tool: an own photo (tool.img) if one exists, otherwise the
 * built-in drawing. Drawings are static strings from tools.js, never user input.
 * Decorative: callers show the name or label the container.
 */
function ToolPicture(tool) {
  if (tool.img) return html`<img src=${tool.img} width=${tool.w} height=${tool.h} alt="" loading="lazy" decoding="async">`;
  const tpl = document.createElement('template');
  tpl.innerHTML = tool.svg;
  const svg = tpl.content.firstElementChild;
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

function newToolsSession(setId) {
  return { set: setId in TOOL_SETS ? setId : 'all', mode: 'menu', game: null, quiz: null };
}

const toolPool = session => TOOL_SETS[session.set].tools;

function setToolsMode(session, mode) {
  session.mode = mode;
  if (mode === 'memory') {
    const tools = shuffle(toolPool(session)).slice(0, MEMORY_MAX_PAIRS);
    session.game = { cards: createMemoryDeck(tools), open: [], matched: new Set(), moves: 0, startedAt: Date.now(), locked: false, missed: [], last: null, result: null };
  }
  if (mode === 'name' || mode === 'show') {
    session.quiz = { items: shuffle(toolPool(session)), index: 0, options: null, answer: null, correct: 0 };
  }
  rerender();
  scrollToTop();
  focus('h1');
}

function ToolsView(session) {
  if (session.mode === 'memory') return MemoryGame(session);
  if (session.mode === 'name' || session.mode === 'show') return ToolQuiz(session);
  const pool = toolPool(session);
  const best = state.memory[session.set];
  return html`<div class="stack gap-l">
    <div class="row between"><a class="btn ghost sm" href="#prac">← Alle Stationen</a></div>
    <div class="stack gap-s">
      <span class="eyebrow">Praxis · LA 6 Holzbearbeitung</span>
      <h1 class="h-page" tabindex="-1">Werkzeuge erkennen</h1>
      <p class="lead">An den Stationen P 6.1.1 bis 6.1.3 musst du Werkzeuge zeigen oder benennen. Hier übst du Bild und Begriff zusammen.</p>
    </div>
    <fieldset class="panel stack gap-s">
      <legend class="eyebrow">Werkzeugsatz</legend>
      <div class="row gap-s">${Object.entries(TOOL_SETS).map(([id, s]) => Choice({
        name: 'tool-set', checked: session.set === id,
        label: html`${s.label} <span class="muted small">${s.tools.length}</span>`,
        onChange: () => { session.set = id; rerender(); },
      }))}</div>
    </fieldset>
    <div class="grid2">
      <button class="action" @click=${() => setToolsMode(session, 'memory')}><span class="eyebrow">Spiel</span><h2 class="h-card">Memory</h2>
        <span class="meta">Finde die Paare aus Bild und Begriff.${pool.length > MEMORY_MAX_PAIRS ? ` Pro Runde ${MEMORY_MAX_PAIRS} zufällige Werkzeuge.` : ''}${best ? ` Bestwert: ${plural(best.moves, 'Zug', 'Züge')}, ${formatDuration(best.durationSec)}.` : ''}</span></button>
      <button class="action" @click=${() => setToolsMode(session, 'name')}><span class="eyebrow">Wie in P 6.1.2</span><h2 class="h-card">Benennen</h2><span class="meta">Du siehst ein Werkzeug und wählst den richtigen Namen.</span></button>
      <button class="action" @click=${() => setToolsMode(session, 'show')}><span class="eyebrow">Wie in P 6.1.1 / 6.1.3</span><h2 class="h-card">Zeigen</h2><span class="meta">Du bekommst einen Begriff und tippst auf das passende Werkzeug.</span></button>
    </div>
    <section class="stack gap-s">
      <h2 class="h-l">Übersicht zum Einprägen</h2>
      <ul class="tool-gal">${pool.map(t => html`<li class="tool">
        <div class="pic">${ToolPicture(t)}</div>
        <div class="tx"><b>${t.n}</b><span class="small muted">${t.d}</span><span class="small faint">Station ${t.st.map(s => `P ${s}`).join(', ')}</span></div>
      </li>`)}</ul>
    </section>
    <p class="foot">An der Station liegt das Werkzeug aus deinem OV, das anders aussehen kann als auf der Abbildung. Schau dir die Werkzeuge deshalb auch in der Unterkunft an. ${TOOL_CREDIT}</p>
  </div>`;
}

function flipMemoryCard(session, i) {
  const game = session.game;
  const card = game.cards[i];
  if (game.locked || game.open.includes(i) || game.matched.has(card.key)) return;
  game.missed = [];
  game.open.push(i);
  if (game.open.length < 2) { rerender(); return; }
  game.moves++;
  const [a, b] = game.open.map(j => game.cards[j]);
  if (a.key !== b.key) {
    game.locked = true;
    game.missed = game.open.slice();
    rerender();
    announce('Kein Paar.');
    setTimeout(() => {
      if (ui.tools !== session || session.game !== game) return;
      game.open = []; game.missed = []; game.locked = false;
      rerender();
    }, reducedMotion.matches ? 600 : MEMORY_FLIP_BACK_MS);
    return;
  }
  game.matched.add(a.key);
  game.open = [];
  game.last = toolByKey.get(a.key);
  announce(`Paar gefunden: ${game.last.n}.`);
  if (game.matched.size === game.cards.length / 2) {
    const result = { moves: game.moves, durationSec: (Date.now() - game.startedAt) / 1000 };
    const prev = state.memory[session.set];
    game.result = { ...result, record: !!prev && isBetterMemoryScore(prev, result) };
    if (isBetterMemoryScore(prev, result)) { state.memory[session.set] = result; commit(); } else rerender();
    focus('h1');
    return;
  }
  rerender();
}

function MemoryGame(session) {
  const game = session.game;
  const pairs = game.cards.length / 2;
  const r = game.result;
  return html`<div class="stack gap-s">
    <div class="row between">
      <button class="btn ghost sm" @click=${() => setToolsMode(session, 'menu')}>← Werkzeuge</button>
      <span class="small muted num">${plural(game.moves, 'Zug', 'Züge')} · ${game.matched.size}/${pairs} Paare</span>
    </div>
    ${r ? html`<section class="panel verdict">
        <h1 class="stamp ok" tabindex="-1">Geschafft</h1>
        <div class="stack gap-s">
          <span class="muted num">${pairs} Paare in ${plural(r.moves, 'Zug', 'Zügen')} und ${formatDuration(r.durationSec)}.${r.record ? ' Neuer Bestwert!' : ''}</span>
          <div class="row"><button class="btn primary" @click=${() => setToolsMode(session, 'memory')}>Nochmal</button>
          <button class="btn" @click=${() => setToolsMode(session, 'name')}>Jetzt benennen üben</button></div>
        </div>
      </section>`
      : html`<h1 class="visually-hidden" tabindex="-1">Werkzeug-Memory, ${pairs} Paare</h1>`}
    <ul class="mem-grid">${game.cards.map((card, i) => {
      const tool = toolByKey.get(card.key);
      const matched = game.matched.has(card.key);
      const open = matched || game.open.includes(i);
      const label = open ? `${card.picture ? 'Bild' : 'Begriff'}: ${tool.n}${matched ? ', gefunden' : ''}` : `Verdeckte Karte ${i + 1}`;
      return html`<li><button class="mcard ${open ? 'open' : ''} ${matched ? 'done' : ''} ${game.missed.includes(i) ? 'miss' : ''}"
        aria-label=${label} aria-disabled=${ariaBool(matched)} @click=${() => flipMemoryCard(session, i)}>
        <span class="in"><span class="b" aria-hidden="true"><span>GA</span></span>
        <span class="f" aria-hidden="true">${open ? (card.picture ? ToolPicture(tool) : html`<span class="nm">${tool.n}</span>`) : nothing}</span></span>
      </button></li>`;
    })}</ul>
    ${game.last ? html`<div class="note"><strong>${game.last.n}:</strong> ${game.last.d}</div>` : nothing}
  </div>`;
}

function ToolQuiz(session) {
  const quiz = session.quiz;
  const pool = toolPool(session);
  const naming = session.mode === 'name';
  if (quiz.index >= quiz.items.length) {
    return html`<div class="stack gap-m w-xo"><section class="panel verdict">
      <div><h1 class="eyebrow" tabindex="-1">${naming ? 'Benennen' : 'Zeigen'}</h1>${Score(quiz.correct, quiz.items.length)}</div>
      <div class="row">
        <button class="btn primary" @click=${() => setToolsMode(session, session.mode)}>Nochmal</button>
        <button class="btn" @click=${() => setToolsMode(session, 'menu')}>Werkzeuge</button>
      </div>
    </section></div>`;
  }
  const tool = quiz.items[quiz.index];
  // Distractors from the same set; small sets borrow from all tools.
  quiz.options ??= shuffle([tool, ...shuffle((pool.length >= 4 ? pool : TOOLS).filter(t => t.k !== tool.k)).slice(0, 3)]);
  const answered = quiz.answer !== null;
  const cls = t => (!answered ? '' : t.k === tool.k ? 'right' : t.k === quiz.answer ? 'wrong' : '');
  const choose = t => () => {
    quiz.answer = t.k;
    if (t.k === tool.k) quiz.correct++;
    rerender();
    focus('#tq-next');
  };
  const next = () => {
    quiz.index++; quiz.answer = null; quiz.options = null;
    rerender();
    focus(quiz.index < quiz.items.length ? '#tq-text' : 'h1');
  };
  return html`<div class="stack gap-s w-xo">
    <h1 class="visually-hidden" tabindex="-1">${naming ? 'Benennen' : 'Zeigen'}, ${quiz.index + 1} von ${quiz.items.length}</h1>
    <div class="row between">
      <button class="btn ghost sm" @click=${() => setToolsMode(session, 'menu')}>← Werkzeuge</button>
      <span class="small muted num">${quiz.index + 1} / ${quiz.items.length} · ${quiz.correct} richtig</span>
    </div>
    <div class="progress" aria-hidden="true"><i style="width:${(100 * quiz.index) / quiz.items.length}%"></i></div>
    <article class="qcard stack gap-s">
      ${naming
        ? html`<p class="qtext m-0" id="tq-text" tabindex="-1">Wie heißt dieses Werkzeug?</p>
            <div class="bigpic" role="img" aria-label="Abbildung eines Werkzeugs">${ToolPicture(tool)}</div>
            <div class="pick">${quiz.options.map(t => html`<button class=${cls(t)} ?disabled=${answered} @click=${choose(t)}>${t.n}</button>`)}</div>`
        : html`<p class="qtext m-0" id="tq-text" tabindex="-1">Zeig auf: <strong>${tool.n}</strong></p>
            <div class="pick">${quiz.options.map((t, i) => html`<button class="pic ${cls(t)}" ?disabled=${answered} @click=${choose(t)}
              aria-label=${answered ? t.n : `Werkzeug ${i + 1}`}>${ToolPicture(t)}</button>`)}</div>`}
      <div role="status">${answered ? html`<div class="feedback ${quiz.answer === tool.k ? 'ok' : 'bad'}">${quiz.answer === tool.k ? 'Richtig.' : `Das war: ${tool.n}.`}</div>` : nothing}</div>
      ${answered ? html`<p class="small muted m-0">${tool.d}</p>
        <div class="qfoot"><span></span><button class="btn primary" id="tq-next" @click=${next}>Weiter</button></div>` : nothing}
    </article>
  </div>`;
}

// --- X/O quick quiz across all stations ---

function startXoQuiz() {
  // Only stations with both kinds of criteria make the question meaningful.
  const pool = D.stations
    .filter(s => s.criteria.some(c => c.mandatory) && s.criteria.some(c => !c.mandatory))
    .flatMap(station => station.criteria.map(criterion => ({ station, criterion })));
  ui.xo = { items: shuffle(pool).slice(0, XO_QUIZ_SIZE), index: 0, answer: null, correct: 0 };
  rerender();
  scrollToTop();
  focus('h1');
}

function XoQuiz(quiz) {
  if (quiz.index >= quiz.items.length) {
    return html`<div class="stack gap-m w-xo"><section class="panel verdict">
      <div><h1 class="eyebrow" tabindex="-1">Pflicht oder nicht?</h1>${Score(quiz.correct, quiz.items.length)}</div>
      <div class="row">
        <button class="btn primary" @click=${startXoQuiz}>Nochmal</button>
        <a class="btn" href="#prac">Alle Stationen</a>
      </div>
    </section></div>`;
  }
  const { station, criterion } = quiz.items[quiz.index];
  const answered = quiz.answer !== null;
  const correct = answered && quiz.answer === criterion.mandatory;
  const answer = value => () => {
    quiz.answer = value;
    if (value === criterion.mandatory) quiz.correct++;
    rerender();
    focus('#xo-next');
  };
  const end = () => {
    quiz.items = quiz.items.slice(0, quiz.index + (answered ? 1 : 0));
    quiz.index = quiz.items.length;
    rerender();
    focus('h1');
  };
  const next = () => {
    quiz.index++;
    quiz.answer = null;
    rerender();
    focus(quiz.index < quiz.items.length ? '#xo-text' : 'h1');
  };

  return html`<div class="stack gap-s w-xo">
    <h1 class="visually-hidden" tabindex="-1">Pflicht oder nicht, ${quiz.index + 1} von ${quiz.items.length}</h1>
    <div class="row between">
      <span class="small muted num">${quiz.index + 1} / ${quiz.items.length} · ${quiz.correct} richtig</span>
      <button class="btn ghost sm" @click=${end}>Beenden</button>
    </div>
    <div class="progress" aria-hidden="true"><i style="width:${(100 * quiz.index) / quiz.items.length}%"></i></div>
    <article class="qcard">
      <div class="qhead"><span class="qid">P ${station.id} · ${station.title}</span><span class="tag num">${station.required} von ${station.criteria.length}</span></div>
      <p class="qtext" id="xo-text" tabindex="-1">${criterion.text}</p>
      <div class="row">
        <button class="btn wide ${answered && criterion.mandatory ? 'correct' : ''}" ?disabled=${answered} @click=${answer(true)}>X · Pflicht</button>
        <button class="btn wide ${answered && !criterion.mandatory ? 'correct' : ''}" ?disabled=${answered} @click=${answer(false)}>O · weiteres Kriterium</button>
      </div>
      <div role="status">${answered ? html`<div class="feedback ${correct ? 'ok' : 'bad'}">${correct ? 'Richtig.' : 'Falsch.'} Das ist ${criterion.mandatory ? 'ein Pflichtkriterium (X)' : 'ein weiteres Kriterium (O)'}.</div>` : nothing}</div>
      ${answered ? html`<div class="qfoot"><span></span><button class="btn primary" id="xo-next" @click=${next}>Weiter</button></div>` : nothing}
    </article>
  </div>`;
}

// ---------- Catalog ----------

function CatalogView() {
  const f = ui.catalogFilter;
  const onlyOptions = { all: 'Alle Fragen', ...(catalog().hasChanges ? { changed: 'nur neu/geändert' } : {}), weak: 'nur meine Fehler' };
  if (!(f.only in onlyOptions)) f.only = 'all';
  const matches = catalog().questions.filter(q =>
    (!f.section || sectionOf(q.id) === f.section)
    && (f.only !== 'changed' || q.status)
    && (f.only !== 'weak' || isWeak(statOf(q)))
    && matchesSearch(q, f.term));
  const set = fn => () => { fn(); rerender(); };

  return html`<div class="stack gap-m w-wide">
    <div class="stack gap-s">
      <span class="eyebrow">Nachschlagen</span>
      <h1 class="h-page" tabindex="-1">Fragenkatalog mit Lösungen</h1>
      <p class="lead">${catalog().label}. Richtige Antworten sind mit X markiert.</p>
    </div>
    <input class="search" type="search" placeholder="Suchen, z. B. Hebekissen, 65°, Mastwurf" aria-label="Katalog durchsuchen"
      .value=${f.term} @input=${e => { f.term = e.target.value; rerender(); }}>
    <fieldset class="row gap-s">
      <legend class="visually-hidden">Lernabschnitt</legend>
      ${Choice({ name: 'cat-section', checked: !f.section, label: 'Alle LA', onChange: set(() => { f.section = 0; }) })}
      ${D.sections.map(s => Choice({ name: 'cat-section', checked: f.section === s.id, label: `LA ${s.id}`, title: s.title, onChange: set(() => { f.section = s.id; }) }))}
    </fieldset>
    <fieldset class="row gap-s">
      <legend class="visually-hidden">Filter</legend>
      ${Object.entries(onlyOptions).map(([key, label]) => Choice({ name: 'cat-only', checked: f.only === key, label, onChange: set(() => { f.only = key; }) }))}
    </fieldset>
    <section class="panel" aria-label="Suchergebnisse">
      <p class="small muted num m-0" role="status">${matches.length} Fragen</p>
      ${matches.length
        ? html`<ul class="cat-list">${matches.slice(0, CATALOG_RENDER_LIMIT).map(q => CatalogItem(q, { term: f.term, stat: statOf(q) }))}</ul>`
        : html`<p class="muted">Keine Treffer. Versuch einen kürzeren Suchbegriff.</p>`}
    </section>
  </div>`;
}

// ---------- Boot ----------

async function boot() {
  try {
    D = await loadData();
  } catch (err) {
    $app.replaceChildren();
    render(html`<div class="alert"><strong>Der Fragenkatalog konnte nicht geladen werden.</strong>
      <p class="m-0 small">Bitte Seite neu laden. (${err.message})</p></div>`, $app);
    throw err;
  }
  $app.replaceChildren(); // lit appends to existing content; drop the loading placeholder
  if (!D.catalogs[state.catalog]) state.catalog = Object.keys(D.catalogs)[0];
  const exam = state.activeExam;
  if (exam && !(D.catalogs[exam.catalog] && exam.ids.every(id => D.catalogs[exam.catalog].byId.has(id)))) {
    state.activeExam = null; // catalog changed since the exam started
  }
  if (state.activeExam && examRemainingSec(state.activeExam) <= 0) {
    ui.view = 'exam';
    finishExam({ timedOut: true });
    history.replaceState(history.state, '', '#exam');
  }
  // Thresholds already passed before a reload were announced last time.
  if (state.activeExam) {
    const left = examRemainingSec(state.activeExam);
    ui.examWarned = new Set(EXAM.warnAtSec.filter(sec => left <= sec));
  }

  onInstallChange(rerender);
  addEventListener('popstate', onPopState);
  addEventListener('storage', onStorage);
  document.addEventListener('click', onLinkClick);
  document.addEventListener('keydown', onKeyDown);
  historyIndex = history.state?.idx ?? 0;
  await handleRoute(historyIndex, { initial: true });
}

/** Another tab saved: adopt its state so two tabs never overwrite each other's exam. */
function onStorage(e) {
  if (e.key !== STORAGE_KEY || e.newValue === null) return;
  try {
    state = migrateState(JSON.parse(e.newValue));
  } catch {
    return;
  }
  rerender();
}

boot();
