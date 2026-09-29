// Prüft Daten und Dateien der Website: vollständiger Offline-Cache, gültige Fragen, keine externen Abhängigkeiten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS, TOOL_SETS } from '../tools.js';

const root = new URL('..', import.meta.url).pathname;
const read = p => readFileSync(join(root, p), 'utf8');
const data = JSON.parse(read('data.json'));

const IGNORE = new Set(['.git', '.github', 'tests', 'node_modules', 'README.md', 'CONTRIBUTING.md', '.nojekyll', 'package.json', '.gitignore']);
function siteFiles(dir = '') {
  return readdirSync(join(root, dir)).flatMap(name => {
    const rel = dir ? `${dir}/${name}` : name;
    if (IGNORE.has(rel) || IGNORE.has(name)) return [];
    if (statSync(join(root, rel)).isDirectory()) return siteFiles(rel);
    return name.endsWith('LICENSE') || name.endsWith('.txt') ? [] : [rel];
  });
}

test('der Service Worker cacht jede Datei der Website (sonst fehlt sie offline)', () => {
  const sw = read('sw.js');
  const listed = new Set([...sw.matchAll(/^\s+'([^']+)',$/gm)].map(m => m[1]));
  for (const file of siteFiles()) {
    if (file === 'sw.js') continue;
    assert.ok(listed.has(file), `${file} fehlt in ASSETS in sw.js`);
  }
  for (const file of listed) {
    if (file !== './') assert.ok(existsSync(join(root, file)), `${file} steht in sw.js, existiert aber nicht`);
  }
});

test('keine Einbindung externer Server (Datenschutz, Offline)', () => {
  for (const file of siteFiles().filter(f => /\.(html|css|js|webmanifest)$/.test(f))) {
    const text = read(file);
    for (const m of text.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)|url\(\s*["']?(https?:\/\/[^)"']+)|from\s+["'](https?:\/\/[^"']+)/g)) {
      const url = m[1] ?? m[2] ?? m[3];
      // Plain <a href> links are fine: nothing is loaded until someone clicks.
      const tagStart = text.lastIndexOf('<', m.index);
      const isPlainLink = m[1] !== undefined && /^<a\s/.test(text.slice(tagStart, tagStart + 3));
      assert.ok(isPlainLink, `${file} lädt ${url} von einem fremden Server`);
    }
  }
});

test('jede Theoriefrage hat 2–3 Antworten und mindestens eine richtige', () => {
  for (const [id, catalog] of Object.entries(data.catalogs)) {
    const seen = new Set();
    for (const q of catalog.questions) {
      assert.ok(!seen.has(q.id), `${id}: Frage ${q.id} doppelt`);
      seen.add(q.id);
      assert.ok(q.text.trim(), `${id} ${q.id}: Fragetext fehlt`);
      assert.ok(q.answers.length >= 2 && q.answers.length <= 3, `${id} ${q.id}: ${q.answers.length} Antworten`);
      assert.ok(q.correct.length >= 1, `${id} ${q.id}: keine richtige Antwort`);
      assert.ok(q.correct.every(i => i >= 0 && i < q.answers.length), `${id} ${q.id}: Lösung zeigt ins Leere`);
    }
  }
});

test('jede Station ist bestehbar: Pflichtkriterien ≤ geforderte Anzahl ≤ Kriterien', () => {
  for (const s of data.stations) {
    const mandatory = s.criteria.filter(c => c.mandatory).length;
    assert.ok(mandatory <= s.required && s.required <= s.criteria.length, `P ${s.id}: ${mandatory} X, ${s.required} von ${s.criteria.length}`);
  }
});

test('Werkzeuge: jede Station 6.1.x hat ihre Werkzeuge, jedes Werkzeug eine Abbildung', () => {
  assert.equal(TOOL_SETS['6.1.1'].tools.length, 8);
  assert.equal(TOOL_SETS['6.1.2'].tools.length, 9);
  assert.equal(TOOL_SETS['6.1.3'].tools.length, 5);
  for (const t of TOOLS) {
    assert.ok(t.svg?.startsWith('<svg') || (t.img && existsSync(join(root, t.img))), `${t.n}: keine Abbildung`);
    assert.ok(t.d.length > 20, `${t.n}: Beschreibung fehlt`);
  }
});
