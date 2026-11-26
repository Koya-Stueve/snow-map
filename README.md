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
| `npm run fetch -- --points-only` | nur die Resort-Punkte im aktuellen Lauf neu holen (11 Aufrufe) |
| `npm run build-terrain` | hochaufgelöstes Gelände + Ambient Occlusion bauen (siehe unten) |
| `npm run build-terrain -- --only tomamu --force` | eine Region neu bauen, z. B. nach neuen Daten in `dem-src/` |
| `npm run build-terrain -- --rewrite` | nur AO/WebP neu rechnen (alle Kerne, `--workers N` zum Begrenzen) |

## Gelände (`npm run build-terrain`)

- Quellen in dieser Reihenfolge:
  1. eigene 基盤地図情報-Downloads (数値標高モデル, JPGIS GML) in `dem-src/`, ZIPs dürfen verschachtelt sein. Bei 5 m gilt die Reihenfolge DEM5A (Laser) > 5B > 5C, danach 10 m.
  2. GSI-Höhenkacheln `dem_png`, langsam abgerufen und in `.cache/gsi/` zwischengespeichert. Das Herunterladen ist nur für lokale Tests mit dem Nutzer abgestimmt.
- Regionen bis z14 (~7 m/px): Niseko, Daisetsuzan, Tomamu. Ganz Japan bis z9.
- Ausgabe in `terrain/` (nicht im Git): Terrarium-WebP und Ambient Occlusion (Himmelssicht-Faktor). Der Dev-Server liefert sie unter `/terrain/` aus, `npm run build` kopiert sie nicht mit.
- Ausgabeschritt parallel auf allen Kernen (~0,09 s pro Kachel auf einem i7-1165G7). Ein unterbrochener Lauf setzt beim nächsten Start fort.
| `node scripts/inspect-data.ts` | Übersicht über die geladenen Daten |
| `node scripts/screenshot.mjs out.png [w] [h]` | Headless-Screenshot (Edge/Chrome), wartet auf die fertig geladene Karte |
| `npm run build` | Typprüfung + Produktions-Build |

## Daten und Lizenzen

- **Wetter:** [Open-Meteo.com](https://open-meteo.com/), Modell DWD ICON Global, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Der kostenlose Tarif ist **nur für nicht-kommerzielle Nutzung**: unter 10 000 Aufrufe am Tag und 5 000 pro Stunde.
  Ein Abruf kostet etwa 4 200 Aufrufe, wenn jeder Ort einzeln zählt.
  Für monetarisierte Nutzung braucht es ein Open-Meteo-Abo (`OPEN_METEO_API_KEY`).
- **Relief:** 国土地理院 標高タイル und 基盤地図情報 数値標高モデル ([PDL 1.0](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html)), bearbeitet. Daneben Mapzen Terrain Tiles (AWS Open Data) als Fallback und für die Landmaske des Wetterabrufs, [Attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- **Basiskarte:** © OpenStreetMap-Mitwirkende, Kacheln von OpenFreeMap.

Alle Quellen stehen in der Quellenzeile der App. Verarbeitungsschritte (räumliche und zeitliche Interpolation) werden dort unter „interpoliert ⓘ“ erklärt.

## Aufbau

- `scripts/fetch-forecast.ts`: holt die Prognose nur für Landzellen in Japans Regionen (0,1°-Raster) und schreibt `public/data/<modell>/<lauf>/` mit `meta.json`, `cells.i32` und `<variable>.u16` (nicht im Git).
- `src/data/`: Datenformat, Loader, Raster (nur gespeicherte Zellen) und synthetische Daten.
- `src/layers/`: Wetter-Layer hinter einer gemeinsamen Schnittstelle (`WeatherLayer`). Neue Layer werden hier ergänzt.
- `src/time/`: `TimeController`. Alles Sichtbare hängt nur vom Zeitzustand ab, damit der spätere Video-Export Bild für Bild rendern kann.
- `src/render/`: Raster-Canvas (Mercator-korrekt), Farbskalen und Paletten, Label-Layout.
- `src/map/`, `src/ui/`: MapLibre-Stil und -Overlay sowie Bedienelemente.
