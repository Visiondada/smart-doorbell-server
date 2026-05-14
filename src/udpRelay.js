/**
 * UDP Audio Relay Server — Port 4000
 *
 * Architecture:
 *   ESP32  --UDP--> [This server:4000] --UDP--> Mobile App
 *   Mobile App --UDP--> [This server:4000] --UDP--> ESP32
 *
 * The server dynamically learns the IP:Port of both peers when they
 * send their first packet. All subsequent packets are relayed to the
 * OTHER peer. This makes it fully plug-and-play — no hardcoded IPs needed.
 */

const dgram = require("dgram");

const UDP_PORT = 4000;

// ─── Peer Registry ────────────────────────────────────────────────────────────
// We use a simple 2-slot registry. The first device to send a packet is
// registered as "peer A", the second as "peer B". All packets from A → B and
// vice-versa.
//
// To tell the ESP32 apart from the App: the ESP32 sends a "hello:esp32"
// handshake packet first, and the App sends "hello:app". Any subsequent
// non-hello binary packet is relayed directly.

const PEERS = {
  esp32: null, // { address, port }
  app: null,   // { address, port }
};

function startUdpRelay() {
  const server = dgram.createSocket("udp4");

  server.on("error", (err) => {
    console.error("❌ [UDP] Server error:", err.message);
    server.close();
  });

  server.on("message", (msg, rinfo) => {
    const msgStr = msg.toString("utf8").trim();

    // ── Handshake: ESP32 announces itself ────────────────────────────────────
    if (msgStr === "hello:esp32") {
      PEERS.esp32 = { address: rinfo.address, port: rinfo.port };
      console.log(
        `🔌 [UDP] ESP32 registered → ${rinfo.address}:${rinfo.port}`
      );
      // Acknowledge
      const ack = Buffer.from("ack:esp32");
      server.send(ack, rinfo.port, rinfo.address);
      return;
    }

    // ── Handshake: Mobile App announces itself ────────────────────────────────
    if (msgStr === "hello:app") {
      PEERS.app = { address: rinfo.address, port: rinfo.port };
      console.log(
        `📱 [UDP] App registered → ${rinfo.address}:${rinfo.port}`
      );
      // Acknowledge
      const ack = Buffer.from("ack:app");
      server.send(ack, rinfo.port, rinfo.address);
      return;
    }

    // ── Audio Relay: ESP32 → App ──────────────────────────────────────────────
    if (
      PEERS.esp32 &&
      rinfo.address === PEERS.esp32.address &&
      rinfo.port === PEERS.esp32.port
    ) {
      if (PEERS.app) {
        server.send(msg, PEERS.app.port, PEERS.app.address, (err) => {
          if (err) console.error("❌ [UDP] Relay ESP32→App error:", err.message);
        });
      }
      return;
    }

    // ── Audio Relay: App → ESP32 ──────────────────────────────────────────────
    if (
      PEERS.app &&
      rinfo.address === PEERS.app.address &&
      rinfo.port === PEERS.app.port
    ) {
      if (PEERS.esp32) {
        server.send(msg, PEERS.esp32.port, PEERS.esp32.address, (err) => {
          if (err) console.error("❌ [UDP] Relay App→ESP32 error:", err.message);
        });
      }
      return;
    }

    // ── Unknown sender — register as the missing peer ─────────────────────────
    // Fallback: if no handshake was sent, dynamically assign the first
    // unknown sender as esp32 and the second as app.
    if (!PEERS.esp32) {
      PEERS.esp32 = { address: rinfo.address, port: rinfo.port };
      console.log(
        `🔌 [UDP] ESP32 auto-registered (no handshake) → ${rinfo.address}:${rinfo.port}`
      );
    } else if (!PEERS.app) {
      PEERS.app = { address: rinfo.address, port: rinfo.port };
      console.log(
        `📱 [UDP] App auto-registered (no handshake) → ${rinfo.address}:${rinfo.port}`
      );
    }
  });

  server.bind(UDP_PORT, "0.0.0.0", () => {
    const addr = server.address();
    console.log(`📡 [UDP] Audio relay listening on udp://0.0.0.0:${addr.port}`);
  });

  // ── Peer reset: called from HTTP /end route so next call starts fresh ────────
  function resetPeers() {
    PEERS.esp32 = null;
    PEERS.app = null;
    console.log("🔄 [UDP] Peer registry reset for next call");
  }

  return { server, resetPeers };
}

module.exports = { startUdpRelay };
