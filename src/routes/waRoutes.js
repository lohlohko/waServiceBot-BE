import express from 'express';
import { createPairingCode, getQr, getWaStatus, logoutSession, getWaGroups } from '../controllers/waController.js';

const router = express.Router();

router.get('/status', getWaStatus);
router.get('/qr', getQr);
router.get('/groups', getWaGroups);
router.post('/pairing-code', createPairingCode);
router.post('/logout', logoutSession);

export default router;
