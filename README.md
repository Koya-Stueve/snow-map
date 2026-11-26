# Snow-Map

Interaktive Karte für Schneeprognosen über Japans Bergen (Phase 1). Anforderungen: siehe `CLAUDE.md`.

## Starten

```sh
npm install
npm run fetch   # aktuelle Prognose holen (DWD ICON via Open-Meteo), ~9 min
npm run dev     # http://localhost:5173
```

Ohne `npm run fetch` zeigt die App synthetische Beispieldaten, deutlich als solche gekennzeichnet.

| Befehl | Zweck |
| --- | --- |
| `npm run fetch -- --dry-run` | nur Zellen und API-Budget berechnen |
| `npm run fetch -- --limit 300` | Testabruf mit wenigen Zellen |
| `npm run fetch -- --points-only` | nur die Resort-Punkte im aktuellen Lauf neu holen (10 Aufrufe) |
| `node scripts/inspect-data.ts` | Übersicht über die geladenen Daten |
| `node scripts/screenshot.mjs out.png [w] [h]` | Headless-Screenshot (Edge/Chrome), wartet auf die fertig geladene Karte |
| `npm run build` | Typprüfung + Produktions-Build |

## Daten und Lizenzen

- **Wetter:** [Open-Meteo.com](https://open-meteo.com/), Modell DWD ICON Global, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Der kostenlose Tarif ist **nur für nicht-kommerzielle Nutzung**: unter 10 000 Aufrufe am Tag und 5 000 pro Stunde.
  Ein Abruf kostet etwa 4 200 Aufrufe, wenn jeder Ort einzeln zählt.
  Für monetarisierte Nutzung braucht es ein Open-Meteo-Abo (`OPEN_METEO_API_KEY`).
- **Relief / Landmaske:** Mapzen Terrain Tiles (AWS Open Data), [Attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- **Basiskarte:** © OpenStreetMap-Mitwirkende, Kacheln von OpenFreeMap.

Alle Quellen stehen in der Quellenzeile der App. Verarbeitungsschritte (räumliche und zeitliche Interpolation) werden dort unter „interpoliert ⓘ“ erklärt.

## Aufbau

- `scripts/fetch-forecast.ts`: holt die Prognose nur für Landzellen in Japans Regionen (0,1°-Raster) und schreibt `public/data/<modell>/<lauf>/` mit `meta.json`, `cells.i32` und `<variable>.u16` (nicht im Git).
- `src/data/`: Datenformat, Loader, Raster (nur gespeicherte Zellen) und synthetische Daten.
- `src/layers/`: Wetter-Layer hinter einer gemeinsamen Schnittstelle (`WeatherLayer`). Neue Layer werden hier ergänzt.
- `src/time/`: `TimeController`. Alles Sichtbare hängt nur vom Zeitzustand ab, damit der spätere Video-Export Bild für Bild rendern kann.
- `src/render/`: Raster-Canvas (Mercator-korrekt), Farbskalen und Paletten, Label-Layout.
- `src/map/`, `src/ui/`: MapLibre-Stil und -Overlay sowie Bedienelemente.
