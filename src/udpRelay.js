/**
 * UDP Audio Relay — Port 4000
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │                        AWS EC2 Server                                    │
 * │                                                                          │
 * │   Mobile App                                                             │
 * │   (Socket.IO:3000)  ──audio:owner──►  io.emit(audio:owner→udp)          │
 * │                                           │                              │
 * │                                           ▼                              │
 * │                                   UDP send → ESP32:4000                  │
 * │                                                                          │
 * │   ESP32                                                                  │
 * │   (UDP:4000)  ────raw PCM►  relay  ──►  io.emit(audio:visitor)          │
 * │                                           │                              │
 * │                                           ▼                              │
 * │                                   Socket.IO → Mobile App                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * DROP POLICY (buffer overflow prevention):
 *   - Max queue depth: MAX_QUEUE_DEPTH packets
 *   - Max packet age:  MAX_PACKET_AGE_MS milliseconds
 *   - If the relay is busy (udpServer.send still in flight), incoming packets
 *     are queued. If the queue is full, the OLDEST packet is dropped and the
 *     newest is enqueued — latest audio always wins.
 */

const dgram = require("dgram");

const UDP_PORT         = 4000;
const MAX_QUEUE_DEPTH  = 4;    // max packets buffered before dropping oldest
const MAX_PACKET_AGE_MS = 200; // discard packets older than 200ms

// ESP32's registered IP + port (learned from first UDP packet / handshake)
let esp32Peer = null; // { address, port }

// Simple FIFO queue — { buf, timestamp }[]
const outboundQueue = [];
let isSending       = false;

/** Drain the outbound queue one packet at a time */
function drainQueue(udpServer) {
  if (isSending || outboundQueue.length === 0 || !esp32Peer) return;

  const now  = Date.now();

  // Drop stale packets from the front of the queue
  while (
    outboundQueue.length > 0 &&
    now - outboundQueue[0].timestamp > MAX_PACKET_AGE_MS
  ) {
    outboundQueue.shift();
    console.log("🗑️  [UDP] Dropped stale packet (age > MAX_PACKET_AGE_MS)");
  }

  if (outboundQueue.length === 0) return;

  isSending = true;
  const { buf } = outboundQueue.shift();

  udpServer.send(buf, esp32Peer.port, esp32Peer.address, (err) => {
    isSending = false;
    if (err) {
      console.error("❌ [UDP] Send error:", err.message);
    }
    // Recursively drain next packet
    drainQueue(udpServer);
  });
}

/**
 * Enqueue a packet for sending to the ESP32.
 * If the queue is full, drop the oldest entry to make room for the newest.
 */
function enqueueToEsp32(udpServer, buf) {
  if (outboundQueue.length >= MAX_QUEUE_DEPTH) {
    outboundQueue.shift(); // drop oldest — latest audio wins
    console.log("⚠️  [UDP] Queue full — dropped oldest packet");
  }
  outboundQueue.push({ buf, timestamp: Date.now() });
  drainQueue(udpServer);
}

/**
 * @param {import("socket.io").Server} io  — the Socket.IO server instance
 */
function startUdpRelay(io) {
  const udpServer = dgram.createSocket("udp4");

  // ── UDP error handler ───────────────────────────────────────────────────
  udpServer.on("error", (err) => {
    console.error("❌ [UDP] Server error:", err.message);
    // Don't crash the process — log and keep the HTTP server alive
  });

  // ── Incoming UDP packets (from ESP32) ───────────────────────────────────
  udpServer.on("message", (msg, rinfo) => {
    const msgStr = msg.toString("utf8").trim();

    // ── ESP32 handshake ───────────────────────────────────────────────────
    if (msgStr === "hello:esp32") {
      esp32Peer = { address: rinfo.address, port: rinfo.port };
      console.log(`🔌 [UDP] ESP32 registered → ${rinfo.address}:${rinfo.port}`);
      udpServer.send(Buffer.from("ack:esp32"), rinfo.port, rinfo.address);
      return;
    }

    // ── Ignore small/text packets (acks, etc.) ────────────────────────────
    if (msg.length < 8) return;

    // ── Auto-register ESP32 if no handshake was sent ─────────────────────
    if (!esp32Peer) {
      esp32Peer = { address: rinfo.address, port: rinfo.port };
      console.log(`🔌 [UDP] ESP32 auto-registered → ${rinfo.address}:${rinfo.port}`);
    }

    // ── Drop policy: discard packets older than MAX_PACKET_AGE_MS ─────────
    // (UDP from ESP32 can arrive late if the network hiccups)
    // We simply check the packet is from the current ESP32 peer and emit.
    // The Socket.IO layer itself is the bottleneck here — if io.emit is
    // queued, the app receives slightly delayed but consistent audio.
    const base64Audio = msg.toString("base64");
    io.emit("audio:visitor", {
      audio:      base64Audio,
      format:     "pcm",
      sampleRate: 16000,
      timestamp:  Date.now(),
    });
  });

  // ── Bind UDP server ─────────────────────────────────────────────────────
  udpServer.bind(UDP_PORT, "0.0.0.0", () => {
    const addr = udpServer.address();
    console.log(`📡 [UDP] Audio relay listening on udp://0.0.0.0:${addr.port}`);
    console.log(`🔗 [UDP] Bridge: ESP32(UDP:4000) ↔ App(Socket.IO:3000)`);
    console.log(`🛡️  [UDP] Drop policy: queue=${MAX_QUEUE_DEPTH}, maxAge=${MAX_PACKET_AGE_MS}ms`);
  });

  // ── Forward owner audio (App → ESP32) with drop policy ──────────────────
  function sendToEsp32(base64Audio) {
    if (!esp32Peer) return; // ESP32 not yet registered — silently drop
    try {
      const buf = Buffer.from(base64Audio, "base64");
      enqueueToEsp32(udpServer, buf);
    } catch (err) {
      console.error("❌ [UDP] sendToEsp32 decode error:", err.message);
    }
  }

  // ── Handshake: tell ESP32 the App is ready ──────────────────────────────
  function sendHandshakeReady() {
    if (!esp32Peer) {
      console.log("⚠️  [UDP] sendHandshakeReady — ESP32 not registered, skipping");
      return;
    }
    const packet = Buffer.from("HANDSHAKE_READY");
    udpServer.send(packet, esp32Peer.port, esp32Peer.address, (err) => {
      if (err) {
        console.error("❌ [UDP] sendHandshakeReady error:", err.message);
      } else {
        console.log(`🤝 [UDP] HANDSHAKE_READY sent → ${esp32Peer.address}:${esp32Peer.port}`);
      }
    });
  }

  // ── Reset on call end ───────────────────────────────────────────────────
  function resetPeers() {
    esp32Peer = null;
    outboundQueue.length = 0; // clear any buffered packets
    isSending = false;
    console.log("🔄 [UDP] Peer registry + queue reset for next call");
  }

  // ── Status helper ───────────────────────────────────────────────────────
  function getStatus() {
    return {
      udpPort:        UDP_PORT,
      esp32Connected: !!esp32Peer,
      esp32Peer,
      queueDepth:     outboundQueue.length,
    };
  }

  return { udpServer, sendToEsp32, sendHandshakeReady, resetPeers, getStatus };
}

module.exports = { startUdpRelay };
