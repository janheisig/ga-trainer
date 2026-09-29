// Pure domain logic for the GA trainer. No DOM, no storage access, so it runs
// unchanged in the browser and under `node --test`.

export const EXAM = Object.freeze({
  questionCount: 40,
  passMark: 32,
  timeLimitSec: 30 * 60,
  targetSec: 10 * 60,
  lowTimeSec: 5 * 60,
  /** Remaining-time thresholds (seconds) that trigger a screen-reader announcement. */
  warnAtSec: [5 * 60, 60],
});

/** A question counts as mastered after this many correct answers in a row. */
export const MASTERY_STREAK = 2;
const MAX_STREAK = 5;
const MAX_EXAM_HISTORY = 60;

export const STORAGE_KEY = 'ga-trainer-v2';
export const LEGACY_STORAGE_KEY = 'ga-trainer-v1';
export const STATE_VERSION = 2;

// ---------- small helpers ----------

/** Fisher–Yates on a copy. `rng` is injectable for deterministic tests. */
export function shuffle(items, rng = Math.random) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** "3.12" -> 3 */
export const sectionOf = id => Number(id.split('.')[0]);

/** Numeric, segment-wise comparison: 1.2 < 1.10 < 2.1, 6.1.2 < 6.2.1 */
export function compareIds(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const identityOrder = question => question.answers.map((_, i) => i);

export function answerOrder(question, shuffleAnswers, rng = Math.random) {
  const order = identityOrder(question);
  return shuffleAnswers ? shuffle(order, rng) : order;
}

/**
 * Split `text` into plain and matching parts (case-insensitive), so the caller
 * can escape each part itself. Works on raw text, never on escaped HTML.
 */
export function splitMatches(text, term) {
  const needle = term.trim();
  if (!needle) return [{ text, match: false }];
  // Match on the original text: lowercasing first can change string length (e.g. "İ").
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const parts = [];
  let pos = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > pos) parts.push({ text: text.slice(pos, m.index), match: false });
    parts.push({ text: m[0], match: true });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), match: false });
  return parts;
}

export function matchesSearch(question, term) {
  const needle = term.trim().toLocaleLowerCase('de');
  if (!needle) return true;
  return [question.id, question.text, ...question.answers]
    .some(s => s.toLocaleLowerCase('de').includes(needle));
}

// ---------- answering & learning progress ----------

/** All correct answers ticked and nothing else. */
export function isCorrect(question, selected) {
  const chosen = new Set(selected);
  return chosen.size === question.correct.length && question.correct.every(i => chosen.has(i));
}

/** Returns the updated per-question stat; never mutates `prev`. */
export function recordAnswer(prev, correct, now = Date.now()) {
  const s = prev ?? { seen: 0, right: 0, wrong: 0, streak: 0 };
  return {
    seen: s.seen + 1,
    right: s.right + (correct ? 1 : 0),
    wrong: s.wrong + (correct ? 0 : 1),
    streak: correct ? Math.min(MAX_STREAK, s.streak + 1) : 0,
    lastCorrect: correct,
    at: now,
  };
}

export const isMastered = stat => !!stat && stat.lastCorrect === true && stat.streak >= MASTERY_STREAK;
export const isWeak = stat => !!stat && !isMastered(stat);

export const LEARN_MODES = Object.freeze({
  all: 'Alle Fragen',
  weak: 'Fehlertraining',
  unseen: 'Noch nicht gesehen',
  multi: 'Mehrfachantworten',
  changed: 'Neu/geändert seit 2019',
});

/** Questions for a practice round. Weak mode puts the shakiest questions first. */
export function learnPool(questions, statOf, { sections, mode }) {
  const inScope = questions.filter(q => sections.has(sectionOf(q.id)));
  switch (mode) {
    case 'weak':
      return inScope.filter(q => isWeak(statOf(q))).sort((a, b) => statOf(a).streak - statOf(b).streak);
    case 'unseen': return inScope.filter(q => !statOf(q));
    case 'multi': return inScope.filter(q => q.correct.length > 1);
    case 'changed': return inScope.filter(q => q.status);
    default: return inScope;
  }
}

export function sectionProgress(questions, statOf) {
  const bySection = new Map();
  for (const q of questions) {
    const id = sectionOf(q.id);
    const r = bySection.get(id) ?? { total: 0, seen: 0, mastered: 0, weak: 0 };
    const s = statOf(q);
    r.total++;
    if (s) r.seen++;
    if (isMastered(s)) r.mastered++;
    if (isWeak(s)) r.weak++;
    bySection.set(id, r);
  }
  return bySection;
}

// ---------- exam ----------

/**
 * One random question per section first (the exam guarantees coverage), then
 * random fill-up to EXAM.questionCount, presented in catalog order.
 * The result is plain JSON so a running exam survives a reload.
 */
export function createExam(questions, { catalog, shuffleAnswers = false, now = Date.now(), rng = Math.random }) {
  const bySection = Map.groupBy(questions, q => sectionOf(q.id));
  const picked = new Set([...bySection.values()].map(qs => shuffle(qs, rng)[0]));
  const rest = shuffle(questions.filter(q => !picked.has(q)), rng);
  for (const q of rest) {
    if (picked.size >= EXAM.questionCount) break;
    picked.add(q);
  }
  const list = [...picked].sort((a, b) => compareIds(a.id, b.id));
  return {
    catalog,
    ids: list.map(q => q.id),
    orders: list.map(q => answerOrder(q, shuffleAnswers, rng)),
    answers: list.map(() => []),
    flags: list.map(() => false),
    current: 0,
    startedAt: now,
    limitSec: EXAM.timeLimitSec,
  };
}

export const examElapsedSec = (exam, now = Date.now()) => Math.min(exam.limitSec, (now - exam.startedAt) / 1000);
export const examRemainingSec = (exam, now = Date.now()) => exam.limitSec - (now - exam.startedAt) / 1000;

export function scoreExam(exam, questionById, now = Date.now()) {
  const results = exam.ids.map((id, i) => isCorrect(questionById.get(id), exam.answers[i]));
  const score = results.filter(Boolean).length;
  return { results, score, passed: score >= EXAM.passMark, durationSec: examElapsedSec(exam, now) };
}

// ---------- practical stations ----------

/** Passed when every mandatory (X) criterion is known and at least `required` in total. */
export function evaluateStation(station, known) {
  const got = known.filter(v => v === true).length;
  const missingMandatory = station.criteria.filter((c, i) => c.mandatory && known[i] !== true).length;
  return { got, missingMandatory, passed: missingMandatory === 0 && got >= station.required };
}

// ---------- tool memory ----------

/** Two cards per tool (picture + name), shuffled. */
export function createMemoryDeck(tools, rng = Math.random) {
  return shuffle(tools.flatMap(tool => [{ key: tool.k, picture: true }, { key: tool.k, picture: false }]), rng);
}

/** Fewer moves wins; equal moves: faster wins. */
export function isBetterMemoryScore(prev, next) {
  return !prev || next.moves < prev.moves || (next.moves === prev.moves && next.durationSec < prev.durationSec);
}

// ---------- backup code (transfer progress without a server) ----------

export const BACKUP_PREFIX = 'GA1-';
const toSec = ms => Math.round((Number(ms) || 0) / 1000);
const fromSec = s => (Number(s) || 0) * 1000;

/** Compact, JSON-able snapshot of everything worth moving to another device. */
export function packProgress(s) {
  const stats = {};
  for (const [key, v] of Object.entries(s.stats ?? {})) {
    const [cat, id] = key.split(':');
    if (!cat || !id || !v) continue;
    (stats[cat] ??= []).push([id, v.seen, v.right, v.wrong, v.streak, v.lastCorrect ? 1 : 0, toSec(v.at)]);
  }
  return {
    v: 1,
    s: stats,
    e: (s.exams ?? []).map(e => [toSec(e.at), e.score, e.passed ? 1 : 0, Math.round(e.durationSec), e.catalog]),
    p: Object.entries(s.stations ?? {}).map(([id, r]) => [id, r.passed ? 1 : 0, r.got, toSec(r.at)]),
    m: Object.entries(s.memory ?? {}).map(([set, r]) => [set, r.moves, Math.round(r.durationSec)]),
  };
}

const int = v => (Number.isInteger(v) && v >= 0 ? v : null);

/** Inverse of packProgress. Drops every malformed row instead of failing. */
export function unpackProgress(o) {
  if (!isPlainObject(o) || o.v !== 1) throw new Error('unbekanntes Format');
  const stats = {};
  for (const [cat, rows] of Object.entries(isPlainObject(o.s) ? o.s : {})) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (!Array.isArray(r) || typeof r[0] !== 'string') continue;
      const [id, seen, right, wrong, streak, last, at] = r;
      if ([seen, right, wrong, streak].some(x => int(x) === null)) continue;
      stats[statKey(cat, id)] = { seen, right, wrong, streak: Math.min(streak, 5), lastCorrect: last === 1, at: fromSec(at) };
    }
  }
  const exams = (Array.isArray(o.e) ? o.e : [])
    .filter(r => Array.isArray(r) && typeof r[4] === 'string')
    .map(([at, score, passed, durationSec, catalog]) => ({ at: fromSec(at), score, passed: passed === 1, durationSec, catalog }))
    .filter(isValidExamEntry);
  const stations = {};
  for (const r of Array.isArray(o.p) ? o.p : []) {
    if (Array.isArray(r) && typeof r[0] === 'string' && int(r[2]) !== null) stations[r[0]] = { passed: r[1] === 1, got: r[2], at: fromSec(r[3]) };
  }
  const memory = {};
  for (const r of Array.isArray(o.m) ? o.m : []) {
    if (Array.isArray(r) && typeof r[0] === 'string' && int(r[1]) !== null && Number.isFinite(r[2])) memory[r[0]] = { moves: r[1], durationSec: r[2] };
  }
  return { stats, exams, stations, memory };
}

/**
 * Merge imported progress into the local state without losing anything:
 * per question and station the more recent entry wins, exam histories are
 * united, and each memory set keeps its better score. Settings and a running
 * exam stay local. Returns the new state plus what changed.
 */
export function mergeProgress(local, incoming) {
  const next = { ...local, stats: { ...local.stats }, stations: { ...local.stations }, memory: { ...(local.memory ?? {}) } };
  const changed = { questions: 0, exams: 0, stations: 0, memory: 0 };
  for (const [key, v] of Object.entries(incoming.stats)) {
    const cur = next.stats[key];
    if (!cur || v.at > cur.at || (v.at === cur.at && v.seen > cur.seen)) { next.stats[key] = v; changed.questions++; }
  }
  const known = new Set(local.exams.map(e => `${e.at}|${e.catalog}`));
  const extra = incoming.exams.filter(e => !known.has(`${e.at}|${e.catalog}`));
  changed.exams = extra.length;
  next.exams = [...local.exams, ...extra].sort((a, b) => a.at - b.at).slice(-MAX_EXAM_HISTORY);
  for (const [id, r] of Object.entries(incoming.stations)) {
    const cur = next.stations[id];
    if (!cur || r.at > cur.at) { next.stations[id] = r; changed.stations++; }
  }
  for (const [set, r] of Object.entries(incoming.memory)) {
    if (isBetterMemoryScore(next.memory[set], r)) { next.memory[set] = r; changed.memory++; }
  }
  return { state: next, changed };
}

const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Progress -> "GA1-…" (deflate + base64url). */
export async function encodeBackup(s) {
  const json = new TextEncoder().encode(JSON.stringify(packProgress(s)));
  const packed = await pipe(json, new CompressionStream('deflate-raw'));
  let b = '';
  for (let i = 0; i < packed.length; i += 0x8000) b += String.fromCharCode(...packed.subarray(i, i + 0x8000));
  return BACKUP_PREFIX + btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** "GA1-…" (whitespace and line breaks tolerated) -> unpacked progress. Throws on anything else. */
export async function decodeBackup(code) {
  const clean = String(code).replace(/\s+/g, '');
  if (!clean.startsWith(BACKUP_PREFIX)) throw new Error('Der Code muss mit GA1- beginnen.');
  const body = clean.slice(BACKUP_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('Der Code enthält ungültige Zeichen.');
  let json;
  try {
    json = new TextDecoder().decode(await pipe(unb64url(body), new DecompressionStream('deflate-raw')));
  } catch {
    throw new Error('Der Code ist unvollständig oder beschädigt.');
  }
  return unpackProgress(JSON.parse(json));
}

// ---------- persistence ----------

export function defaultState() {
  return { version: STATE_VERSION, catalog: '2024', shuffleAnswers: false, stats: {}, exams: [], stations: {}, memory: {}, activeExam: null };
}

export const statKey = (catalog, questionId) => `${catalog}:${questionId}`;

export function appendExamResult(history, entry) {
  return [...history, entry].slice(-MAX_EXAM_HISTORY);
}

const LEGACY_CATALOG = { 24: '2024', 19: '2019' };

/**
 * Accepts whatever was stored (current, legacy v1 or garbage) and returns a
 * valid current-version state. Unknown top-level fields are dropped; damaged
 * entries are discarded one by one so a single bad record can't lock the app.
 */
export function migrateState(raw) {
  const base = defaultState();
  if (!isPlainObject(raw)) return base;

  // Newer versions than we know are read as v2 on a best-effort basis rather than wiped.
  if (Number.isInteger(raw.version) && raw.version >= STATE_VERSION) {
    return {
      ...base,
      catalog: raw.catalog === '2019' ? '2019' : '2024',
      shuffleAnswers: !!raw.shuffleAnswers,
      stats: isPlainObject(raw.stats) ? raw.stats : {},
      exams: Array.isArray(raw.exams) ? raw.exams.filter(isValidExamEntry) : [],
      stations: isPlainObject(raw.stations) ? raw.stations : {},
      memory: isPlainObject(raw.memory) ? raw.memory : {},
      activeExam: isValidActiveExam(raw.activeExam) ? raw.activeExam : null,
    };
  }

  // v1: { cat:'24'|'19', q:{'24:1.1':{n,r,b,w,last,t}}, exams:[{d,score,pass,sec,cat}], p:{id:{pass,got,t}}, shuf }
  const stats = {};
  for (const [key, s] of Object.entries(isPlainObject(raw.q) ? raw.q : {})) {
    const [cat, id] = key.split(':');
    if (!LEGACY_CATALOG[cat] || !id || !s) continue;
    stats[statKey(LEGACY_CATALOG[cat], id)] = {
      seen: s.n ?? 0, right: s.r ?? 0, wrong: s.w ?? 0, streak: s.b ?? 0, lastCorrect: s.last === 1, at: s.t ?? 0,
    };
  }
  const exams = (Array.isArray(raw.exams) ? raw.exams : [])
    .filter(e => e && LEGACY_CATALOG[e.cat])
    .map(e => ({ at: e.d, score: e.score, passed: !!e.pass, durationSec: e.sec, catalog: LEGACY_CATALOG[e.cat] }))
    .filter(isValidExamEntry);
  const stations = {};
  for (const [id, r] of Object.entries(isPlainObject(raw.p) ? raw.p : {})) {
    if (r) stations[id] = { passed: !!r.pass, got: r.got ?? 0, at: r.t ?? 0 };
  }
  return {
    ...base,
    catalog: LEGACY_CATALOG[raw.cat] ?? '2024',
    shuffleAnswers: !!raw.shuf,
    stats, exams, stations,
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isValidExamEntry(e) {
  return isPlainObject(e) && Number.isFinite(e.at) && Number.isFinite(e.score) && Number.isFinite(e.durationSec);
}

function isValidActiveExam(x) {
  if (!isPlainObject(x) || !Array.isArray(x.ids) || !x.ids.length) return false;
  const n = x.ids.length;
  const sameLength = a => Array.isArray(a) && a.length === n;
  return sameLength(x.orders) && sameLength(x.answers) && sameLength(x.flags)
    && x.answers.every(Array.isArray) && x.orders.every(Array.isArray)
    && Number.isInteger(x.current) && x.current >= 0 && x.current < n
    && Number.isFinite(x.startedAt) && Number.isFinite(x.limitSec)
    && typeof x.catalog === 'string';
}
