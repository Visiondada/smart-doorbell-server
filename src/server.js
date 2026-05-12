const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");

const sessionState = require("./sessionStore");
const imageService = require("./services/imageService");

const app = express();

// ==========================
// MIDDLEWARE
// ==========================

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Serve static files from uploads folder
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Configure multer for image uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    // Allow only image files
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  }
});

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
// UPLOAD IMAGE API (ESP32-CAM)
// ==========================

/**
 * POST /upload-image
 * Receives image from ESP32-CAM and saves it
 * Returns the saved image URL for React Native app
 *
 * Expected request:
 * - multipart/form-data with 'image' field containing the image file
 * - Optional: deviceId, timestamp in form data
 *
 * Response:
 * {
 *   success: true,
 *   filename: "image_1234567890_abcd1234.jpg",
 *   url: "http://54.237.213.192:3000/uploads/image_1234567890_abcd1234.jpg",
 *   timestamp: 1234567890,
 *   size: 45678
 * }
 */
app.post("/upload-image", upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No image file provided"
      });
    }

    console.log(`📸 Image upload received from device`);
    console.log(`   File: ${req.file.originalname}`);
    console.log(`   Size: ${req.file.size} bytes`);

    // Save the image using imageService
    const result = imageService.saveImage(
      req.file.buffer,
      req.file.originalname
    );

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error("❌ Upload error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==========================
// GET ALL IMAGES API (Mobile App)
// ==========================

/**
 * GET /get-images
 * Retrieves list of all uploaded images
 * Used by React Native app to display image gallery
 *
 * Response:
 * [
 *   {
 *     filename: "image_1234567890_abcd1234.jpg",
 *     url: "http://54.237.213.192:3000/uploads/image_1234567890_abcd1234.jpg",
 *     size: 45678,
 *     created: "2024-01-15T10:30:45.000Z",
 *     modified: "2024-01-15T10:30:45.000Z"
 *   },
 *   ...
 * ]
 */
app.get("/get-images", (req, res) => {
  try {
    const images = imageService.getImages();
    res.json({
      success: true,
      count: images.length,
      images: images
    });
  } catch (error) {
    console.error("❌ Error fetching images:", error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==========================
// DELETE IMAGE API (Mobile App)
// ==========================

/**
 * DELETE /delete-image/:filename
 * Deletes a specific image by filename
 * Used by React Native app to remove images
 *
 * Response:
 * {
 *   success: true,
 *   message: "Image deleted"
 * }
 */
app.delete("/delete-image/:filename", (req, res) => {
  try {
    const { filename } = req.params;

    if (!filename) {
      return res.status(400).json({
        success: false,
        error: "Filename is required"
      });
    }

    const result = imageService.deleteImage(filename);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error("❌ Error deleting image:", error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
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