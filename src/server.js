// ==========================
// IMPORTS — declared once at the top
// ==========================
const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const multer = require("multer");
const { Server } = require("socket.io");

const sessionState = require("./sessionStore");
const imageService = require("./services/imageService");
const { startUdpRelay } = require("./udpRelay");

// ==========================
// DEVICE HEARTBEAT TRACKING
// Tracks last-seen timestamp for each hardware device
// ==========================
const deviceHeartbeat = {
  audio: null, // timestamp of last ping from Visions_AUDIO (null = never seen)
  cam: null, // timestamp of last ping from Visions_CAM  (null = never seen)
};
const DEVICE_ONLINE_THRESHOLD_MS = 20000; // device considered live if pinged within 20s

/**
 * 3-state device status:
 *   'live'    — pinged within DEVICE_ONLINE_THRESHOLD_MS
 *   'offline' — was seen before but went silent
 *   'never'   — null (never sent a single ping since server start)
 */
function getDeviceStatus(lastSeen) {
  if (lastSeen === null) return 'never';
  return (Date.now() - lastSeen) < DEVICE_ONLINE_THRESHOLD_MS ? 'live' : 'offline';
}

// Backward-compat helper — still used by a few places
function isDeviceOnline(lastSeen) {
  return getDeviceStatus(lastSeen) === 'live';
}

// ==========================
// APP + HTTP SERVER
// ==========================
const app = express();
const server = http.createServer(app);

// ==========================
// SOCKET.IO
// ==========================
const io = new Server(server, {
  path: "/socket.io",
  serveClient: false,
  cors: {
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    credentials: false,
  },
  transports: ["polling", "websocket"],
});

console.log("🔌 Socket.IO server initialized on shared HTTP server");

io.engine.on("connection_error", (err) => {
  console.error("⚠️  Socket.IO engine connection_error:", err?.message || err);
});

io.engine.on("headers", (headers, req) => {
  console.log("[Socket.IO] handshake headers", req.url, "origin=", req.headers.origin);
});

// ==========================
// MIDDLEWARE — cors called exactly once
// ==========================
app.use(cors({ origin: true, credentials: false }));
app.use(express.json());
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// ==========================
// MULTER — file upload
// ==========================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// ==========================
// UDP RELAY — declared here so /end route can call resetPeers()
// ==========================
let udpRelay = null;

// ==========================
// SESSION RESET HELPER
// Centralized function used by disconnect, timeout, /end, /end-call
// ==========================
function endCallSession(reason) {
  if (!sessionState.active && sessionState.status === "idle") return; // already idle

  console.log(`🔴 [Session] endCallSession called — reason: ${reason}`);

  sessionState.active = false;
  sessionState.status = "idle";
  sessionState.startedAt = null;

  if (udpRelay) udpRelay.resetPeers();

  io.emit("session-status", {
    active: false,
    status: "idle",
    startedAt: null,
    pollInterval: 5000,
  });
  io.emit("call:ended", { reason, message: "Session ended" });
  io.emit("call-ended", { reason, message: "Session ended" });
}

// ==========================
// SOCKET.IO CONNECTION HANDLER
// ==========================
io.on("connection", (socket) => {
  console.log(
    "🔌 [Socket] connected",
    socket.id,
    "transport=", socket.conn.transport.name,
    "origin=", socket.handshake.headers.origin
  );

  socket.conn.on("upgrade", (transport) => {
    console.log("🔼 [Socket] transport upgraded", socket.id, "=>", transport.name);
  });

  socket.on("disconnect", (reason) => {
    console.log("🔌 [Socket] disconnected", socket.id, "reason=", reason);

    // Auto-cleanup: if the session is active and NO other clients remain,
    // reset the session so the doorbell returns to READY on its OLED.
    // Give a 3-second grace period in case the app is just reconnecting.
    const connectedCount = io.sockets.sockets.size; // sockets still connected
    if (connectedCount === 0 && (sessionState.status === "ringing" || sessionState.status === "connected")) {
      console.log("⚠️  [Session] All clients disconnected with active session — waiting 3s for reconnect...");
      setTimeout(() => {
        // Re-check after grace period
        if (io.sockets.sockets.size === 0 && sessionState.active) {
          endCallSession("client_disconnect");
        }
      }, 3000);
    }
  });

  // Send current session state to newly connected client
  socket.emit("session-status", {
    active: sessionState.active,
    status: sessionState.status,
    startedAt: sessionState.startedAt,
    pollInterval: sessionState.status === "ringing" ? 1000 : 5000,
  });

  // ── Audio relay events ──────────────────────────────────────────────────
  socket.on("audio:owner", (data) => {
    console.log("🎤 [Audio] owner received", { hasAudio: !!data?.audio, format: data?.format, from: socket.id });

    // 1. Broadcast to other Socket.IO clients (e.g. a second phone)
    socket.broadcast.emit("audio:owner", data);

    // 2. Forward owner voice to ESP32 over UDP (Port 4000)
    if (udpRelay && data?.audio) {
      udpRelay.sendToEsp32(data.audio);
    }
  });

  socket.on("audio:owner:start", () => {
    console.log("🎙️  [Audio] owner started talking");
    socket.broadcast.emit("audio:owner:start");
  });

  socket.on("audio:owner:stop", () => {
    console.log("✋ [Audio] owner stopped talking");
    socket.broadcast.emit("audio:owner:stop");
  });

  socket.on("audio:visitor", (data) => {
    console.log("🎤 [Audio] visitor received", { hasAudio: !!data?.audio, format: data?.format, from: socket.id });
    socket.broadcast.emit("audio:visitor", data);
  });

  socket.on("audio:visitor:start", () => {
    console.log("🎙️  [Audio] visitor started talking");
    socket.broadcast.emit("audio:visitor:start");
  });

  socket.on("audio:visitor:stop", () => {
    console.log("✋ [Audio] visitor stopped talking");
    socket.broadcast.emit("audio:visitor:stop");
  });

  socket.on("audio-to-doorbell", (audioChunk) => {
    console.log("📡 [Audio] relay audio-to-doorbell");
    socket.broadcast.emit("audio-to-doorbell", audioChunk);
  });

  socket.on("audio-to-app", (audioChunk) => {
    console.log("📡 [Audio] relay audio-to-app");
    socket.broadcast.emit("audio-to-app", audioChunk);
  });

  // ── App UDP Handshake — sent when user presses Answer ──────────────────
  // Forwards HANDSHAKE_READY via UDP to ESP32 so it knows to start streaming
  socket.on("app:handshake", () => {
    console.log("🤝 [Handshake] App announced HANDSHAKE_READY → forwarding to ESP32 via UDP");
    if (udpRelay) {
      udpRelay.sendHandshakeReady();
    }
  });
});

// ==========================
// REST ROUTES — Port 3000
// ==========================

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Smart Doorbell Backend Running 🚀",
    ports: { http: 3000, udp: 4000 },
  });
});

// UDP relay status — useful for debugging
app.get("/udp-status", (req, res) => {
  const status = udpRelay ? udpRelay.getStatus() : { error: "UDP relay not started" };
  res.json(status);
});

// Direct latest image redirect — for Image component: /latest-image.jpg?t=...
// Returns 302 to the actual image file URL, or 404 if no images exist yet
app.get("/latest-image.jpg", (req, res) => {
  try {
    const images = imageService.getImages();
    if (!images || images.length === 0) {
      return res.status(404).json({ error: "No images available" });
    }
    const latest = images[0];
    const url = latest.url?.startsWith("http")
      ? latest.url
      : `http://54.237.213.192:3000${latest.url}`;
    // Cache-busting query param is ignored by the server — just redirect
    res.redirect(302, url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ESP32 rings the bell — STRICTLY only triggers for 'Visions_AUDIO' device
// Requests without deviceId or with any other deviceId are rejected.
app.post("/ring", (req, res) => {
  const deviceId = req.body?.deviceId || req.query?.deviceId || null;

  // ── Strict Device Identity Filter ──────────────────────────────────────
  // Only 'Visions_AUDIO' is authorised — no deviceId = rejected too.
  if (deviceId !== "Visions_AUDIO") {
    console.log(`⛔ [API] /ring blocked — deviceId='${deviceId}' (only Visions_AUDIO allowed)`);
    return res.status(403).json({ success: false, message: "Unauthorized device — only Visions_AUDIO may ring" });
  }

  // ── Global Heartbeat Stamp ─────────────────────────────────────────────
  // Any /ring from Visions_AUDIO is proof the device is live right now.
  // Stamp immediately so the UI shows 'live' without waiting for /status/audio.
  deviceHeartbeat.audio = Date.now();

  console.log(`🔔 [API] Doorbell Ring Received from ${deviceId}`);

  // ── FORCE-RESET: Always reset to ringing, regardless of previous state ──
  // This fixes the hardware-restart glitch where the popup wouldn't reappear
  // because the old session was stuck in a non-idle state.
  const prevStatus = sessionState.status;
  const ringId = Date.now(); // unique ID per ring — lets App detect fresh rings

  sessionState.active = true;
  sessionState.status = "ringing";
  sessionState.startedAt = ringId;

  console.log(`🔄 [Session] Force-reset: '${prevStatus}' → 'ringing' (ringId=${ringId})`);

  // Emit with a unique ringId so the App can always detect this as a NEW ring
  // even if it was already showing the modal (prevents stale-state glitch).
  io.emit("doorbell:ring", {
    success: true,
    message: "Doorbell Ring Received",
    active: true,
    status: "ringing",
    startedAt: ringId,
    ringId,            // ← unique per ring — App uses this to force-refresh modal
    deviceId,
  });

  res.json({ success: true, message: "Doorbell Ring Received", deviceId, ringId });
});

// App polls this every 2s — pollInterval tells the client how often to poll
// audioStatus / camStatus: 'live' | 'offline' | 'never'
// Raw timestamps also included so the App can compute its own threshold if needed.
app.get("/session-status", (req, res) => {
  const s = sessionState.status || "idle";
  res.json({
    active: sessionState.active,
    status: s,
    startedAt: sessionState.startedAt,
    pollInterval: s === "ringing" ? 1000 : 5000, // ms
    // 3-state device status for LED indicators
    audioStatus: getDeviceStatus(deviceHeartbeat.audio), // 'live'|'offline'|'never'
    camStatus: getDeviceStatus(deviceHeartbeat.cam),   // 'live'|'offline'|'never'
    // Raw timestamps — App may use for debugging
    audioLastSeen: deviceHeartbeat.audio,
    camLastSeen: deviceHeartbeat.cam,
    // Backward-compat booleans (kept so old code doesn't break)
    isAudioOnline: isDeviceOnline(deviceHeartbeat.audio),
    isCamOnline: isDeviceOnline(deviceHeartbeat.cam),
  });
});

// ── Hardware Heartbeat Routes ────────────────────────────────────────────────
// Supports both GET and POST so different ESP32 firmwares can use either method.

// Audio unit (Visions_AUDIO) heartbeat
function handleAudioHeartbeat(req, res) {
  deviceHeartbeat.audio = Date.now();
  const s = sessionState.status || "idle";
  const oledMessages = { idle: "READY", ringing: "CALLING...", connected: "CALL CONNECTED" };
  console.log("🔔 [Heartbeat] Audio device ping");
  res.json({
    status: s,
    active: sessionState.active,
    oledMessage: oledMessages[s] || "READY",
    startedAt: sessionState.startedAt,
    pollInterval: s === "ringing" ? 1000 : 5000,
    online: true,
    serverTime: Date.now(),
  });
}
app.get("/status/audio", handleAudioHeartbeat);
app.post("/status/audio", handleAudioHeartbeat);

// Camera unit (Visions_CAM) heartbeat
function handleCamHeartbeat(req, res) {
  deviceHeartbeat.cam = Date.now();
  const s = sessionState.status || "idle";
  console.log("📷 [Heartbeat] Camera device ping");
  res.json({
    status: s,
    active: sessionState.active,
    startedAt: sessionState.startedAt,
    online: true,
    serverTime: Date.now(),
  });
}
app.get("/status/cam", handleCamHeartbeat);
app.post("/status/cam", handleCamHeartbeat);

// Hardware /status — ESP32 polls this to update its OLED display
app.get("/status", (req, res) => {
  const oledMessages = {
    idle: "READY",
    ringing: "CALLING...",
    connected: "CALL CONNECTED",
  };
  const s = sessionState.status || "idle";
  res.json({
    status: s,
    active: sessionState.active,
    oledMessage: oledMessages[s] || "READY",
    startedAt: sessionState.startedAt,
    pollInterval: s === "ringing" ? 1000 : 5000, // ms — hardware adapts its poll rate
  });
});

// App accepts the call (existing route — kept for backward compat)
app.post("/accept", (req, res) => {
  console.log("✅ [API] Owner Accepted Call (/accept)");

  sessionState.status = "connected";

  io.emit("session-status", {
    active: sessionState.active,
    status: sessionState.status,
    startedAt: sessionState.startedAt,
  });

  res.json({ success: true, message: "Call Accepted" });
});

// App answers the call — full handshake with hardware OLED signal
app.post("/answer-call", (req, res) => {
  console.log("📞 [API] Answer-Call received — handshaking with hardware");

  sessionState.active = true;
  sessionState.status = "connected";
  // Keep startedAt from ring event, don't reset it

  // Notify all Socket.IO clients (app + any monitors)
  io.emit("session-status", {
    active: sessionState.active,
    status: sessionState.status,
    startedAt: sessionState.startedAt,
  });

  // Dedicated event — ESP32 polls /session-status and sees 'connected'
  // Hardware OLED will show CALL CONNECTED when it next polls
  io.emit("call:connected", {
    message: "CALL CONNECTED",
    timestamp: Date.now(),
  });

  res.json({
    success: true,
    message: "Call Connected",
    status: sessionState.status,
    timestamp: Date.now(),
  });
});

// App or ESP32 ends the call
app.post("/end", (req, res) => {
  console.log("❌ [API] Call Ended (/end)");

  sessionState.active = false;
  sessionState.status = "idle";
  sessionState.startedAt = null;

  if (udpRelay) udpRelay.resetPeers();

  io.emit("session-status", {
    active: sessionState.active,
    status: sessionState.status,
    startedAt: sessionState.startedAt,
  });

  io.emit("call-ended", { success: true, message: "Call Ended" });
  io.emit("call:ended", { success: true, message: "Call Ended" });

  res.json({ success: true, message: "Call Ended" });
});

// App hang-up button — same logic, separate named route
app.post("/end-call", (req, res) => {
  console.log("📵 [API] End-Call received from app");

  sessionState.active = false;
  sessionState.status = "idle";
  sessionState.startedAt = null;

  if (udpRelay) udpRelay.resetPeers();

  io.emit("session-status", {
    active: sessionState.active,
    status: sessionState.status,
    startedAt: sessionState.startedAt,
  });

  // Both event names for backward compat
  io.emit("call-ended", { success: true, message: "Call Ended" });
  io.emit("call:ended", { success: true, message: "Call Ended" });

  res.json({ success: true, message: "Call Ended", status: "idle" });
});

// ESP32-CAM uploads a snapshot
// NOTE: Image upload does NOT trigger doorbell:ring — it only updates the camera feed.
//       We do stamp deviceHeartbeat.cam immediately so the UI shows 'live' without
//       waiting for a separate /status/cam ping from the camera firmware.
app.post("/upload-image", upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No image file provided" });
    }

    // ── Global Heartbeat Stamp ───────────────────────────────────────────
    // Any image upload is proof Visions_CAM is alive right now.
    deviceHeartbeat.cam = Date.now();

    console.log("📸 [API] Image upload received — cam heartbeat stamped");
    console.log(`    File: ${req.file.originalname} | Size: ${req.file.size} bytes`);

    const result = imageService.saveImage(req.file.buffer, req.file.originalname);

    if (result.success) {
      io.emit("new-image", result); // ← only new-image, never doorbell:ring
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error("❌ [API] Upload error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// App fetches visitor images
app.get("/get-images", (req, res) => {
  try {
    const images = imageService.getImages();
    res.json({ success: true, count: images.length, images });
  } catch (error) {
    console.error("❌ [API] Error fetching images:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// App deletes an image
app.delete("/delete-image/:filename", (req, res) => {
  try {
    const { filename } = req.params;
    const result = imageService.deleteImage(filename);

    if (result.success) {
      io.emit("image-deleted", { filename });
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error("❌ [API] Error deleting image:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================
// SESSION AUTO-TIMEOUT
// Resets a ringing session that nobody answered within 30 seconds
// Emits call:ended so the App auto-navigates back and OLED resets to READY
// ==========================
setInterval(() => {
  if (sessionState.active && sessionState.status === "ringing") {
    const elapsed = Date.now() - sessionState.startedAt;
    if (elapsed > 30000) {  // 30 seconds
      console.log("⏳ [Session] 30s timeout — no answer, resetting to idle");

      sessionState.active = false;
      sessionState.status = "idle";
      sessionState.startedAt = null;

      if (udpRelay) udpRelay.resetPeers();

      // Notify app — triggers auto navigate-back on LiveCall screen
      io.emit("call:ended", { reason: "timeout", message: "No answer — session closed" });
      io.emit("call-ended", { reason: "timeout", message: "No answer — session closed" });
      io.emit("session-status", {
        active: sessionState.active,
        status: sessionState.status,
        startedAt: sessionState.startedAt,
      });
    }
  }
}, 5000);

// ==========================
// SERVER EVENTS
// ==========================
server.on("upgrade", (req, socket, head) => {
  console.log("⬆️  HTTP upgrade request", { url: req.url, origin: req.headers.origin });
});

server.on("error", (error) => {
  console.error("❌ Server error:", error);
});

// ==========================
// START — HTTP (Port 3000) + UDP (Port 4000)
// ==========================
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`🚀 HTTP server running on http://${HOST}:${PORT}`);
  console.log(`📡 Socket.IO path: /socket.io`);
  console.log(`🎯 Transports: polling, websocket`);

  // Start UDP audio relay on port 4000, passing `io` so it can emit to app clients
  udpRelay = startUdpRelay(io);
  console.log(`🔗 Bridge: App(Socket.IO:3000) ↔ Server ↔ ESP32(UDP:4000)`);
});
