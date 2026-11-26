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
- **Säulen-Ansicht** (`src/render/columns/`): Instancing mit ~85 000 Säulen, Farbe dunkelblau → weiß → pink.
  - Standard: deckend, Säulen erst ab 3 cm.
  - Schalter „Dichte“ (mehr Schnee = mehr Säulen) und „weicher Fuß“.
  - Den Glas-Effekt hat der Nutzer ausprobiert und verworfen.
- **Rendern:** `scripts/render-preview.mjs` rendert Bild für Bild auf der GPU, mit 2× Supersampling, 1080 × 1920, x264 CRF 16.
  - Der Zeitraffer gibt schneereichen Stunden mehr Bilder.
  - Optionen: `COLUMNS=1`, `DENSITY=1`, `COLFADE=1`, `LAYER=snow_depth`.

## Entscheidungen / Feedback des Nutzers

- **Optik ist wichtiger als exakte Daten.** Verfeinerungen müssen trotzdem ehrlich gekennzeichnet sein. Die Resort-Zahlen bleiben Modellwerte.
- **Videos:**
  - langsamer Zeitraffer, Schnee soll sich aufbauen und nicht plötzlich da sein
  - Kamera nah und tief, mehr Orte im Bild
  - Auflösung ist gut so
- **Säulen:** A (Schwelle) ist Standard, B (weicher Fuß) und C (Dichte) als Schalter.
- **GSI-Kacheln** wurden nur für einen lokalen Test massenhaft geladen. Der saubere Weg sind die 基盤地図情報-Downloads in `dem-src/`.
- **Nur lokal**, noch kein Hosting.

## Nächste Schritte (Vorschlag)

1. Am Desktop (RX 5700) Videos mit mehr Orten rendern, z. B. Niseko, Daisetsu und Tomamu, Fläche und Säulen.
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
3. Daten (nicht im Git) aus `snow-map-daten.zip` ins Repo-Verzeichnis entpacken:
   ```powershell
   tar -xf <pfad>\snow-map-daten.zip
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
