import express from 'express';
import {
  handleUploadSpreadsheet,
  handleUploadImage,
  getStatus,
  start,
  pause,
  resume,
  stop,
  download
} from '../controllers/broadcastController.js';

const router = express.Router();

// File uploads (multipart/form-data)
router.post('/upload-spreadsheet', handleUploadSpreadsheet);
router.post('/upload-image', handleUploadImage);

// Broadcast control (application/json)
router.get('/status', getStatus);
router.post('/start', start);
router.post('/pause', pause);
router.post('/resume', resume);
router.post('/stop', stop);

// Download updated spreadsheet
router.get('/download', download);

export default router;
