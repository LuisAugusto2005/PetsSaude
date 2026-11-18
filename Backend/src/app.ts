import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import mongoose from 'mongoose';
import { corsOrigins, isProduction, isTest } from './config/env.js';
// Registra TODOS os models, inclusive os que ainda nao tem rota. Ver o
// comentario do arquivo: sem isso o syncIndexes do boot nao os enxerga.
import './db/models.js';
import { logger } from './shared/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { userRouter } from './modules/users/user.routes.js';
import { patientRouter } from './modules/patients/patient.routes.js';
import { careLinkRouter } from './modules/carelinks/careLink.routes.js';
import { deviceRouter } from './modules/devices/device.routes.js';
import { alertRouter } from './modules/telemetry/telemetry.routes.js';
import { ingestRouter } from './modules/ingest/ingest.routes.js';
import { mountDocs } from './docs/openapi.js';

/**
 * Monta a app sem abrir porta. server.ts faz o listen; os testes montam isto
 * direto no supertest. E o que permite testar a API inteira sem rede.
 */
export function createApp(): Express {
  const app = express();

  // No Render a app roda atras de proxy: sem isto, req.ip e o IP do proxy e
  // o rate limit por IP passa a limitar o mundo inteiro junto.
  if (isProduction) app.set('trust proxy', 1);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins === '*' ? true : corsOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        // Nunca logar corpo de request: ha senha em /auth/*.
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        autoLogging: { ignore: (req) => req.url === '/health' },
      }),
    );
  }

  // Limite global generoso: a protecao de verdade esta em auth.routes.ts.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: () => isTest,
    }),
  );

  // Usado tambem como keep-alive contra a hibernacao do Render.
  app.get('/health', (_req, res) => {
    const nomes: Record<number, string> = {
      0: 'desconectado',
      1: 'conectado',
      2: 'conectando',
      3: 'desconectando',
    };
    const conectado = mongoose.connection.readyState === mongoose.ConnectionStates.connected;
    const estado: number = mongoose.connection.readyState;

    // 503 com o banco fora garante que o health check do Render reinicie o
    // servico em vez de deixar a API responder erro em toda rota.
    res.status(conectado ? 200 : 503).json({
      status: conectado ? 'ok' : 'degradado',
      banco: nomes[estado] ?? 'desconhecido',
      uptimeS: Math.round(process.uptime()),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', userRouter);
  app.use('/api/patients', patientRouter);
  app.use('/api/carelinks', careLinkRouter);
  app.use('/api/devices', deviceRouter);
  app.use('/api/alerts', alertRouter);
  // Escrita de telemetria. Autentica por conta propria: aceita token de
  // aparelho (a pulseira) ou access token (o celular repassando por BLE).
  app.use('/api/ingest', ingestRouter);

  mountDocs(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
