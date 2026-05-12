/**
 * Image Service
 * Handles image upload and management operations
 * Provides utility functions for saving and serving images
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ==========================
// PATHS & CONFIG
// ==========================

const uploadsDir = path.join(__dirname, '../../uploads');
const baseUrl = process.env.BACKEND_URL || 'http://54.237.213.192:3000';

// Ensure uploads directory exists
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('✅ Uploads directory created');
}

// ==========================
// SAVE IMAGE FILE
// ==========================

/**
 * Saves an image file to the uploads directory
 * @param {Buffer} fileBuffer - Image file buffer
 * @param {string} originalName - Original filename
 * @returns {Object} - Object with filename and url
 */
const saveImage = (fileBuffer, originalName = 'capture.jpg') => {
  try {
    // Generate unique filename
    const timestamp = Date.now();
    const hash = crypto.randomBytes(4).toString('hex');
    const ext = path.extname(originalName) || '.jpg';
    const fileName = `image_${timestamp}_${hash}${ext}`;
    const filePath = path.join(uploadsDir, fileName);

    // Write file to disk
    fs.writeFileSync(filePath, fileBuffer);

    console.log(`📸 Image saved: ${fileName}`);

    return {
      success: true,
      filename: fileName,
      url: `${baseUrl}/uploads/${fileName}`,
      timestamp: timestamp,
      size: fileBuffer.length
    };
  } catch (error) {
    console.error('❌ Error saving image:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
};

// ==========================
// GET IMAGE METADATA
// ==========================

/**
 * Gets information about all uploaded images
 * @returns {Array} - Array of image metadata
 */
const getImages = () => {
  try {
    if (!fs.existsSync(uploadsDir)) {
      return [];
    }

    const files = fs.readdirSync(uploadsDir);
    const images = files
      .filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file))
      .map(file => {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          url: `${baseUrl}/uploads/${file}`,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
      .sort((a, b) => b.modified - a.modified);

    return images;
  } catch (error) {
    console.error('❌ Error reading images:', error.message);
    return [];
  }
};

// ==========================
// DELETE IMAGE
// ==========================

/**
 * Deletes an image file
 * @param {string} filename - Filename to delete
 * @returns {Object} - Success/error result
 */
const deleteImage = (filename) => {
  try {
    // Prevent directory traversal
    if (filename.includes('..') || filename.includes('/')) {
      return {
        success: false,
        error: 'Invalid filename'
      };
    }

    const filePath = path.join(uploadsDir, filename);

    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        error: 'File not found'
      };
    }

    fs.unlinkSync(filePath);
    console.log(`🗑️  Image deleted: ${filename}`);

    return {
      success: true,
      message: 'Image deleted'
    };
  } catch (error) {
    console.error('❌ Error deleting image:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
};

// ==========================
// EXPORTS
// ==========================

module.exports = {
  saveImage,
  getImages,
  deleteImage,
  uploadsDir
};
