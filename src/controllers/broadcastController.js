import path from 'path';
import multer from 'multer';
import { badRequest, ok, serverError } from '../utils/response.js';
import { getSessionIdFromRequest } from '../utils/session.js';
import {
  UPLOAD_DIR,
  getSpreadsheetBatches,
  getSpreadsheetRows,
  getBroadcastStatus,
  startBroadcast,
  pauseBroadcast,
  resumeBroadcast,
  stopBroadcast,
  getSpreadsheetPath
} from '../services/broadcastService.js';
import fs from 'fs';

// ─── Multer storage: preserve original extension ──────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${base}${ext}`);
  }
});

export const uploadSpreadsheet = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Hanya file .xlsx, .xls, atau .csv yang diperbolehkan'));
  }
}).single('spreadsheet');

export const uploadImage = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Hanya file gambar yang diperbolehkan'));
  }
}).single('image');

// ─── POST /api/broadcast/upload-spreadsheet ───────────────────────────────────
export const handleUploadSpreadsheet = (req, res) => {
  uploadSpreadsheet(req, res, (err) => {
    if (err) return serverError(res, err.message || 'Gagal upload spreadsheet');
    if (!req.file) return badRequest(res, 'File spreadsheet wajib disertakan');

    try {
      const batches = getSpreadsheetBatches(req.file.path);
      const rows = getSpreadsheetRows(req.file.path);
      return ok(res, 'Spreadsheet berhasil diupload', {
        filePath: req.file.path,
        fileName: req.file.originalname,
        batches,
        rows
      });
    } catch (error) {
      return serverError(res, error.message || 'Gagal membaca spreadsheet');
    }
  });
};

// ─── POST /api/broadcast/upload-image ────────────────────────────────────────
export const handleUploadImage = (req, res) => {
  uploadImage(req, res, (err) => {
    if (err) return serverError(res, err.message || 'Gagal upload gambar');
    if (!req.file) return badRequest(res, 'File gambar wajib disertakan');

    return ok(res, 'Gambar berhasil diupload', {
      imagePath: req.file.path,
      fileName: req.file.originalname
    });
  });
};

// ─── GET /api/broadcast/status ────────────────────────────────────────────────
// Now scoped to the requesting session — other sessions see their own state.
export const getStatus = (req, res) => {
  try {
    const sessionId = getSessionIdFromRequest(req);
    return ok(res, 'Status broadcast', getBroadcastStatus(sessionId));
  } catch (error) {
    return serverError(res, error.message || 'Gagal mengambil status');
  }
};

// ─── POST /api/broadcast/start ────────────────────────────────────────────────
export const start = (req, res) => {
  const { spreadsheetPath, imagePath, batchId, caption, delayMin, delayMax } = req.body || {};
  const sessionId = getSessionIdFromRequest(req);

  if (!spreadsheetPath) return badRequest(res, 'spreadsheetPath wajib diisi (upload dulu)');
  if (!batchId) return badRequest(res, 'batchId wajib diisi');
  if (caption === undefined || caption === null) return badRequest(res, 'caption wajib diisi');

  try {
    startBroadcast(sessionId, spreadsheetPath, batchId, imagePath, caption, delayMin, delayMax);
    return ok(res, 'Broadcast berhasil dimulai');
  } catch (error) {
    return serverError(res, error.message || 'Gagal memulai broadcast');
  }
};

// ─── POST /api/broadcast/pause ────────────────────────────────────────────────
export const pause = (req, res) => {
  try {
    const sessionId = getSessionIdFromRequest(req);
    pauseBroadcast(sessionId);
    return ok(res, 'Broadcast dijeda');
  } catch (error) {
    return serverError(res, error.message || 'Gagal menjeda broadcast');
  }
};

// ─── POST /api/broadcast/resume ───────────────────────────────────────────────
export const resume = (req, res) => {
  try {
    const sessionId = getSessionIdFromRequest(req);
    resumeBroadcast(sessionId);
    return ok(res, 'Broadcast dilanjutkan');
  } catch (error) {
    return serverError(res, error.message || 'Gagal melanjutkan broadcast');
  }
};

// ─── POST /api/broadcast/stop ─────────────────────────────────────────────────
export const stop = (req, res) => {
  try {
    const sessionId = getSessionIdFromRequest(req);
    stopBroadcast(sessionId);
    return ok(res, 'Broadcast dihentikan');
  } catch (error) {
    return serverError(res, error.message || 'Gagal menghentikan broadcast');
  }
};

// ─── GET /api/broadcast/download ─────────────────────────────────────────────
export const download = (req, res) => {
  try {
    const sessionId = getSessionIdFromRequest(req);
    const filePath = getSpreadsheetPath(sessionId);
    if (!filePath || !fs.existsSync(filePath)) {
      return badRequest(res, 'Tidak ada file spreadsheet yang tersedia untuk diunduh');
    }
    const fileName = `broadcast_report_${Date.now()}.xlsx`;
    res.download(filePath, fileName);
  } catch (error) {
    return serverError(res, error.message || 'Gagal mengunduh laporan');
  }
};
