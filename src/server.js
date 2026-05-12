const express = require("express");
const cors = require("cors");

const sessionState = require("./sessionStore");

const app = express();

app.use(cors());
app.use(express.json());

// ==========================
// ROOT
// ==========================

app.get("/", (req, res) => {
  res.send("Smart Doorbell Backend Running 🚀");
});

// ==========================
// RING API
// ==========================

app.post("/ring", (req, res) => {

  console.log("🔔 Doorbell Ring Received");

  sessionState.active = true;
  sessionState.status = "ringing";
  sessionState.startedAt = Date.now();

  res.json({
    success: true,
    message: "Doorbell Ring Received"
  });

});

// ==========================
// SESSION STATUS API
// ==========================

app.get("/session-status", (req, res) => {

  res.json({
    active: sessionState.active,
    status: sessionState.status,
    startedAt: sessionState.startedAt
  });

});

// ==========================
// ACCEPT CALL
// ==========================

app.post("/accept", (req, res) => {

  console.log("✅ Owner Accepted Call");

  sessionState.status = "connected";

  res.json({
    success: true,
    message: "Call Accepted"
  });

});

// ==========================
// END CALL
// ==========================

app.post("/end", (req, res) => {

  console.log("❌ Call Ended");

  sessionState.active = false;
  sessionState.status = "idle";
  sessionState.startedAt = null;

  res.json({
    success: true,
    message: "Call Ended"
  });

});

// ==========================
// AUTO TIMEOUT
// ==========================

setInterval(() => {

  if (
    sessionState.active &&
    sessionState.status === "ringing"
  ) {

    const currentTime = Date.now();

    const diff = currentTime - sessionState.startedAt;

    // 1 minute timeout
    if (diff > 60000) {

      console.log("⌛ No response. Session auto closed.");

      sessionState.active = false;
      sessionState.status = "idle";
      sessionState.startedAt = null;
    }
  }

}, 5000);

// ==========================
// START SERVER
// ==========================

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});