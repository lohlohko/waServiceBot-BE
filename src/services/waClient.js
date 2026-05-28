import fs from 'fs/promises';
import path from 'path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });
const sessionRoot = path.join(process.cwd(), 'src', 'sessions', 'botSessions');

const sessions = new Map();
const RECONNECT_DELAY_MS = 3000;
const SESSION_ID_MAX = 48;

const sanitizeSessionId = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return 'default';
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, SESSION_ID_MAX);
  return safe || 'default';
};

const getSessionDir = (sessionId) => {
  if (sessionId === 'default') return sessionRoot;
  return path.join(sessionRoot, sessionId);
};

const createSessionContext = (sessionId) => ({
  id: sessionId,
  sessionDir: getSessionDir(sessionId),
  socket: null,
  lastQr: null,
  connection: 'init',
  isReady: false,
  user: null,
  lastDisconnect: null,
  pairingCode: null,
  initPromise: null,
  reconnectTimer: null
});

const getSessionContext = (sessionId) => {
  const id = sanitizeSessionId(sessionId);
  const existing = sessions.get(id);
  if (existing) return existing;
  const context = createSessionContext(id);
  sessions.set(id, context);
  return context;
};

const cleanSession = async (context) => {
  logger.info({ sessionId: context.id }, 'Membersihkan folder session...');
  try {
    await fs.rm(context.sessionDir, { recursive: true, force: true });
    logger.info({ sessionId: context.id }, 'Folder session berhasil dibersihkan.');
  } catch (err) {
    logger.error({ err, sessionId: context.id }, 'Gagal membersihkan session');
  }
};

const normalizeToJid = (to) => {
  const raw = String(to || '').trim();

  if (!raw) throw new Error('Nomor tujuan kosong');

  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@g.us')) return raw;

  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) throw new Error('Nomor tujuan tidak valid');

  const normalized = digits.startsWith('0') ? `62${digits.slice(1)}` : digits;
  return `${normalized}@s.whatsapp.net`;
};

const destroySocket = (context) => {
  if (!context.socket) return;
  try {
    context.socket.ev.removeAllListeners();
    context.socket.ws?.close();
  } catch (_) {
  }
  context.socket = null;
};

const scheduleReconnect = (context, delay = RECONNECT_DELAY_MS) => {
  if (context.reconnectTimer) clearTimeout(context.reconnectTimer);
  context.initPromise = null;
  context.reconnectTimer = setTimeout(() => {
    context.reconnectTimer = null;
    context.initPromise = startSocket(context).catch((err) => {
      logger.error({ err, sessionId: context.id }, 'Gagal restart socket saat reconnect');
      context.initPromise = null;
    });
  }, delay);
};

// ─── Core Socket ──────────────────────────────────────────────────────────────

const startSocket = async (context) => {
  await fs.mkdir(context.sessionDir, { recursive: true });

  const credsPath = path.join(context.sessionDir, 'creds.json');
  try {
    const stat = await fs.stat(credsPath);
    if (stat.size === 0) {
      logger.warn({ sessionId: context.id }, 'creds.json kosong, menghapus...');
      await fs.unlink(credsPath);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.error({ err, sessionId: context.id }, 'Gagal periksa creds.json');
  }

  destroySocket(context);

  const { state, saveCreds } = await useMultiFileAuthState(context.sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const sessionLogger = logger.child({ sessionId: context.id });
  sessionLogger.info(`Menggunakan Baileys v${version.join('.')}`);

  context.socket = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, sessionLogger)
    },
    logger: sessionLogger,
    printQRInTerminal: false,
    version,
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 10_000,
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  context.socket.ev.on('creds.update', saveCreds);

  context.socket.ev.on('connection.update', async (update) => {
    const { connection: nextConn, lastDisconnect: disconnect, qr } = update;
    sessionLogger.info({ update }, `Connection update: ${nextConn}`);

    if (qr) {
      context.lastQr = qr;
      context.connection = 'qr';
      sessionLogger.info('QR code diterima, siap untuk di-scan.');
    }

    if (nextConn) {
      context.connection = nextConn;
    }

    if (nextConn === 'open') {
      context.isReady = true;
      context.user = context.socket?.user || null;
      context.lastQr = null;
      context.pairingCode = null;
      sessionLogger.info({ user: context.user }, 'Koneksi WhatsApp berhasil terbuka!');
    }

    if (nextConn === 'close') {
      context.isReady = false;
      context.user = null;
      context.lastQr = null;
      context.lastDisconnect = disconnect || null;

      const statusCode = disconnect?.error?.output?.statusCode;
      sessionLogger.warn({ statusCode }, `Koneksi ditutup. Kode: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut) {
        sessionLogger.warn('Logout terdeteksi, membersihkan session...');
        if (context.reconnectTimer) clearTimeout(context.reconnectTimer);
        context.initPromise = null;
        await cleanSession(context);
        scheduleReconnect(context, 1000);
      } else {
        sessionLogger.info(`Reconnect dalam ${RECONNECT_DELAY_MS}ms...`);
        scheduleReconnect(context, RECONNECT_DELAY_MS);
      }
    }
  });
};

// ─── Public API ───────────────────────────────────────────────────────────────

const initWhatsApp = async (sessionId) => {
  const context = getSessionContext(sessionId);
  if (!context.initPromise) {
    context.initPromise = startSocket(context);
  }
  await context.initPromise;
};

const getStatus = (sessionId) => {
  const context = getSessionContext(sessionId);
  return {
    sessionId: context.id,
    connection: context.connection,
    isReady: context.isReady,
    user: context.user,
    lastDisconnect: context.lastDisconnect?.error?.message
      ? { message: context.lastDisconnect.error.message }
      : context.lastDisconnect,
    lastQrAvailable: Boolean(context.lastQr),
    pairingCode: context.pairingCode
  };
};

const getLastQr = (sessionId) => {
  const context = getSessionContext(sessionId);
  return context.lastQr;
};

const requestPairingCode = async (sessionId, phoneNumber) => {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  if (!digits) throw new Error('Nomor pairing tidak valid');

  const context = getSessionContext(sessionId);
  await initWhatsApp(context.id);
  if (!context.socket) throw new Error('WhatsApp socket belum siap');

  if (context.socket.authState?.creds?.registered) {
    throw new Error('Akun sudah terdaftar, pairing tidak diperlukan');
  }

  context.pairingCode = await context.socket.requestPairingCode(digits);
  return context.pairingCode;
};

const sendTextMessage = async (sessionId, to, message) => {
  if (!message || !String(message).trim()) throw new Error('Pesan kosong');

  const context = getSessionContext(sessionId);
  await initWhatsApp(context.id);
  if (!context.socket || !context.isReady) throw new Error('WhatsApp belum terkoneksi');

  const jid = normalizeToJid(to);
  return context.socket.sendMessage(jid, { text: String(message) });
};

const logout = async (sessionId) => {
  const context = getSessionContext(sessionId);
  if (context.reconnectTimer) {
    clearTimeout(context.reconnectTimer);
    context.reconnectTimer = null;
  }

  try {
    if (context.socket) await context.socket.logout();
  } catch (_) {
  }

  destroySocket(context);
  await cleanSession(context);

  context.isReady = false;
  context.user = null;
  context.lastQr = null;
  context.connection = 'init';
  context.pairingCode = null;
  context.lastDisconnect = null;
  context.initPromise = null;

  scheduleReconnect(context, 1500);
};

const getGroups = async (sessionId) => {
  const context = getSessionContext(sessionId);
  if (!context.socket || !context.isReady) {
    throw new Error('WhatsApp belum terkoneksi. Silakan login terlebih dahulu.');
  }
  const groupsObj = await context.socket.groupFetchAllParticipating();
  return Object.values(groupsObj);
};

const getSocket = (sessionId) => {
  const context = getSessionContext(sessionId);
  return context.socket;
};

export {
  initWhatsApp,
  getStatus,
  getLastQr,
  requestPairingCode,
  sendTextMessage,
  logout,
  getGroups,
  getSocket
};