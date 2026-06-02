import fs from 'fs';
import path from 'path';
import xlsx from 'xlsx';
import { getSocket } from './waClient.js';

// ─── Upload Dir ───────────────────────────────────────────────────────────────
export const UPLOAD_DIR = path.join(process.cwd(), 'src', 'sessions', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ─── Per-Session State ────────────────────────────────────────────────────────
// Each session gets its own isolated state, rows, workbook, and timeout.
const sessions = new Map();

const makeInitialState = (sessionId) => ({
  status: 'idle', // idle | running | paused | stopped | completed
  spreadsheetPath: '',
  imagePath: '',
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
  sessionId
});

const getSession = (sessionId) => {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      state: makeInitialState(sessionId),
      rowsMemory: [],
      workbookMemory: null,
      sheetNameMemory: '',
      activeTimeout: null
    });
  }
  return sessions.get(sessionId);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const pushLog = (session, message) => {
  const logEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    message,
    time: new Date().toISOString()
  };
  session.state.logs = [logEntry, ...session.state.logs].slice(0, 100);
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
  const worksheet = workbook.Sheets[sheetName];
  const ref = worksheet['!ref'];
  if (!ref) return;
  const range = xlsx.utils.decode_range(ref);

  // Map header names to column indices
  const headerMapping = {};
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cellAddress = xlsx.utils.encode_cell({ r: range.s.r, c: col });
    const cell = worksheet[cellAddress];
    if (cell && cell.v !== undefined && cell.v !== null) {
      headerMapping[String(cell.v).trim().toLowerCase()] = col;
    }
  }

  // Ensure status columns are present, append to the right if missing
  const colsToUpdate = ['status', 'result', 'sent_at', 'batch_id'];
  let nextColIdx = range.e.c + 1;

  colsToUpdate.forEach(colName => {
    if (headerMapping[colName] === undefined) {
      headerMapping[colName] = nextColIdx;
      const headerAddress = xlsx.utils.encode_cell({ r: range.s.r, c: nextColIdx });
      worksheet[headerAddress] = { t: 's', v: colName };
      nextColIdx++;
      range.e.c = nextColIdx - 1;
    }
  });

  // Update sheet reference range in case new columns were appended
  worksheet['!ref'] = xlsx.utils.encode_range(range);

  // Update cell values in-place
  rows.forEach((row, i) => {
    const excelRow = range.s.r + 1 + i;
    const allCols = [...colsToUpdate, 'nomor'];
    allCols.forEach(colName => {
      const colIdx = headerMapping[colName];
      if (colIdx !== undefined) {
        const cellAddress = xlsx.utils.encode_cell({ r: excelRow, c: colIdx });
        const val = row[colName] !== undefined && row[colName] !== null ? String(row[colName]) : '';
        worksheet[cellAddress] = worksheet[cellAddress] || {};
        worksheet[cellAddress].t = 's'; // Force type String
        worksheet[cellAddress].v = val;
        delete worksheet[cellAddress].w; // Clear any formatted text cache
      }
    });
  });

  xlsx.writeFile(workbook, filePath);
};

// ─── Public: Get Batch IDs from uploaded file ─────────────────────────────────
export const getSpreadsheetBatches = (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File spreadsheet tidak ditemukan: ${filePath}`);
  }
  const { rows } = loadExcel(filePath);
  const batches = [...new Set(rows.map(r => String(r.batch_id || '').trim()))].filter(Boolean);
  // Always include 'Semua Data' as the first option so users can broadcast the entire file
  return ['Semua Data', ...batches];
};

// ─── Public: Get spreadsheet rows ─────────────────────────────────────────────
export const getSpreadsheetRows = (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File spreadsheet tidak ditemukan: ${filePath}`);
  }
  const { rows } = loadExcel(filePath);
  return rows;
};

// ─── Public: Get broadcast status for a session ───────────────────────────────
export const getBroadcastStatus = (sessionId) => {
  const session = getSession(sessionId);
  const s = session.state;
  return {
    status: s.status,
    batchId: s.batchId,
    caption: s.caption,
    delayMin: s.delayMin,
    delayMax: s.delayMax,
    totalRows: s.totalRows,
    processedRows: s.processedRows,
    successCount: s.successCount,
    failedCount: s.failedCount,
    currentIndex: s.currentIndex,
    hasSpreadsheet: !!s.spreadsheetPath,
    hasImage: !!s.imagePath,
    logs: s.logs
  };
};

// ─── Core: Process next row for a session ────────────────────────────────────
const processNext = async (sessionId) => {
  const session = getSession(sessionId);
  const { state, rowsMemory } = session;

  if (state.status !== 'running') return;

  // Find next pending row for this batch
  let targetIndex = -1;
  for (let i = state.currentIndex + 1; i < rowsMemory.length; i++) {
    const row = rowsMemory[i];
    const rBatch = String(row.batch_id || '').trim();
    const isMatchingBatch = state.batchId === 'Semua Data'
      ? true
      : (rBatch === state.batchId);
    const isAlreadySent = /success|sukses/i.test(String(row.status || '').trim());
    if (isMatchingBatch && !isAlreadySent) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1) {
    state.status = 'completed';
    pushLog(session, `✓ Broadcast selesai untuk Batch: ${state.batchId}`);
    try { saveExcel(state.spreadsheetPath, session.workbookMemory, session.sheetNameMemory, rowsMemory); } catch (_) {}
    return;
  }

  const row = rowsMemory[targetIndex];
  const rawNum = String(row.nomor || '').trim();
  const jid = normalizeToJid(rawNum);

  if (!jid) {
    row.status = 'Failed';
    row.result = 'Nomor tidak valid';
    row.sent_at = new Date().toISOString();
    state.failedCount += 1;
    state.processedRows += 1;
    state.currentIndex = targetIndex;
    pushLog(session, `[${targetIndex}] ✗ Nomor tidak valid: "${rawNum}"`);
    try { saveExcel(state.spreadsheetPath, session.workbookMemory, session.sheetNameMemory, rowsMemory); } catch (_) {}
    processNext(sessionId);
    return;
  }

  const delaySec = Math.floor(Math.random() * (state.delayMax - state.delayMin + 1)) + state.delayMin;
  pushLog(session, `[${targetIndex}] ⏳ Jeda ${delaySec}s lalu kirim ke ${rawNum}...`);

  session.activeTimeout = setTimeout(async () => {
    session.activeTimeout = null;
    if (state.status !== 'running') return;

    try {
      const socket = getSocket(sessionId);
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
      state.processedRows += 1;
      state.currentIndex = targetIndex;
      pushLog(session, `[${targetIndex}] ✓ Sukses → ${rawNum}`);
    } catch (err) {
      row.status = 'Failed';
      row.result = err.message || 'Error';
      row.sent_at = new Date().toISOString();
      state.failedCount += 1;
      state.processedRows += 1;
      state.currentIndex = targetIndex;
      pushLog(session, `[${targetIndex}] ✗ Gagal → ${rawNum}: ${err.message}`);
    }

    try { saveExcel(state.spreadsheetPath, session.workbookMemory, session.sheetNameMemory, rowsMemory); } catch (_) {}
    processNext(sessionId);
  }, delaySec * 1000);
};

// ─── Public: Start broadcast ──────────────────────────────────────────────────
export const startBroadcast = (sessionId, spreadsheetPath, batchId, imagePath, caption, delayMin, delayMax) => {
  const session = getSession(sessionId);

  if (session.state.status === 'running') throw new Error('Broadcast sedang berjalan.');
  if (!fs.existsSync(spreadsheetPath)) throw new Error(`File spreadsheet tidak ditemukan.`);
  if (imagePath && !fs.existsSync(imagePath)) throw new Error(`File gambar tidak ditemukan.`);

  const { workbook, sheetName, rows } = loadExcel(spreadsheetPath);
  session.workbookMemory = workbook;
  session.sheetNameMemory = sheetName;
  session.rowsMemory = rows;

  const batchRows = rows.filter(r => {
    const rBatch = String(r.batch_id || '').trim();
    if (batchId === 'Semua Data') return true;
    return rBatch === batchId;
  });
  const pendingRows = batchRows.filter(r => !/success|sukses/i.test(String(r.status || '').trim()));

  if (batchRows.length === 0) throw new Error(`Tidak ada data dengan batch_id "${batchId}"`);
  if (pendingRows.length === 0) throw new Error(`Semua nomor pada batch "${batchId}" sudah sukses terkirim.`);

  session.state = {
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

  pushLog(session, `▶ Broadcast dimulai — Batch: ${batchId} | Total: ${batchRows.length} | Pending: ${pendingRows.length} | Delay: ${session.state.delayMin}-${session.state.delayMax}s`);
  processNext(sessionId);
};

// ─── Public: Pause ────────────────────────────────────────────────────────────
export const pauseBroadcast = (sessionId) => {
  const session = getSession(sessionId);
  if (session.state.status !== 'running') throw new Error('Broadcast tidak sedang berjalan.');
  session.state.status = 'paused';
  if (session.activeTimeout) { clearTimeout(session.activeTimeout); session.activeTimeout = null; }
  pushLog(session, '⏸ Broadcast dijeda.');
};

// ─── Public: Resume ───────────────────────────────────────────────────────────
export const resumeBroadcast = (sessionId) => {
  const session = getSession(sessionId);
  if (session.state.status !== 'paused') throw new Error('Broadcast tidak sedang dijeda.');
  session.state.status = 'running';
  pushLog(session, '▶ Broadcast dilanjutkan.');
  processNext(sessionId);
};

// ─── Public: Stop ─────────────────────────────────────────────────────────────
export const stopBroadcast = (sessionId) => {
  const session = getSession(sessionId);
  session.state.status = 'stopped';
  if (session.activeTimeout) { clearTimeout(session.activeTimeout); session.activeTimeout = null; }
  pushLog(session, '✕ Broadcast dihentikan secara paksa.');
};

// ─── Public: Get download path ────────────────────────────────────────────────
export const getSpreadsheetPath = (sessionId) => {
  const session = getSession(sessionId);
  return session.state.spreadsheetPath;
};
