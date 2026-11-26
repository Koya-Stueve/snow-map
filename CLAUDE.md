# Snow-Map – Lastenheft

Dieses Dokument beschreibt, **was** Snow-Map können soll, nicht **wie** es gebaut wird.
Technologie, Architektur und Reihenfolge der Umsetzung entscheidest du (Claude) selbst –
schlag sie vor, begründe sie kurz und stimm größere Entscheidungen mit mir ab.

## Idee

Eine interaktive Webkarte, die Wetterprognosen – zuerst Schnee – über Japans Bergen
visualisiert (Später auch Europa). Am Ende soll man daraus auch Videos für Social Media exportieren können,
ähnlich den Clips im Ordner `Inspo/` (im Projektordner).

Schau dir `Inspo/` zu Beginn an: Die Bilder und Clips zeigen den Look, den ich mag
(z. B. dunkles Relief, Schnee in Weiß, Ortslabels mit Schneehöhe, Statistik-Box, Quellenangabe).

## Zielgruppe

Zuerst ich selbst (Skilehrer, fahre oft in Japan – will schnell sehen, wo wann wie viel Schnee kommt).
Später: Social-Media-Publikum, das sich für Japan-Powder interessiert.

## Anforderungen

### Phase 1 – Interaktive 2D-Karte (aktueller Fokus)
- Karte von Japan mit Relief/Höhenschattierung, startet auf Hokkaido
- Schnee wird über dem Relief dargestellt (Schneehöhe und/oder Neuschnee)
- Ausgewählte Skigebiete/Orte als Labels mit aktuellem Wert in cm
  (z. B. Niseko, Rusutsu, Furano, Kamui, Asahidake, Hakuba, Nozawa Onsen, Myoko, Shiga Kogen, Zao)
- **Zeitsteuerung mit Play-Button** wie beim Regenradar in Wetter-Apps:
  - Zeitraum wählbar: nächste 12 h / 24 h / 48 h / 3–4 Tage (bzw. so weit die Daten reichen)
  - Abspielen läuft Schritt für Schritt durch (z. B. stündlich, je nach Datenlage)
  - Neuschnee kann über den gewählten Zeitraum **akkumuliert** angezeigt werden
  - Pause, Vor/Zurück, Zeitregler zum manuellen Scrubben
- Gut nutzbar am Desktop und am Handy
- Sichtbare Quellenangabe (Datenquelle, Modelllauf)

### Phase 2 – Weitere Layer
- Weitere Wettergrößen umschaltbar, z. B. Temperatur, Wind, Niederschlag, Wolken
- Neue Layer sollen sich ohne Umbau des Rests hinzufügen lassen

### Phase 3 – Video-Export (muss am Ende kommen, jetzt noch nicht bauen)
- Die abgespielte Zeitspanne als MP4 exportieren, in 9:16 (Reels/TikTok), optional 1:1 und 16:9
- Das Video soll genau so aussehen wie die Karte – nur in Videoformat mit Titel, Statistik und Quelle
- **3D-Gelände mit Kameraflügen** über die Berge für schönere Videos (siehe Inspo)
- Wichtig schon für Phase 1: Die Visualisierung so bauen, dass dieser Export später ohne
  großen Umbau möglich ist (gleicher Bildinhalt für denselben Zeitpunkt, unabhängig von Echtzeit)

### Später / Ideen (nicht verpflichtend)
- Automatisch erzeugte Clips nach jedem neuen Modelllauf, wenn viel Schnee kommt
- Satellitenbild als Basiskarte, Resort-Ranking, Saisonrückblick
- Andere Regionen (z. B. Korea)

## Rahmenbedingungen
- Möglichst kostenlose Datenquellen und Bibliotheken, die eine Nutzung (auch später öffentlich) erlauben
- Lizenzen und Quellenangaben einhalten; keine Daten von Websites scrapen, die das nicht erlauben
- Wenn Daten optisch verfeinert werden (z. B. Downscaling mit dem Höhenmodell), soll das ehrlich gekennzeichnet sein
- Entwicklung unter Windows (VS Code); wenn etwas unter Windows Probleme macht, sag es und schlag eine Lösung vor

## Arbeitsweise
- Erst kurz planen, dann in kleinen Schritten bauen – nach jedem Schritt soll etwas Lauffähiges da sein
- Mit Beispieldaten anfangen, wenn das schneller zu einem sichtbaren Ergebnis führt
- Erklärungen an mich auf Deutsch, Code und Kommentare auf Englisch
