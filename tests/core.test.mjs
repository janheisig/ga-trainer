// Tests der Prüfungs- und Speicherlogik. Ausführen: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EXAM, isCorrect, recordAnswer, isMastered, createExam, scoreExam, evaluateStation, sectionOf,
  defaultState, migrateState, statKey, encodeBackup, decodeBackup, mergeProgress, isBetterMemoryScore,
} from '../core.js';

const data = JSON.parse(readFileSync(new URL('../data.json', import.meta.url)));
const questions = data.catalogs['2024'].questions;
const byId = new Map(questions.map(q => [q.id, q]));

test('eine Frage zählt nur, wenn genau alle richtigen Antworten angekreuzt sind', () => {
  const q = { correct: [0, 2] };
  assert.equal(isCorrect(q, [0, 2]), true);
  assert.equal(isCorrect(q, [2, 0]), true);
  assert.equal(isCorrect(q, [0]), false);
  assert.equal(isCorrect(q, [0, 1, 2]), false);
});

test('ein Prüfungsbogen hat 40 Fragen und deckt jeden Lernabschnitt ab', () => {
  for (let run = 0; run < 25; run++) {
    const exam = createExam(questions, { catalog: '2024' });
    assert.equal(exam.ids.length, EXAM.questionCount);
    assert.equal(new Set(exam.ids).size, EXAM.questionCount, 'keine Frage doppelt');
    const sections = new Set(exam.ids.map(sectionOf));
    for (const s of data.sections) assert.ok(sections.has(s.id), `LA ${s.id} fehlt`);
  }
});

test('bestanden ab 32 richtigen Fragen', () => {
  const exam = createExam(questions, { catalog: '2024' });
  exam.answers = exam.ids.map((id, i) => (i < 32 ? byId.get(id).correct : []));
  assert.equal(scoreExam(exam, byId).passed, true);
  exam.answers[0] = [];
  assert.equal(scoreExam(exam, byId).passed, false);
});

test('eine Station ist nur mit allen Pflichtkriterien bestanden', () => {
  const station = { required: 2, criteria: [{ mandatory: true }, { mandatory: false }, { mandatory: false }] };
  assert.equal(evaluateStation(station, [true, true, false]).passed, true);
  assert.equal(evaluateStation(station, [false, true, true]).passed, false);
  assert.equal(evaluateStation(station, [true, false, false]).passed, false);
});

test('eine Frage gilt nach zwei richtigen Antworten in Folge als sicher', () => {
  let s = recordAnswer(undefined, true, 1);
  assert.equal(isMastered(s), false);
  s = recordAnswer(s, true, 2);
  assert.equal(isMastered(s), true);
  s = recordAnswer(s, false, 3);
  assert.equal(isMastered(s), false);
});

test('alter Speicherstand (v1) wird übernommen', () => {
  const v1 = { cat: '24', q: { '24:1.1': { n: 3, r: 2, w: 1, b: 2, last: 1, t: 5 } }, exams: [{ d: 1, score: 33, pass: true, sec: 400, cat: '24' }], p: { '3.1': { pass: true, got: 3, t: 1 } } };
  const s = migrateState(v1);
  assert.equal(s.catalog, '2024');
  assert.deepEqual(s.stats[statKey('2024', '1.1')], { seen: 3, right: 2, wrong: 1, streak: 2, lastCorrect: true, at: 5 });
  assert.equal(s.exams.length, 1);
  assert.equal(s.stations['3.1'].passed, true);
});

test('Sicherungscode: hin und zurück, doppelt einfügen ändert nichts', async () => {
  const s = defaultState();
  s.stats[statKey('2024', '1.1')] = { seen: 2, right: 2, wrong: 0, streak: 2, lastCorrect: true, at: 1_700_000_000_000 };
  s.exams.push({ at: 1_700_000_000_000, score: 35, passed: true, durationSec: 420, catalog: '2024' });
  s.stations['3.1'] = { passed: true, got: 3, at: 1_700_000_000_000 };
  s.memory = { all: { moves: 12, durationSec: 60 } };
  const code = await encodeBackup(s);
  assert.match(code, /^GA1-[A-Za-z0-9_-]+$/);
  const incoming = await decodeBackup(code.replace(/(.{20})/g, '$1\n'));
  const once = mergeProgress(defaultState(), incoming);
  assert.deepEqual(once.changed, { questions: 1, exams: 1, stations: 1, memory: 1 });
  const twice = mergeProgress(once.state, incoming);
  assert.deepEqual(twice.changed, { questions: 0, exams: 0, stations: 0, memory: 0 });
});

test('Sicherungscode: kaputte Codes werden mit verständlicher Meldung abgelehnt', async () => {
  await assert.rejects(decodeBackup('hallo'), /GA1-/);
  await assert.rejects(decodeBackup('GA1-!!'), /ungültige Zeichen/);
  await assert.rejects(decodeBackup('GA1-abcd'), /unvollständig|beschädigt/);
});

test('Memory-Bestwert: weniger Züge gewinnen, bei Gleichstand die kürzere Zeit', () => {
  assert.equal(isBetterMemoryScore(undefined, { moves: 20, durationSec: 90 }), true);
  assert.equal(isBetterMemoryScore({ moves: 12, durationSec: 60 }, { moves: 11, durationSec: 99 }), true);
  assert.equal(isBetterMemoryScore({ moves: 12, durationSec: 60 }, { moves: 12, durationSec: 50 }), true);
  assert.equal(isBetterMemoryScore({ moves: 12, durationSec: 60 }, { moves: 13, durationSec: 10 }), false);
});
