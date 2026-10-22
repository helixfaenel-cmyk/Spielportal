import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { GameRoom } from "./backend/index.js";
import {
  clearSessionCookie,
  createSessionToken,
  GLOBAL_ROOM,
  jsonResponse,
  normalizePlayerName,
  readSession,
  sessionCookie,
} from "./functions/_shared/session.js";

const GAMES = ["tic-tac-toe", "battleship", "yatzy", "find-match", "memory"];
const AUTH_SECRET = process.env.AUTH_SECRET;
const INDEX_HTML = await readFile(new URL("./index.html", import.meta.url));

function createGameRoom() {
  const stored = new Map();
  const sockets = new Set();
  let room;
  let alarmTimer;
  const ctx = {
    blockConcurrencyWhile: (callback) => Promise.resolve().then(callback),
    storage: {
      get: async (key) => stored.get(key),
      put: async (key, value) => { stored.set(key, value); },
      setAlarm: async (timestamp) => {
        clearTimeout(alarmTimer);
        alarmTimer = setTimeout(() => {
          room.alarm().catch((error) => console.error("Game alarm failed:", error));
        }, Math.max(0, timestamp - Date.now()));
      },
      deleteAlarm: async () => {
        clearTimeout(alarmTimer);
        alarmTimer = undefined;
      },
    },
    getWebSockets: () => [...sockets],
    acceptWebSocket: (socket) => { sockets.add(socket); },
    removeWebSocket: (socket) => { sockets.delete(socket); },
  };
  room = new GameRoom(ctx);
  return room;
}

const rooms = new Map(GAMES.map((game) => [game, createGameRoom()]));

function sendJson(response, value, status = 200, headers = {}) {
  const result = jsonResponse(value, { status, headers });
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(JSON.stringify(value));
}

async function readJsonBody(request, response) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > 16_384) {
    sendJson(response, { error: "Anfrage ist zu groß." }, 413);
    return undefined;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) {
      sendJson(response, { error: "Anfrage ist zu groß." }, 413);
      return undefined;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJson(response, { error: "Ungültige Anfrage." }, 400);
    return undefined;
  }
}

function internalRoomRequest(game, endpoint, headers = {}, method = "GET") {
  return new Request(`https://game-room/api/room/${game}/${endpoint}`, { method, headers });
}

async function handleSelectPlayer(request, response) {
  if (typeof AUTH_SECRET !== "string" || AUTH_SECRET.length < 32) {
    sendJson(response, { error: "Der Spielserver ist noch nicht eingerichtet." }, 503);
    return;
  }
  const body = await readJsonBody(request, response);
  if (body === undefined) return;

  const account = body && ["sonni", "felix", "spectator"].includes(body.account) ? body.account : "";
  const botEnabled = account === "sonni" && body.bot === true;
  const name = account === "spectator" ? "Zuschauer" : normalizePlayerName(body && body.name);
  if (!account) {
    sendJson(response, { error: "Bitte Spieler 1, Spieler 2 oder Zuschauer auswählen." }, 400);
    return;
  }
  if (!name) {
    sendJson(response, { error: "Der Name muss 1 bis 24 Zeichen lang sein." }, 400);
    return;
  }

  try {
    const status = await rooms.get(GAMES[0]).fetch(internalRoomRequest(GAMES[0], "status"));
    if (account === "spectator" && !status.ok) {
      sendJson(response, { error: "Es gibt noch keine Partie. Warte, bis ein Spieler einen Platz auswählt." }, 404);
      return;
    }

    if (account !== "spectator") {
      const claims = await Promise.all(GAMES.map((game) => rooms.get(game).fetch(
        internalRoomRequest(game, "claim", {
          "X-Spielportal-Player": account,
          "X-Spielportal-Name": name,
          "X-Spielportal-Bot": String(botEnabled),
        }, "POST"),
      )));
      if (claims.some((claim) => claim.status === 409)) {
        sendJson(response, { error: "Dieser Spielerplatz ist bereits vergeben." }, 409);
        return;
      }
      if (claims.some((claim) => !claim.ok)) {
        console.error("Could not claim player slot in every global game room:", account);
        sendJson(response, { error: "Der Spielerplatz konnte nicht für alle Spiele freigeschaltet werden." }, 503);
        return;
      }
    }

    const token = await createSessionToken(account, GLOBAL_ROOM, name, AUTH_SECRET);
    sendJson(response, { account, name }, 200, { "Set-Cookie": sessionCookie(token) });
  } catch (error) {
    console.error("Could not select player role:", error);
    sendJson(response, { error: "Die Spielauswahl konnte nicht gespeichert werden." }, 500);
  }
}

async function handleScoreboard(request, response) {
  if (typeof AUTH_SECRET !== "string" || AUTH_SECRET.length < 32) {
    sendJson(response, { error: "Der Spielserver ist noch nicht eingerichtet." }, 503);
    return;
  }
  const session = await readSession(new Request("https://spielportal/api/scoreboard", {
    headers: { Cookie: request.headers.cookie || "" },
  }), AUTH_SECRET);
  if (!session) {
    sendJson(response, { error: "Bitte erst einem Spielraum beitreten." }, 401);
    return;
  }

  const results = await Promise.all(GAMES.map(async (game) => {
    const result = await rooms.get(game).fetch(internalRoomRequest(game, "scoreboard", {
      "X-Spielportal-Player": session.account,
    }));
    return result.ok ? result.json() : null;
  }));
  if (results.some((result) => result === null)) {
    sendJson(response, { error: "Scoreboard konnte nicht geladen werden." }, 503);
    return;
  }

  const wins = { sonni: 0, felix: 0 };
  for (const result of results) {
    wins.sonni += result.wins.sonni;
    wins.felix += result.wins.felix;
  }
  sendJson(response, { wins, playerNames: results[0].playerNames });
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(INDEX_HTML);
    return;
  }

  if (url.pathname === "/api/session" && request.method === "GET") {
    if (typeof AUTH_SECRET !== "string" || AUTH_SECRET.length < 32) {
      sendJson(response, { error: "Der Spielserver ist noch nicht eingerichtet." }, 503);
      return;
    }
    const session = await readSession(new Request("https://spielportal/api/session", {
      headers: { Cookie: request.headers.cookie || "" },
    }), AUTH_SECRET);
    sendJson(response, { account: session?.account || null, name: session?.name || null });
    return;
  }
  if (url.pathname === "/api/players/select" && request.method === "POST") {
    await handleSelectPlayer(request, response);
    return;
  }
  if (url.pathname === "/api/logout" && request.method === "POST") {
    sendJson(response, {}, 200, { "Set-Cookie": clearSessionCookie() });
    return;
  }
  if (url.pathname === "/api/scoreboard" && request.method === "GET") {
    await handleScoreboard(request, response);
    return;
  }
  sendJson(response, { error: "Nicht gefunden." }, 404);
}

function handleUpgrade(request, socket, head) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const game = url.pathname.match(/^\/api\/room\/([^/]+)$/u)?.[1];
  const origin = request.headers.origin;
  const protocol = request.headers["x-forwarded-proto"] || "http";
  const expectedOrigin = `${protocol}://${request.headers.host}`;

  if (!GAMES.includes(game) || origin !== expectedOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (typeof AUTH_SECRET !== "string" || AUTH_SECRET.length < 32) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const sessionRequest = new Request(`https://${request.headers.host}${request.url}`, {
    headers: { Cookie: request.headers.cookie || "" },
  });
  readSession(sessionRequest, AUTH_SECRET).then((session) => {
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.serializeAttachment = (attachment) => { webSocket.attachment = attachment; };
      webSocket.deserializeAttachment = () => webSocket.attachment;
      const room = rooms.get(game);
      webSocket.on("message", (message) => {
        room.webSocketMessage(webSocket, message.toString())
          .catch((error) => {
            console.error("Game action failed:", error);
            webSocket.close(1011, "Game action failed");
          });
      });
      webSocket.on("close", () => {
        room.ctx.removeWebSocket(webSocket);
        room.webSocketClose();
      });
      webSocket.on("error", (error) => {
        console.error("Game WebSocket failed:", error);
        room.webSocketError();
      });
      room.connectSocket(session.account, game, webSocket).then((connected) => {
        if (!connected) webSocket.close(1008, "Game room is not available");
      }).catch((error) => {
        console.error("Could not connect game socket:", error);
        webSocket.close(1011, "Could not connect to game");
      });
    });
  }).catch((error) => {
    console.error("Could not validate game session:", error);
    socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error("Request failed:", error);
    if (!response.headersSent) sendJson(response, { error: "Interner Serverfehler." }, 500);
    else response.destroy(error);
  });
});
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16_384 });

server.on("upgrade", handleUpgrade);

const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => {
  console.log(`Spielportal listening on port ${port}`);
});
