const express = require("express");

const router = express.Router();

const sessionState = require("../sessionStore");

// ==========================
// BELL PRESSED
// ==========================

router.post("/bell", (req, res) => {

    console.log("🔔 Doorbell Pressed");

    sessionState.active = true;
    sessionState.status = "ringing";
    sessionState.startedAt = Date.now();

    res.json({
        success: true,
        message: "Bell notification received",
        session: sessionState
    });
});

// ==========================
// GET SESSION STATUS
// ==========================

router.get("/session-status", (req, res) => {

    res.json(sessionState);
});

// ==========================
// ACCEPT CALL
// ==========================

router.post("/accept-call", (req, res) => {

    console.log("📞 Call Accepted");

    sessionState.status = "connected";

    res.json({
        success: true,
        session: sessionState
    });
});

// ==========================
// END CALL
// ==========================

router.post("/end-call", (req, res) => {

    console.log("❌ Call Ended");

    sessionState.active = false;
    sessionState.status = "idle";
    sessionState.startedAt = null;

    res.json({
        success: true,
        session: sessionState
    });
});

module.exports = router;