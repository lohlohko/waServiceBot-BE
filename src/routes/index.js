import express from 'express';
import messageRoutes from './messageRoutes.js';
import waRoutes from './waRoutes.js';
import broadcastRoutes from './broadcastRoutes.js';

const router = express.Router();

router.use('/messages', messageRoutes);
router.use('/wa', waRoutes);
router.use('/broadcast', broadcastRoutes);

export default router;
