import { badRequest, notFound, ok, serverError } from '../utils/response.js';
import { getLastQr, getStatus, initWhatsApp, requestPairingCode, logout, getGroups } from '../services/waClient.js';
import { getSessionIdFromRequest } from '../utils/session.js';

const getWaStatus = (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  return ok(res, 'Status WhatsApp', getStatus(sessionId));
};

const getQr = async (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  try {
    await initWhatsApp(sessionId);
  } catch (error) {
    return serverError(res, error?.message || 'Gagal inisialisasi WhatsApp');
  }

  const qr = getLastQr(sessionId) || null;
  return ok(res, qr ? 'QR tersedia' : 'QR belum tersedia', { qr });
};

const createPairingCode = async (req, res) => {
  const { phoneNumber } = req.body || {};
  const sessionId = getSessionIdFromRequest(req);
  if (!phoneNumber) {
    return badRequest(res, 'phoneNumber wajib diisi');
  }

  try {
    const code = await requestPairingCode(sessionId, phoneNumber);
    return ok(res, 'Pairing code berhasil dibuat', { code });
  } catch (error) {
    return serverError(res, error?.message || 'Gagal membuat pairing code');
  }
};

const logoutSession = async (req, res) => {
  try {
    const sessionId = getSessionIdFromRequest(req);
    await logout(sessionId);
    return ok(res, 'Logout dan reset session berhasil');
  } catch (error) {
    return serverError(res, error?.message || 'Gagal logout');
  }
};

const getWaGroups = async (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  try {
    const groups = await getGroups(sessionId);
    return ok(res, 'Group WhatsApp berhasil diambil', groups);
  } catch (error) {
    return serverError(res, error?.message || 'Gagal mengambil group WhatsApp');
  }
};

export { getWaStatus, getQr, createPairingCode, logoutSession, getWaGroups };
