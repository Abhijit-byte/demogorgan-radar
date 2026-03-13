const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROOM_SIZE_METERS = 50;
const ALERT_DISTANCE_METERS = 12;
const KILL_DISTANCE_METERS = 2.5;
const KILL_COOLDOWN_MS = 15_000;
const MEETING_DURATION_MS = 30_000;

const game = {
  state: "lobby", // lobby | running | meeting | ended
  meetingEndsAt: null,
  meetingReason: "",
};

/** @type {Map<string, {id:string,name:string,x:number,y:number,role:'security'|'demogorgon'|null,caught:boolean,host:boolean,lastSeen:number,lastKillAt:number,meetingUsed:boolean,vote:string|null}>} */
const players = new Map();
let meetingTimer = null;

const now = () => Date.now();

function randomChoice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function distanceMeters(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getDemogorgon() {
  return Array.from(players.values()).find((p) => p.role === "demogorgon" && !p.caught);
}

function getAliveSecurity() {
  return Array.from(players.values()).filter((p) => p.role === "security" && !p.caught);
}

function ensureHost() {
  if (players.size === 0) return;
  const hasHost = Array.from(players.values()).some((p) => p.host);
  if (!hasHost) {
    const first = players.values().next().value;
    first.host = true;
  }
}

function serializeForViewer(target, viewerId) {
  if (target.id === viewerId) {
    return {
      id: target.id,
      name: target.name,
      x: target.x,
      y: target.y,
      role: target.role,
      caught: target.caught,
      host: target.host,
      meetingUsed: target.meetingUsed,
      vote: target.vote,
      killCooldownMs: Math.max(0, KILL_COOLDOWN_MS - (now() - target.lastKillAt)),
    };
  }

  if (game.state === "running" && target.role === "demogorgon") {
    return {
      id: target.id,
      name: "Unknown Signal",
      x: target.x,
      y: target.y,
      role: "unknown",
      caught: false,
      host: target.host,
      meetingUsed: target.meetingUsed,
      vote: target.vote,
    };
  }

  return {
    id: target.id,
    name: target.name,
    x: target.x,
    y: target.y,
    role: target.role || "unknown",
    caught: target.caught,
    host: target.host,
    meetingUsed: target.meetingUsed,
    vote: target.vote,
  };
}

function buildSnapshot(viewerId) {
  const viewer = players.get(viewerId);
  return {
    gameState: game.state,
    meetingEndsAt: game.meetingEndsAt,
    meetingReason: game.meetingReason,
    roomSize: ROOM_SIZE_METERS,
    alertDistance: ALERT_DISTANCE_METERS,
    killDistance: KILL_DISTANCE_METERS,
    playerCount: players.size,
    you: viewer ? serializeForViewer(viewer, viewerId) : null,
    players: Array.from(players.values()).map((p) => serializeForViewer(p, viewerId)),
  };
}

function broadcastSnapshots() {
  for (const id of players.keys()) {
    io.to(id).emit("snapshot", buildSnapshot(id));
  }
}

function setGameEnded(winner, reason) {
  game.state = "ended";
  game.meetingEndsAt = null;
  game.meetingReason = "";
  if (meetingTimer) {
    clearTimeout(meetingTimer);
    meetingTimer = null;
  }
  io.emit("game-ended", { winner, reason });
}

function checkWinConditions() {
  if (game.state !== "running") return;
  const demogorgonAlive = Boolean(getDemogorgon());
  if (!demogorgonAlive) {
    setGameEnded("security", "Demogorgon was eliminated.");
    return;
  }

  if (getAliveSecurity().length === 0) {
    setGameEnded("demogorgon", "All security agents were eliminated.");
  }
}

function beginMeeting(reason) {
  game.state = "meeting";
  game.meetingReason = reason;
  game.meetingEndsAt = now() + MEETING_DURATION_MS;
  for (const p of players.values()) p.vote = null;

  if (meetingTimer) clearTimeout(meetingTimer);
  meetingTimer = setTimeout(resolveMeetingVotes, MEETING_DURATION_MS);
  io.emit("meeting-started", { reason, meetingEndsAt: game.meetingEndsAt });
  broadcastSnapshots();
}

function resolveMeetingVotes() {
  if (game.state !== "meeting") return;

  const tallies = new Map();
  let skipVotes = 0;
  const alivePlayers = Array.from(players.values()).filter((p) => !p.caught);

  for (const p of alivePlayers) {
    if (!p.vote || p.vote === "skip") {
      skipVotes += 1;
      continue;
    }
    tallies.set(p.vote, (tallies.get(p.vote) || 0) + 1);
  }

  let ejected = null;
  let topVotes = 0;
  let tie = false;
  for (const [candidateId, votes] of tallies.entries()) {
    if (votes > topVotes) {
      topVotes = votes;
      tie = false;
      ejected = players.get(candidateId) || null;
    } else if (votes === topVotes) {
      tie = true;
    }
  }

  game.state = "running";
  game.meetingEndsAt = null;
  game.meetingReason = "";

  if (!tie && ejected && topVotes > skipVotes && !ejected.caught) {
    ejected.caught = true;
    io.emit("player-ejected", { playerId: ejected.id, playerName: ejected.name, role: ejected.role });
  } else {
    io.emit("player-ejected", { playerId: null, playerName: "No one", role: "none" });
  }

  for (const p of players.values()) p.vote = null;
  checkWinConditions();
  broadcastSnapshots();
}

function assignRoles() {
  const all = Array.from(players.values());
  if (all.length < 3) return { ok: false, error: "Need at least 3 players." };

  const demogorgon = randomChoice(all);
  for (const p of all) {
    p.role = p.id === demogorgon.id ? "demogorgon" : "security";
    p.caught = false;
    p.vote = null;
    p.meetingUsed = false;
    p.lastKillAt = 0;
    p.x = ROOM_SIZE_METERS / 2;
    p.y = ROOM_SIZE_METERS / 2;
  }

  game.state = "running";
  game.meetingEndsAt = null;
  game.meetingReason = "";
  return { ok: true };
}

function resetGameToLobby() {
  game.state = "lobby";
  game.meetingEndsAt = null;
  game.meetingReason = "";
  if (meetingTimer) {
    clearTimeout(meetingTimer);
    meetingTimer = null;
  }

  for (const p of players.values()) {
    p.role = null;
    p.caught = false;
    p.vote = null;
    p.meetingUsed = false;
    p.lastKillAt = 0;
  }
}

function emitProximityAlerts() {
  if (game.state !== "running") return;
  const demogorgon = getDemogorgon();
  if (!demogorgon) return;

  for (const sec of getAliveSecurity()) {
    const d = distanceMeters(sec, demogorgon);
    if (d <= ALERT_DISTANCE_METERS) {
      io.to(sec.id).emit("proximity-alert", {
        distance: Number(d.toFixed(2)),
        intensity: d <= KILL_DISTANCE_METERS ? "critical" : d <= ALERT_DISTANCE_METERS / 2 ? "high" : "medium",
      });
    }
  }
}

io.on("connection", (socket) => {
  socket.on("join", ({ name }, cb = () => {}) => {
    const cleanName = String(name || "").trim().slice(0, 24);
    if (!cleanName) return cb({ ok: false, error: "Name is required." });

    players.set(socket.id, {
      id: socket.id,
      name: cleanName,
      x: ROOM_SIZE_METERS / 2,
      y: ROOM_SIZE_METERS / 2,
      role: null,
      caught: false,
      host: players.size === 0,
      lastSeen: now(),
      lastKillAt: 0,
      meetingUsed: false,
      vote: null,
    });

    cb({ ok: true, id: socket.id });
    ensureHost();
    broadcastSnapshots();
  });

  socket.on("start-game", (_, cb = () => {}) => {
    const p = players.get(socket.id);
    if (!p?.host) return cb({ ok: false, error: "Only host can start the game." });
    if (game.state === "running" || game.state === "meeting") return cb({ ok: false, error: "Game already in progress." });

    const result = assignRoles();
    cb(result);
    if (result.ok) io.emit("game-started");
    broadcastSnapshots();
  });

  socket.on("position-update", ({ x, y }) => {
    const p = players.get(socket.id);
    if (!p || p.caught) return;

    p.x = clamp(Number(x), 0, ROOM_SIZE_METERS);
    p.y = clamp(Number(y), 0, ROOM_SIZE_METERS);
    p.lastSeen = now();

    emitProximityAlerts();
    broadcastSnapshots();
  });

  socket.on("eliminate", ({ targetId }, cb = () => {}) => {
    const killer = players.get(socket.id);
    const target = players.get(targetId);
    if (game.state !== "running") return cb({ ok: false, error: "Game is not running." });
    if (!killer || killer.role !== "demogorgon" || killer.caught) return cb({ ok: false, error: "Only alive Demogorgon can eliminate." });
    if (!target || target.caught || target.role !== "security") return cb({ ok: false, error: "Invalid target." });

    const cooldownLeft = KILL_COOLDOWN_MS - (now() - killer.lastKillAt);
    if (cooldownLeft > 0) return cb({ ok: false, error: `Kill cooldown ${Math.ceil(cooldownLeft / 1000)}s remaining.` });

    const d = distanceMeters(killer, target);
    if (d > KILL_DISTANCE_METERS) return cb({ ok: false, error: `Target too far (${d.toFixed(1)}m).` });

    target.caught = true;
    killer.lastKillAt = now();
    io.emit("player-eliminated", { playerId: target.id, playerName: target.name });

    checkWinConditions();
    broadcastSnapshots();
    cb({ ok: true });
  });

  socket.on("call-meeting", (_, cb = () => {}) => {
    const caller = players.get(socket.id);
    if (game.state !== "running") return cb({ ok: false, error: "Meetings are only available while running." });
    if (!caller || caller.caught) return cb({ ok: false, error: "Only alive players can call meeting." });
    if (caller.meetingUsed) return cb({ ok: false, error: "You already used your emergency meeting." });

    caller.meetingUsed = true;
    beginMeeting(`${caller.name} called an emergency meeting.`);
    cb({ ok: true });
  });

  socket.on("vote", ({ targetId }, cb = () => {}) => {
    const voter = players.get(socket.id);
    if (game.state !== "meeting") return cb({ ok: false, error: "Voting is only possible in meetings." });
    if (!voter || voter.caught) return cb({ ok: false, error: "Caught players cannot vote." });

    const allowed = targetId === "skip" || (players.has(targetId) && !players.get(targetId).caught);
    if (!allowed) return cb({ ok: false, error: "Invalid vote target." });

    voter.vote = targetId;
    cb({ ok: true });
    broadcastSnapshots();

    const alive = Array.from(players.values()).filter((p) => !p.caught);
    const allVoted = alive.every((p) => p.vote);
    if (allVoted) {
      if (meetingTimer) {
        clearTimeout(meetingTimer);
        meetingTimer = null;
      }
      resolveMeetingVotes();
    }
  });

  socket.on("identify-demogorgon", ({ suspectId }, cb = () => {}) => {
    if (game.state !== "running") return cb({ ok: false, error: "Game is not running." });
    const demogorgon = getDemogorgon();
    if (!demogorgon) return cb({ ok: false, error: "Demogorgon not present." });

    if (suspectId === demogorgon.id) {
      demogorgon.caught = true;
      setGameEnded("security", "Security correctly identified the Demogorgon.");
      broadcastSnapshots();
      return cb({ ok: true, success: true });
    }

    io.to(socket.id).emit("identification-failed");
    cb({ ok: true, success: false });
  });

  socket.on("reset-game", (_, cb = () => {}) => {
    const p = players.get(socket.id);
    if (!p?.host) return cb({ ok: false, error: "Only host can reset." });
    resetGameToLobby();
    broadcastSnapshots();
    cb({ ok: true });
  });

  socket.on("disconnect", () => {
    const wasHost = players.get(socket.id)?.host;
    players.delete(socket.id);
    if (wasHost) ensureHost();

    if (players.size < 3 && (game.state === "running" || game.state === "meeting")) {
      resetGameToLobby();
      io.emit("system-message", "Not enough players. Returned to lobby.");
    }

    broadcastSnapshots();
  });
});

app.use(express.static(path.join(__dirname, "public")));

server.listen(PORT, () => {
  console.log(`Demogorgon Radar running on http://localhost:${PORT}`);
});
