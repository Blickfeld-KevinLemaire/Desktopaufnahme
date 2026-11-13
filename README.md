# Desktopaufnahme

Bildschirm-, Kamera- und Audio-Rekorder für Windows (Electron). Funktionsumfang und Aufbau der Oberfläche
orientieren sich an gängigen Aufnahmeprogrammen wie NCH Debut; Code, Gestaltung und Name sind eigenständig.

## Funktionen

| Bereich | Umfang |
|---|---|
| **Quellen** | Ganzer Bildschirm (auch mehrere Monitore), einzelnes Fenster, frei aufgezogener **Bereich**, **Webcam**, **Netzwerkkamera** (MJPEG/HTTP, auch mit `benutzer:passwort@`), **Videogerät** (Capture-Karte, Camcorder – alles, was Windows als Kamera anbietet) |
| **Audio** | Systemton („Ton vom Desktop“, Windows-Loopback) und/oder Mikrofon, getrennte Pegelregler, Aussteuerungsanzeige, beides wird gemischt |
| **Ausgabe** | Zielordner frei wählbar, Dateiname mit `{datum}`/`{zeit}`, Format MP4 (H.264) bzw. WebM (VP9/VP8), Qualität, Bildrate 10–60, Größe 25–100 % |
| **Steuerung** | Aufnehmen / Pause / Stopp, Countdown, Schnappschuss (PNG/JPG), globale Tastenkürzel, Fenster minimiert beim Start, Tray-Symbol |
| **Effekte** | Kameraüberlagerung (Position, Größe, rund/eckig, gespiegelt), Textlegende (mit `{datum}`/`{zeit}` live), Farbe (Helligkeit, Kontrast, Sättigung, Farbton, Farbüberlagerung), Filter (Graustufen, Sepia, Negativ, Weichzeichner, Verpixeln), Spiegeln (horizontal/vertikal), Wasserzeichen (Bild, Position, Größe, Deckkraft), Tastenanschläge einblenden, Hintergrund entfernen (Chroma-Key) – alles live in Vorschau **und** Aufnahme |
| **Zeitplan** | Einträge einmalig / täglich / wöchentlich mit Uhrzeit, Dauer, Quelle, eigenem Zielordner; optional Programm danach beenden. Unter Windows wird je Eintrag ein Task in der **Aufgabenplanung** angelegt, der das Programm zur Uhrzeit selbst startet (weckt den Rechner) |

## Starten

```bash
npm install
npm start
```

Windows-Installer bauen (läuft nur unter Windows, oder per GitHub Actions – siehe `.github/workflows/windows-build.yml`):

```bash
npm run dist
```

## Tests

`tools/test.js` startet die echte App und prüft Aufnahme (H.264-Datei, Auflösung, Tonspur), Pause, Schnappschuss, Zeitplan-Start/-Stopp,
Netzwerkkamera, Bereichsauswahl, Webcam, Mikrofon und die Dialoge. Unter Linux:

```bash
xvfb-run -a -s "-screen 0 1600x1000x24" npm test
```

(Playwright wird dafür separat benötigt: `PLAYWRIGHT_PATH=<Pfad zu playwright> …`.)

## Bekannte Grenzen

* **Nur unter Linux getestet, nicht unter Windows.** Systemton (Loopback), Aufgabenplanung-Selbststart, Autostart und der Installer-Build
  sind für Windows geschrieben, aber hier nicht ausgeführt worden.
* **Formate:** nur MP4 und WebM. AVI/WMV/MOV/MKV bräuchten einen mitgelieferten ffmpeg. Ob AAC-Ton im MP4 möglich ist, hängt vom System ab
  (sonst Opus im MP4). WebM-Dateien haben keine Dauerangabe im Header (Player spulen eingeschränkt).
* **Hintergrund entfernen** ist ein Chroma-Key (einfarbige Wand), keine KI-Personenfreistellung.
* **Netzwerkkamera:** HTTP-MJPEG-Streams/Standbilder; RTSP wird nicht unterstützt.
* **Tastenanschläge systemweit** brauchen das optionale Modul `uiohook-napi`; ohne es werden nur Tasten im eigenen Fenster erfasst.
* Die Bereichsauswahl und Fensteraufnahme folgen dem, was Windows der Bildschirmaufnahme-Schnittstelle liefert (z. B. keine geschützten DRM-Inhalte).

## Aufbau

```
src/main.js            Hauptprozess: Fenster, Menü, Tray, IPC, Dateien schreiben, Zeitplan, Aufgabenplanung
src/preload.js         sichere Brücke zur Oberfläche
src/region.*           Vollbild-Overlay zur Bereichsauswahl
src/renderer/          Oberfläche (index.html, styles.css, app.js)
  recorder.js          Aufnahme-Pipeline (Quelle → Canvas → MediaRecorder → Datei)
  effects.js           Effekte
tools/test.js          End-to-End-Test
```
