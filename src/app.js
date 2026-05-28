import express from 'express';
import cors from 'cors';
import corsOptions from './config/cors.js';
import routes from './routes/index.js';
import errorHandler from './middlewares/errorHandler.js';
import { notFound, ok } from './utils/response.js';

const app = express();

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => ok(res, 'waBotService berjalan'));
app.get('/health', (req, res) => ok(res, 'OK'));

app.use('/api', routes);

app.use((req, res) => notFound(res, 'Route tidak ditemukan'));
app.use(errorHandler);

export default app;
