const socket = io();

const joinPanel = document.getElementById("joinPanel");
const gamePanel = document.getElementById("gamePanel");
const nameInput = document.getElementById("nameInput");
const joinBtn = document.getElementById("joinBtn");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const meetingBtn = document.getElementById("meetingBtn");
const statusText = document.getElementById("statusText");
const roleText = document.getElementById("roleText");
const meetingText = document.getElementById("meetingText");
const radar = document.getElementById("radar");
const ctx = radar.getContext("2d");
const xRange = document.getElementById("xRange");
const yRange = document.getElementById("yRange");
const gpsBtn = document.getElementById("gpsBtn");
const simBtn = document.getElementById("simBtn");
const identifyBtn = document.getElementById("identifyBtn");
const suspectSelect = document.getElementById("suspectSelect");
const eliminateBtn = document.getElementById("eliminateBtn");
const targetSelect = document.getElementById("targetSelect");
const voteBtn = document.getElementById("voteBtn");
const voteSelect = document.getElementById("voteSelect");
const eventsList = document.getElementById("events");

let useSim = true;
let baseGeo = null;
let currentSnapshot = null;

function addEvent(text, level = "normal") {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  if (level === "alert") li.classList.add("alert");
  if (level === "good") li.classList.add("good");
  eventsList.prepend(li);
}

function meterToPx(m, roomSize) {
  return (m / roomSize) * radar.width;
}

function drawRadar(snapshot) {
  ctx.clearRect(0, 0, radar.width, radar.height);
  const center = radar.width / 2;

  ctx.strokeStyle = "rgba(110,219,210,0.25)";
  for (let r = 42; r <= center; r += 42) {
    ctx.beginPath();
    ctx.arc(center, center, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  const you = snapshot.you;
  for (const p of snapshot.players) {
    const x = meterToPx(p.x, snapshot.roomSize);
    const y = meterToPx(p.y, snapshot.roomSize);
    ctx.beginPath();
    ctx.arc(x, y, p.id === you?.id ? 8 : 6, 0, Math.PI * 2);

    const selfIsDemogorgon = p.id === you?.id && p.role === "demogorgon";
    if (selfIsDemogorgon) ctx.fillStyle = "#ef476f";
    else if (p.id === you?.id) ctx.fillStyle = "#00f5d4";
    else if (p.role === "unknown") ctx.fillStyle = "#ff9f1c";
    else if (p.caught) ctx.fillStyle = "#6c757d";
    else if (p.role === "demogorgon") ctx.fillStyle = "#ef476f";
    else ctx.fillStyle = "#90e0ef";

    ctx.fill();
  }
}

function fillSelect(selectEl, options) {
  selectEl.innerHTML = "";
  for (const item of options) {
    const opt = document.createElement("option");
    opt.value = item.value;
    opt.textContent = item.label;
    selectEl.appendChild(opt);
  }
}

function updateDropdowns(snapshot) {
  const youId = snapshot.you?.id;
  const aliveOthers = snapshot.players.filter((p) => p.id !== youId && !p.caught);

  fillSelect(
    suspectSelect,
    aliveOthers.map((p) => ({ value: p.id, label: p.name }))
  );

  fillSelect(
    targetSelect,
    aliveOthers.filter((p) => p.role !== "unknown").map((p) => ({ value: p.id, label: p.name }))
  );

  fillSelect(
    voteSelect,
    [{ value: "skip", label: "Skip" }, ...aliveOthers.map((p) => ({ value: p.id, label: p.name }))]
  );
}

function flashScreen() {
  document.body.animate([{ background: "#090f1f" }, { background: "#3f0000" }, { background: "#090f1f" }], { duration: 450 });
}

function beep() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  const audioCtx = new AudioCtx();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "square";
  osc.frequency.value = 780;
  gain.gain.value = 0.08;
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  setTimeout(() => {
    osc.stop();
    audioCtx.close();
  }, 200);
}

function triggerHaptics(intensity) {
  const pattern = intensity === "critical" ? [100, 50, 100, 50, 180] : intensity === "high" ? [90, 40, 90] : [70];
  if (navigator.vibrate) navigator.vibrate(pattern);
  flashScreen();
  beep();
}

function sendPosition(x, y) {
  socket.emit("position-update", { x, y });
}

function startGpsTracking() {
  if (!navigator.geolocation) {
    addEvent("Geolocation unavailable, use simulation mode.", "alert");
    return;
  }

  useSim = false;
  addEvent("GPS mode enabled.");

  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      if (!baseGeo) baseGeo = { latitude, longitude };

      const metersPerDegLat = 111_132;
      const metersPerDegLon = 111_320 * Math.cos((baseGeo.latitude * Math.PI) / 180);

      const dx = (longitude - baseGeo.longitude) * metersPerDegLon;
      const dy = (latitude - baseGeo.latitude) * metersPerDegLat;

      const x = Math.max(0, Math.min(50, 25 + dx));
      const y = Math.max(0, Math.min(50, 25 + dy));

      xRange.value = String(x);
      yRange.value = String(y);
      sendPosition(x, y);
    },
    () => addEvent("GPS permission denied. Falling back to simulation.", "alert"),
    { enableHighAccuracy: true, maximumAge: 1000 }
  );
}

function syncButtons(snapshot) {
  const you = snapshot.you;
  if (!you) return;

  const isHost = Boolean(you.host);
  startBtn.disabled = !isHost;
  resetBtn.disabled = !isHost;

  meetingBtn.disabled = snapshot.gameState !== "running" || you.caught || you.meetingUsed;
  eliminateBtn.disabled = snapshot.gameState !== "running" || you.role !== "demogorgon" || you.caught;
  voteBtn.disabled = snapshot.gameState !== "meeting" || you.caught;
}

joinBtn.onclick = () => {
  const name = nameInput.value.trim();
  socket.emit("join", { name }, (res) => {
    if (!res.ok) {
      addEvent(res.error, "alert");
      return;
    }

    joinPanel.classList.add("hidden");
    gamePanel.classList.remove("hidden");
    addEvent(`Joined lobby as ${name}.`, "good");
  });
};

startBtn.onclick = () => {
  socket.emit("start-game", {}, (res) => {
    if (!res.ok) addEvent(res.error, "alert");
  });
};

resetBtn.onclick = () => {
  socket.emit("reset-game", {}, (res) => {
    if (!res.ok) addEvent(res.error, "alert");
    else addEvent("Game reset to lobby.");
  });
};

meetingBtn.onclick = () => {
  socket.emit("call-meeting", {}, (res) => {
    if (!res.ok) addEvent(res.error, "alert");
  });
};

identifyBtn.onclick = () => {
  const suspectId = suspectSelect.value;
  socket.emit("identify-demogorgon", { suspectId }, (res) => {
    if (!res.ok) addEvent(res.error, "alert");
    else if (res.success) addEvent("Correct identification!", "good");
    else addEvent("Wrong identification.", "alert");
  });
};

eliminateBtn.onclick = () => {
  const targetId = targetSelect.value;
  socket.emit("eliminate", { targetId }, (res) => {
    if (!res.ok) addEvent(res.error, "alert");
    else addEvent("Elimination successful.", "good");
  });
};

voteBtn.onclick = () => {
  const targetId = voteSelect.value;
  socket.emit("vote", { targetId }, (res) => {
    if (!res.ok) addEvent(res.error, "alert");
    else addEvent(`Vote submitted: ${targetId === "skip" ? "Skip" : "Player"}`);
  });
};

simBtn.onclick = () => {
  useSim = true;
  addEvent("Simulation controls enabled.");
};

gpsBtn.onclick = startGpsTracking;

[xRange, yRange].forEach((el) => {
  el.addEventListener("input", () => {
    if (!useSim) return;
    sendPosition(Number(xRange.value), Number(yRange.value));
  });
});

socket.on("snapshot", (snapshot) => {
  currentSnapshot = snapshot;
  statusText.textContent = `State: ${snapshot.gameState} | Players: ${snapshot.playerCount}`;

  const you = snapshot.you;
  roleText.textContent = `Role: ${you?.role || "unassigned"}${you?.host ? " | Host" : ""}${you?.caught ? " | Eliminated" : ""}`;

  if (snapshot.gameState === "meeting" && snapshot.meetingEndsAt) {
    const left = Math.max(0, Math.ceil((snapshot.meetingEndsAt - Date.now()) / 1000));
    meetingText.textContent = `Meeting: ${snapshot.meetingReason} (${left}s)`;
  } else {
    meetingText.textContent = "";
  }

  drawRadar(snapshot);
  updateDropdowns(snapshot);
  syncButtons(snapshot);

  if (you) {
    xRange.value = String(you.x);
    yRange.value = String(you.y);
  }
});

setInterval(() => {
  if (!currentSnapshot || currentSnapshot.gameState !== "meeting" || !currentSnapshot.meetingEndsAt) return;
  const left = Math.max(0, Math.ceil((currentSnapshot.meetingEndsAt - Date.now()) / 1000));
  meetingText.textContent = `Meeting: ${currentSnapshot.meetingReason} (${left}s)`;
}, 500);

socket.on("game-started", () => addEvent("Match started.", "good"));
socket.on("meeting-started", ({ reason }) => addEvent(`Meeting started: ${reason}`, "alert"));
socket.on("player-eliminated", ({ playerName }) => addEvent(`${playerName} was eliminated.`, "alert"));
socket.on("player-ejected", ({ playerName, role }) => addEvent(`${playerName} ejected. Role: ${role}.`, "alert"));
socket.on("identification-failed", () => addEvent("Identification failed.", "alert"));
socket.on("system-message", (msg) => addEvent(msg, "alert"));

socket.on("proximity-alert", (payload) => {
  addEvent(`Demogorgon nearby! Distance ≈ ${payload.distance}m`, "alert");
  triggerHaptics(payload.intensity);
});

socket.on("game-ended", ({ winner, reason }) => {
  addEvent(`Game ended. Winner: ${winner}. ${reason}`, winner === "security" ? "good" : "alert");
});

socket.on("connect", () => {
  addEvent(`Connected to server: ${window.location.origin}`, "good");
});

socket.on("disconnect", (reason) => {
  addEvent(`Disconnected: ${reason}`, "alert");
});

socket.on("connect_error", (err) => {
  addEvent(`Connection error: ${err.message}`, "alert");
});
