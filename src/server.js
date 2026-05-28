import 'dotenv/config';
import app from './app.js';
import { initWhatsApp } from './services/waClient.js';
import os from 'os';

//Function Get Local IP Address
const getLocalIP = () => {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (
        iface.family === 'IPv4' &&
        !iface.internal &&
        !iface.address.startsWith('172')
      ) {
        return iface.address;
      }
    }
  }

  return 'localhost';
};

const port = Number(process.env.PORT) || 3456;

const startServer = async () => {
	try {
		await initWhatsApp();

        app.listen(port, '0.0.0.0', async () => {
        const localIP = getLocalIP();
        console.log(`[waBotService] Server berjalan di http://${localIP}:${port}`);
    });

	} catch (error) {
		console.error('[waBotService] gagal init WhatsApp:', error?.message || error);
	}

	
};

startServer();
