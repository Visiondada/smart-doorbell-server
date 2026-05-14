// ==========================
// IMPORTS — declared once at the top
// ==========================
const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const http       = require("http");
const multer     = require("multer");
const { Server } = require("socket.io");

const sessionState          = require("./sessionStore");
const imageService          = require("./services/imageService");
const { startUdpRelay }     = require("./udpRelay");

// ==========================
// APP + HTTP SERVER
// ==========================
const app    = express();
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
// SOCKET.IO CONNECTION HANDLER
// ==========================
io.on("connection", (socket) => {
  console.log(
    "🔌 [Socket] connected",
    socket.id,
    "transport=", socket.conn.transport.name,
    "origin=",    socket.handshake.headers.origin
  );

  socket.conn.on("upgrade", (transport) => {
    console.log("🔼 [Socket] transport upgraded", socket.id, "=>", transport.name);
  });

  socket.on("disconnect", (reason) => {
    console.log("🔌 [Socket] disconnected", socket.id, "reason=", reason);
  });

  // Send current session state to newly connected client
  socket.emit("session-status", {
    active:    sessionState.active,
    status:    sessionState.status,
    startedAt: sessionState.startedAt,
  });

  // ── Audio relay events ──────────────────────────────────────────────────
  socket.on("audio:owner", (data) => {
    console.log("🎤 [Audio] owner received", { hasAudio: !!data?.audio, format: data?.format, from: socket.id });
    socket.broadcast.emit("audio:owner", data);
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
});

// ==========================
// REST ROUTES — Port 3000
// ==========================

// Health check
app.get("/", (req, res) => {
  res.send("Smart Doorbell Backend Running 🚀");
});

// ESP32 rings the bell
app.post("/ring", (req, res) => {
  console.log("🔔 [API] Doorbell Ring Received");

  sessionState.active    = true;
  sessionState.status    = "ringing";
  sessionState.startedAt = Date.now();

  io.emit("doorbell:ring", {
    success:   true,
    message:   "Doorbell Ring Received",
    active:    sessionState.active,
    status:    sessionState.status,
    startedAt: sessionState.startedAt,
  });

  res.json({ success: true, message: "Doorbell Ring Received" });
});

// App polls this every 2s
app.get("/session-status", (req, res) => {
  res.json({
    active:    sessionState.active,
    status:    sessionState.status,
    startedAt: sessionState.startedAt,
  });
});

// App accepts the call
app.post("/accept", (req, res) => {
  console.log("✅ [API] Owner Accepted Call");

  sessionState.status = "connected";

  io.emit("session-status", {
    active:    sessionState.active,
    status:    sessionState.status,
    startedAt: sessionState.startedAt,
  });

  res.json({ success: true, message: "Call Accepted" });
});

// App or ESP32 ends the call
app.post("/end", (req, res) => {
  console.log("❌ [API] Call Ended");

  sessionState.active    = false;
  sessionState.status    = "idle";
  sessionState.startedAt = null;

  // Reset UDP peer registry so the next call registers fresh IPs
  if (udpRelay) udpRelay.resetPeers();

  io.emit("session-status", {
    active:    sessionState.active,
    status:    sessionState.status,
    startedAt: sessionState.startedAt,
  });

  io.emit("call-ended", { success: true, message: "Call Ended" });

  res.json({ success: true, message: "Call Ended" });
});

// ESP32-CAM uploads a snapshot
app.post("/upload-image", upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No image file provided" });
    }

    console.log("📸 [API] Image upload received");
    console.log(`    File: ${req.file.originalname} | Size: ${req.file.size} bytes`);

    const result = imageService.saveImage(req.file.buffer, req.file.originalname);

    if (result.success) {
      io.emit("new-image", result);
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
    const result       = imageService.deleteImage(filename);

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
// Resets a ringing session that nobody answered within 60 seconds
// ==========================
setInterval(() => {
  if (sessionState.active && sessionState.status === "ringing") {
    const elapsed = Date.now() - sessionState.startedAt;
    if (elapsed > 60000) {
      console.log("⌛ [Session] No response — auto-closing session");

      sessionState.active    = false;
      sessionState.status    = "idle";
      sessionState.startedAt = null;

      if (udpRelay) udpRelay.resetPeers();

      io.emit("session-status", {
        active:    sessionState.active,
        status:    sessionState.status,
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

  // Start UDP audio relay on port 4000 after HTTP is ready
  udpRelay = startUdpRelay();
});
