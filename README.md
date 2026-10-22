# Spieleportal auf Render

Das Spieleportal läuft auf Render als einzelner Node.js-Webdienst. Er liefert die Webseite und API aus und stellt die WebSocket-Verbindungen für Multiplayer und Zuschauer bereit.

## Bereitstellung

1. Lade den gesamten Inhalt dieses Ordners in ein GitHub-Repository hoch. `render.yaml`, `package.json`, `server.js`, `index.html` und `backend` müssen im Repository-Hauptordner liegen.
2. Erstelle auf Render einen **Blueprint** und verbinde ihn mit dem Repository. Render liest `render.yaml` und richtet den Webdienst ein. Alternativ kannst du einen Web Service mit `npm install` als Build-Befehl und `npm start` als Start-Befehl anlegen.
3. `AUTH_SECRET` wird vom Blueprint zufällig erzeugt. Prüfe in Render unter **Environment**, dass dieses Secret gesetzt ist. Verwende mindestens 32 Zeichen und speichere es nicht im Repository.
4. Öffne die von Render angezeigte Webseite. Die Health-Check-Adresse `/healthz` wird vom Blueprint automatisch verwendet.

## Spielstände und Verfügbarkeit

Die Spiellogik und der Bot bleiben erhalten. Anders als Cloudflare Durable Objects speichert die Render-Variante Spielstände derzeit nur im Arbeitsspeicher. Ein Neustart oder erneutes Bereitstellen setzt aktive Partien und das Scoreboard zurück. Auch der kostenlose Render-Tarif kann den Dienst bei Inaktivität anhalten.

Verwende genau eine laufende Instanz des Dienstes: mehrere Instanzen hätten voneinander getrennte Spielräume. Für dauerhaft gespeicherte Spielstände wäre eine gemeinsame Datenbank erforderlich.

## Spielen

1. Für eine Partie allein **Allein gegen Bot** wählen und einen Namen eingeben.
2. Für ein Spiel zu zweit wählen beide dieselbe Webseite und jeweils **Spieler 1** oder **Spieler 2**.
3. Zuschauer wählen **Zuschauer** und können laufende Spiele ansehen.

Alle Besucher nutzen denselben gemeinsamen Spielbereich; Raumcodes oder Einladungen sind nicht erforderlich. Der Bot spielt Tic-Tac-Toe, Schiffe versenken, Yatzy, Find Match und Memory.

Für einen lokalen Test auf einem einzelnen Gerät kannst du `?test=local` an die Seitenadresse anhängen. Das ist kein Online-Multiplayer.
