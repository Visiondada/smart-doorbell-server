const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const http = require("http");
const { Server } = require("socket.io");

const sessionState = require("./sessionStore");
const imageService = require("./services/imageService");
const { startUdpRelay } = require("./udpRelay");

const app = express();
const server = http.createServer(app);

// ==========================
// SOCKET.IO INITIALIZATION
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
  console.error("⚠️ Socket.IO engine connection_error:", err?.message || err);
});

io.engine.on("headers", (headers, req) => {
  console.log("[Socket.IO] handshake headers", req.url, "origin=", req.headers.origin);
});

// ==========================
// MIDDLEWARE
// ==========================
app.use(cors({ origin: true, credentials: false }));
app.use(express.json());
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Static uploads
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// ==========================
// MULTER
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
// SOCKET.IO CONNECTION HANDLER
// ==========================
io.on("connection", (socket) => {
  console.log(
    "🔌 [Socket] connected",
    socket.id,
    "transport=",
    socket.conn.transport.name,
    "origin=",
    socket.handshake.headers.origin
  );

  socket.conn.on("upgrade", (transport) => {
    console.log(
      "🔼 [Socket] transport upgraded",
      socket.id,
      "=>",
      transport.name
    );
  });

  socket.on("disconnect", (reason) => {
    console.log("🔌 [Socket] disconnected", socket.id, "reason=", reason);
  });

  socket.emit("session-status", {
    active: sessionState.active,
    status: sessionState.status,
    startedAt: sessionState.startedAt,
  });

  socket.on("audio:owner", (data) => {
    console.log("🎤 [Audio] owner received", {
      hasAudio: !!data?.audio,
      format: data?.format,
      from: socket.id,
    });
    socket.broadcast.emit("audio:owner", data);
  });

  socket.on("audio:owner:start", () => {
    console.log("🎙️ [Audio] owner started talking");
    socket.broadcast.emit("audio:owner:start");
  });

  socket.on("audio:owner:stop", () => {
    console.log("✋ [Audio] owner stopped talking");
    socket.broadcast.emit("audio:owner:stop");
  });

  socket.on("audio:visitor", (data) => {
    console.log("🎤 [Audio] visitor received", {
      hasAudio: !!data?.audio,
      format: data?.format,
      from: socket.id,
    });
    socket.broadcast.emit("audio:visitor", data);
  });

  socket.on("audio:visitor:start", () => {
    console.log("🎙️ [Audio] visitor started talking");
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
// REST ROUTES
// ==========================
app.get("/", (req, res) => {
  res.send("Smart Doorbell Backend Running 🚀");
});

app.post("/ring", (req, res) => {
  console.log("🔔 [API] Doorbell Ring Received");

  sessionState.active = true;
  sessionState.status = "ringing";
  sessionState.startedAt = Date.now();

  io.emit("doorbell:ring", {
    success: true,
    message: "Doorbell Ring Received",
    active: sessionState.active,
    status: sessionState.status,
    startedAt: sessionState.startedAt,
  });

  res.json({
    success: true,
    message: "Doorbell Ring Received",
  });
});

app.get("/session-status", (req, res) => {
  res.json({
    active: sessionState.active,
    status: sessionState.status,
    startedAt: sessionState.startedAt,
  });
});

app.post("/accept", (req, res) => {
  console.log("✅ [API] Owner Accepted Call");

  sessionState.status = "connected";

  io.emit("session-status", {
    active: sessionState.active,
    status: sessionState.status,
    startedAt: sessionState.startedAt,
  });

  res.json({
    success: true,
    message: "Call Accepted",
  });
});

app.post("/end", (req, res) => {
  console.log("❌ [API] Call Ended");

  sessionState.active = false;
  sessionState.status = "idle";
  sessionState.startedAt = null;

  // Reset UDP peer registry so next call registers fresh IPs
  if (udpRelay) udpRelay.resetPeers();

  io.emit("session-status", {
    active: sessionState.active,
    status: sessionState.status,
    startedAt: sessionState.startedAt,
  });

  io.emit("call-ended", {
    success: true,
    message: "Call Ended",
  });

  res.json({
    success: true,
    message: "Call Ended",
  });
});

app.post("/upload-image", upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No image file provided",
      });
    }

    console.log("📸 [API] Image upload received from device");
    console.log(`    File: ${req.file.originalname}`);
    console.log(`    Size: ${req.file.size} bytes`);

    const result = imageService.saveImage(req.file.buffer, req.file.originalname);

    if (result.success) {
      io.emit("new-image", result);
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error("❌ [API] Upload error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/get-images", (req, res) => {
  try {
    const images = imageService.getImages();
    res.json({
      success: true,
      count: images.length,
      images,
    });
  } catch (error) {
    console.error("❌ [API] Error fetching images:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

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
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

setInterval(() => {
  if (sessionState.active && sessionState.status === "ringing") {
    const currentTime = Date.now();
    const diff = currentTime - sessionState.startedAt;

    if (diff > 60000) {
      console.log("⌛ [Session] No response. Session auto closed.");
      sessionState.active = false;
      sessionState.status = "idle";
      sessionState.startedAt = null;

      io.emit("session-status", {
        active: sessionState.active,
        status: sessionState.status,
        startedAt: sessionState.startedAt,
      });
    }
  }
}, 5000);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.on("upgrade", (req, socket, head) => {
  console.log("⬆️ HTTP upgrade request", { url: req.url, origin: req.headers.origin });
});

server.on("error", (error) => {
  console.error("❌ Server error:", error);
});

// ── Start UDP Audio Relay ──────────────────────────────────────────────────
let udpRelay = null;

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`📡 Socket.IO path: /socket.io`);
  console.log(`🎯 Socket.IO transports: polling, websocket`);

  // Start UDP relay after HTTP server is ready
  udpRelay = startUdpRelay();
});
