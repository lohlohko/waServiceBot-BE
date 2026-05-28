import fs from 'fs';
import path from 'path';
import xlsx from 'xlsx';
import { getSocket } from './waClient.js';

// ─── Upload Dir ───────────────────────────────────────────────────────────────
export const UPLOAD_DIR = path.join(process.cwd(), 'src', 'sessions', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  status: 'idle', // idle | running | paused | stopped | completed
  spreadsheetPath: '',   // path to uploaded xlsx on disk
  imagePath: '',         // path to uploaded image on disk (optional)
  caption: '',
  batchId: '',
  delayMin: 15,
  delayMax: 30,
  totalRows: 0,
  processedRows: 0,
  successCount: 0,
  failedCount: 0,
  currentIndex: -1,
  logs: [],
  sessionId: 'default'
};

let rowsMemory = [];
let workbookMemory = null;
let sheetNameMemory = '';
let activeTimeout = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const pushLog = (message) => {
  const logEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    message,
    time: new Date().toISOString()
  };
  state.logs = [logEntry, ...state.logs].slice(0, 100);
};

const normalizeToJid = (to) => {
  const raw = String(to || '').trim();
  if (!raw) return null;
  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@g.us')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return null;
  const normalized = digits.startsWith('0') ? `62${digits.slice(1)}` : digits;
  return `${normalized}@s.whatsapp.net`;
};

const loadExcel = (filePath) => {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
  return { workbook, sheetName, rows };
};

const saveExcel = (filePath, workbook, sheetName, rows) => {
  const worksheet = xlsx.utils.json_to_sheet(rows);
  workbook.Sheets[sheetName] = worksheet;
  xlsx.writeFile(workbook, filePath);
};

// ─── Public: Get Batch IDs from uploaded file ─────────────────────────────────
export const getSpreadsheetBatches = (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File spreadsheet tidak ditemukan: ${filePath}`);
  }
  const { rows } = loadExcel(filePath);
  const batches = [...new Set(rows.map(r => String(r.batch_id || '').trim()))].filter(Boolean);
  if (batches.length === 0) {
    return ['Semua Data'];
  }
  return batches;
};

// ─── Public: Get current broadcast status ────────────────────────────────────
export const getBroadcastStatus = () => ({
  status: state.status,
  batchId: state.batchId,
  caption: state.caption,
  delayMin: state.delayMin,
  delayMax: state.delayMax,
  totalRows: state.totalRows,
  processedRows: state.processedRows,
  successCount: state.successCount,
  failedCount: state.failedCount,
  currentIndex: state.currentIndex,
  hasSpreadsheet: !!state.spreadsheetPath,
  hasImage: !!state.imagePath,
  logs: state.logs
});

// ─── Core: Process next row ───────────────────────────────────────────────────
const processNext = async () => {
  if (state.status !== 'running') return;

  // Find next pending row for this batch
  let targetIndex = -1;
  for (let i = state.currentIndex + 1; i < rowsMemory.length; i++) {
    const row = rowsMemory[i];
    const rBatch = String(row.batch_id || '').trim();
    const isMatchingBatch = state.batchId === 'Semua Data'
      ? (!rBatch || rBatch === 'Semua Data')
      : (rBatch === state.batchId);
    const isAlreadySent = /success|sukses/i.test(String(row.status || '').trim());
    if (isMatchingBatch && !isAlreadySent) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1) {
    state.status = 'completed';
    pushLog(`✓ Broadcast selesai untuk Batch: ${state.batchId}`);
    try { saveExcel(state.spreadsheetPath, workbookMemory, sheetNameMemory, rowsMemory); } catch (_) {}
    return;
  }

  state.currentIndex = targetIndex;
  const row = rowsMemory[targetIndex];
  const rawNum = String(row.nomor || '').trim();
  const jid = normalizeToJid(rawNum);

  state.processedRows += 1;

  if (!jid) {
    row.status = 'Failed';
    row.result = 'Nomor tidak valid';
    row.sent_at = new Date().toISOString();
    state.failedCount += 1;
    pushLog(`[${targetIndex}] ✗ Nomor tidak valid: "${rawNum}"`);
    try { saveExcel(state.spreadsheetPath, workbookMemory, sheetNameMemory, rowsMemory); } catch (_) {}
    processNext();
    return;
  }

  const delaySec = Math.floor(Math.random() * (state.delayMax - state.delayMin + 1)) + state.delayMin;
  pushLog(`[${targetIndex}] ⏳ Jeda ${delaySec}s lalu kirim ke ${rawNum}...`);

  activeTimeout = setTimeout(async () => {
    activeTimeout = null;
    if (state.status !== 'running') return;

    try {
      const socket = getSocket(state.sessionId);
      if (!socket) throw new Error('WhatsApp socket belum terhubung');

      if (state.imagePath && fs.existsSync(state.imagePath)) {
        await socket.sendMessage(jid, {
          image: { url: state.imagePath },
          caption: state.caption
        });
      } else {
        await socket.sendMessage(jid, { text: state.caption });
      }

      row.status = 'Success';
      row.result = 'Terkirim';
      row.sent_at = new Date().toISOString();
      state.successCount += 1;
      pushLog(`[${targetIndex}] ✓ Sukses → ${rawNum}`);
    } catch (err) {
      row.status = 'Failed';
      row.result = err.message || 'Error';
      row.sent_at = new Date().toISOString();
      state.failedCount += 1;
      pushLog(`[${targetIndex}] ✗ Gagal → ${rawNum}: ${err.message}`);
    }

    try { saveExcel(state.spreadsheetPath, workbookMemory, sheetNameMemory, rowsMemory); } catch (_) {}
    processNext();
  }, delaySec * 1000);
};

// ─── Public: Start broadcast ──────────────────────────────────────────────────
export const startBroadcast = (sessionId, spreadsheetPath, batchId, imagePath, caption, delayMin, delayMax) => {
  if (state.status === 'running') throw new Error('Broadcast sedang berjalan.');
  if (!fs.existsSync(spreadsheetPath)) throw new Error(`File spreadsheet tidak ditemukan.`);
  if (imagePath && !fs.existsSync(imagePath)) throw new Error(`File gambar tidak ditemukan.`);

  const { workbook, sheetName, rows } = loadExcel(spreadsheetPath);
  workbookMemory = workbook;
  sheetNameMemory = sheetName;
  rowsMemory = rows;

  const batchRows = rows.filter(r => {
    const rBatch = String(r.batch_id || '').trim();
    if (batchId === 'Semua Data') {
      return !rBatch || rBatch === 'Semua Data';
    }
    return rBatch === batchId;
  });
  const pendingRows = batchRows.filter(r => !/success|sukses/i.test(String(r.status || '').trim()));

  if (batchRows.length === 0) throw new Error(`Tidak ada data dengan batch_id "${batchId}"`);
  if (pendingRows.length === 0) throw new Error(`Semua nomor pada batch "${batchId}" sudah sukses terkirim.`);

  state = {
    status: 'running',
    spreadsheetPath,
    imagePath: imagePath || '',
    caption,
    batchId,
    delayMin: Math.max(5, Number(delayMin) || 15),
    delayMax: Math.max(5, Number(delayMax) || 30),
    sessionId,
    totalRows: batchRows.length,
    processedRows: batchRows.length - pendingRows.length,
    successCount: batchRows.filter(r => /success|sukses/i.test(String(r.status || '').trim())).length,
    failedCount: batchRows.filter(r => /fail|gagal/i.test(String(r.status || '').trim())).length,
    currentIndex: -1,
    logs: []
  };

  pushLog(`▶ Broadcast dimulai — Batch: ${batchId} | Total: ${batchRows.length} | Pending: ${pendingRows.length} | Delay: ${state.delayMin}-${state.delayMax}s`);
  processNext();
};

// ─── Public: Pause ────────────────────────────────────────────────────────────
export const pauseBroadcast = () => {
  if (state.status !== 'running') throw new Error('Broadcast tidak sedang berjalan.');
  state.status = 'paused';
  if (activeTimeout) { clearTimeout(activeTimeout); activeTimeout = null; }
  pushLog('⏸ Broadcast dijeda.');
};

// ─── Public: Resume ───────────────────────────────────────────────────────────
export const resumeBroadcast = () => {
  if (state.status !== 'paused') throw new Error('Broadcast tidak sedang dijeda.');
  state.status = 'running';
  pushLog('▶ Broadcast dilanjutkan.');
  processNext();
};

// ─── Public: Stop ─────────────────────────────────────────────────────────────
export const stopBroadcast = () => {
  state.status = 'stopped';
  if (activeTimeout) { clearTimeout(activeTimeout); activeTimeout = null; }
  pushLog('✕ Broadcast dihentikan secara paksa.');
};

// ─── Public: Get download path ────────────────────────────────────────────────
export const getSpreadsheetPath = () => state.spreadsheetPath;
