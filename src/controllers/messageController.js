import { badRequest, ok, serverError } from '../utils/response.js';
import { sendTextMessage } from '../services/waClient.js';
import { getSessionIdFromRequest } from '../utils/session.js';

const sendMessage = async (req, res) => {
  const { to, message } = req.body || {};

  if (!to || !message) {
    return badRequest(res, 'to dan message wajib diisi');
  }

  try {
    const sessionId = getSessionIdFromRequest(req);
    const result = await sendTextMessage(sessionId, to, message);
    return ok(res, 'Pesan terkirim', { messageId: result?.key?.id || null });
  } catch (error) {
    return serverError(res, error?.message || 'Gagal mengirim pesan');
  }
};

export { sendMessage };
