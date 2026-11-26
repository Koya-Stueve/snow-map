# Arbeitsstand & Übergabe

Stand: 26.11.2026. Diese Datei ist die Übergabe zwischen Rechnern bzw. Claude-Sitzungen. Bitte bei jedem größeren Schritt aktualisieren.

## Was steht

- **Karte:** MapLibre 6, 2D/3D-Gelände (Überhöhung 1,4), Himmel und Dunst, Kamera-Presets, dunkles und helles Theme.
- **Gelände:** `npm run build-terrain`
  - Niseko, Daisetsuzan und Tomamu aus 基盤地図情報 DEM5A (in `dem-src/`) bis z14, ganz Japan bis z9.
  - Ambient Occlusion vorberechnet. Der Ausgabeschritt läuft parallel auf allen Kernen.
- **Prognose:** `npm run fetch` holt DWD ICON von Open-Meteo, ~4 200 Aufrufe pro Lauf (Gratis-Tarif: 10 000 am Tag).
  - Variablen: Neuschnee, Schneehöhe, Nullgradgrenze, Wind in 850 hPa und Temperatur.
  - Resort-Punkte werden separat abgefragt und entsprechen exakt den Open-Meteo-Punktwerten.
- **Oberfläche:** Worker-Shader in `src/render/surface/` mit Licht, AO und Schnee pro Pixel, 512-px-Kacheln bei hoher Bildschirmauflösung und im Render-Modus.
  - Umschalter „optisch verfeinert“ für Schnee nach Höhe, Neigung, Leeseite und Schneefallgrenze (siehe README).
- **Layer:** Neuschnee (Summe/Stündlich) und Schneehöhe, umschaltbar in der Zeitleiste.
- **Säulen-Ansicht** (`src/render/columns/`): Instancing, Farbe dunkelblau → weiß → pink, deckend, Säulen erst ab 3 cm.
  - **Größe folgt dem Zoom:** Regler „Größe“ = Säulenabstand auf dem Bildschirm (Standard 35 px, ~600 m im nahen Daisetsu-Shot, ~3 km in der Übersicht). Jede Prognose-Zelle wird dafür in 1×1 bis 40×40 Säulen geteilt; feine Säulen nur um die Bildmitte (max. ~250 000), außen grob. Höhe schrumpft mit (Schalter „Höhe mit“).
  - Schalter „Dichte“ (mehr Schnee = mehr Säulen) und „weicher Fuß“, beide standardmäßig an.
  - Offen: Bei Kameraflügen mit Zoom springt die Säulengröße in Stufen (bei den jetzigen Videos mit festem Zoom kein Problem). Später überblenden.
  - Den Glas-Effekt hat der Nutzer ausprobiert und verworfen.
- **Rendern:** `scripts/render-preview.mjs` rendert Bild für Bild auf der GPU, mit 2× Supersampling, 1080 × 1920, x264 CRF 16.
  - Der Zeitraffer gibt schneereichen Stunden mehr Bilder.
  - Optionen: `COLUMNS=1`, `DENSITY=0`/`COLFADE=0` (aus), `COLSIZE=px`, `COLHEIGHT=0`, `LAYER=snow_depth`, `WORKERS=n`, für Standbilder `ZOOM`/`PITCH`/`BEARING` und `TAG` (Dateiname).
  - `WORKERS`: mehrere Browser rendern parallel (Standard 2, je ~1,3 GB RAM). Engpass ist nicht die GPU, sondern das Speichern der Screenshots (~2 s von ~2,8 s pro Bild).
  - Gemessen am Desktop (RX 5700, Ryzen 5 5600X, 16 GB), 2160 × 3840 intern:

    | WORKERS | s/Bild | Faktor |
    |---|---|---|
    | 1 | 2,84 | 1× |
    | 2 | 1,43 | 2,0× |
    | 3 | 1,22 | 2,3× (Desktop-Standard) |
    | 4 | 1,07 | 2,7×, aber nur noch 1,9 GB RAM frei |

    Ein 240-Bilder-Video dauert mit 3 Workern 3–4 min (Fläche und Säulen ähnlich). Laptop-Werte fehlen noch, bitte nachtragen.
- **Orte im Video:** Weitere Hokkaido-Spots mit niedriger Priorität (Hanazono, Annupuri, Moiwa, Kiroro, Kurodake, Sahoro). Sie füllen die nahen Shots und werden auf der Übersicht bei Kollisionen zuerst ausgeblendet. Der Tomamu-Shot schaut jetzt nach Nordosten, damit Sahoro mit im Bild ist.

## Entscheidungen / Feedback des Nutzers

- **Optik ist wichtiger als exakte Daten.** Verfeinerungen müssen trotzdem ehrlich gekennzeichnet sein. Die Resort-Zahlen bleiben Modellwerte.
- **Videos:**
  - langsamer Zeitraffer, Schnee soll sich aufbauen und nicht plötzlich da sein
  - Kamera nah und tief, mehr Orte im Bild
  - Auflösung ist gut so
- **Säulen:** Standard ist Schwelle + B (weicher Fuß) + C (Dichte), Größe 35 px mit mitschrumpfender Höhe (vom Nutzer am 26.11. aus Standbildern gewählt: s35 nah und fern). Die festen 2,4-km-Säulen waren im nahen Shot zu groß.
- **GSI-Kacheln** wurden nur für einen lokalen Test massenhaft geladen. Der saubere Weg sind die 基盤地図情報-Downloads in `dem-src/`.
- **Nur lokal**, noch kein Hosting.

## Nächste Schritte (Vorschlag)

1. ~~Videos mit mehr Orten rendern~~: erledigt am 26.11. (Lauf 12 UTC, alle 6 Videos). Feedback des Nutzers dazu abwarten.
2. Video-Overlay (Phase 3): großer Titel, Max-Zahl, Statistik-Box („≥ 30 cm auf X km²“), mehr Resort-Labels im Bild.
3. Rest von Phase 1:
   - Statistik-Box
   - Feinschliff fürs Handy, inklusive Test auf einem echten Gerät
   - Säulen ohne Dunst in der Ferne
   - Horizont im hellen Theme
4. Weitere Regionen: Hakuba, Nozawa, Myoko, Shiga Kogen und Zaō brauchen noch 基盤地図情報-Maschen (DEM5A) in `dem-src/`.

## Neuer Rechner einrichten (Windows)

1. Voraussetzungen installieren:
   ```powershell
   winget install --id Git.Git -e
   winget install --id OpenJS.NodeJS -e        # Node 24+ (TypeScript-Skripte laufen direkt)
   winget install --id Gyan.FFmpeg -e
   winget install --id GitHub.cli -e
   ```
   Danach das Terminal neu öffnen, damit die neuen Pfade gelten. Edge ist vorinstalliert, die Render-Skripte nutzen ihn.
2. Repo holen:
   ```powershell
   gh auth login --web --git-protocol https     # als Koya-Stueve
   cd C:\Users\<name>\dev
   gh repo clone Koya-Stueve/snow-map
   cd snow-map
   git config user.name "Koya-Stueve"; git config user.email "koyastueve@gmail.com"
   git config --add credential.helper ""; git config --add credential.helper "!'C:/Program Files/GitHub CLI/gh.exe' auth git-credential"
   npm install
   ```
3. Daten (nicht im Git) aus `snow-map-daten.zip` ins Repo-Verzeichnis entpacken. Das Zip liegt zum Übertragen in `snow-map-transfer/` (OneDrive; Ordner steht in `.gitignore`). Unter Git Bash kann `tar` keine Zips, deshalb in PowerShell `tar.exe` nutzen:
   ```powershell
   tar.exe -xf <pfad>\snow-map-daten.zip
   ```
   Das legt `terrain/`, `public/data/`, `dem-src/` und `.cache/gsi` an. Alternativ alles neu erzeugen: `npm run fetch` (~9 min) und `npm run build-terrain` (dauert lange, lädt GSI-Kacheln).
4. Starten und testen:
   ```powershell
   npm run dev
   # zweites Terminal:
   node scripts/render-preview.mjs still daisetsu
   node scripts/render-preview.mjs video daisetsu 240
   $env:COLUMNS=1; node scripts/render-preview.mjs video niseko 240
   ```
   Falls ffmpeg nicht im PATH ist: `$env:FFMPEG = "<pfad>\ffmpeg.exe"`.

## Hinweise zu Windows

- **PowerShell 5.1:** `Set-Content` ohne `-Encoding utf8` zerstört Umlaute und japanische Zeichen. Dateien besser mit dem Editor schreiben.
- **Commit-Nachrichten:** mit `git commit -F datei.txt` übergeben. Anführungszeichen in `-m @'…'@` haben schon einen Commit verhindert.
- **Speicher:** Lange Hintergrundjobs wurden auf dem Laptop (16 GB) wegen Speicherknappheit beendet. Beim Bauen Browser-Tabs schließen.
