# GA-Trainer

Kostenloser, inoffizieller Lerntrainer für die Grundausbildung im THW.

- **Prüfungsbogen** wie in der echten Prüfung: 40 Fragen, mindestens eine je Lernabschnitt, 30 Minuten, bestanden ab 32
- **Üben** mit sofortiger Rückmeldung, Fehlertraining und Statistik je Lernabschnitt
- **Praxisstationen** mit Bewertungskriterien (X = Pflicht, O = weiteres Kriterium), Selbstcheck und Prüfungsparcours
- **Werkzeug-Memory** für die Stationen P 6.1.1 bis 6.1.3
- **Katalog** mit Suche, umschaltbar zwischen Stand 2024 und Version 3.2 (2019)
- Läuft **offline** und lässt sich **als App** auf den Home-Bildschirm legen
- Kein Konto, kein Tracking: Der Lernstand bleibt im Browser; ein **Sicherungscode** überträgt ihn auf andere Geräte

## Veröffentlichen (einmalig)

1. **Settings → Pages → Build and deployment → Source: „GitHub Actions“** wählen.
2. Änderungen auf `main` bringen (Pull Request mergen). Der Workflow `Website veröffentlichen` testet und veröffentlicht automatisch.
3. Die Adresse steht danach unter **Settings → Pages**, üblicherweise `https://janheisig.github.io/ga-trainer/`.

GitHub Pages im kostenlosen Tarif gibt es nur für öffentliche Repositories.

**Vor dem Teilen:** Platzhalter in `impressum.html` und `datenschutz.html` ausfüllen und die gelben Entwurfs-Kästen entfernen.

## Anpassen

| Was | Wo |
|---|---|
| Unterstützen-Banner (Link, Text) | `config.js` – leer lassen = kein Banner |
| Fragen, Stationen | `data.json` |
| Werkzeuge und Abbildungen | `tools.js` (eigene Fotos: nach `wz/` legen, bei dem Werkzeug `img`, `w`, `h` ergänzen) |
| Farben, Layout | `styles.css` |

Neue Datei hinzugefügt? In `sw.js` unter `ASSETS` eintragen, sonst fehlt sie offline. Die Tests melden es.

## Lokal ausprobieren

```sh
npm start        # http://localhost:8000
npm test         # Prüfungslogik, Daten, Offline-Cache
```

## Aufbau

- `index.html` – Seitengerüst
- `app.js` – Oberfläche (lit-html), Navigation, Speicherung
- `core.js` – Prüfungsregeln, Lernstand, Sicherungscode (ohne Browser testbar)
- `tools.js` – Werkzeuge der Stationen 6.1.x
- `pwa.js`, `sw.js`, `manifest.webmanifest` – Offline-Betrieb und Installation
- `vendor/`, `fonts/` – lit-html und die Schrift Barlow, lokal ausgeliefert (keine externen Server)

## Inhalte und Rechte

Die Theoriefragen stammen aus dem Prüfungsfragen-Katalog des THW, die Bewertungskriterien aus den praktischen Prüfungsaufgaben. Das Projekt ist nicht vom THW herausgegeben. Fehler bitte als [Issue](https://github.com/janheisig/ga-trainer/issues) melden. Quellen und Lizenzen: `lizenzen.html`.
