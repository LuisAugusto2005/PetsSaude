import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { isTest } from '../config/env.js';

/**
 * Limite para as rotas de export.
 *
 * E a rota mais cara do servico: um paciente-mes de leituras sao ~1,3 milhao
 * de linhas. O stream mantem a memoria constante, mas nao a CPU - e o plano
 * free do Render da 0,1 vCPU. Sem limite, dois cliques repetidos por engano
 * tornam a API inteira lenta, inclusive a tela de alertas.
 */
export const exportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    erro: {
      codigo: 'TOO_MANY_REQUESTS',
      mensagem: 'Muitos exports em sequencia. Espere um minuto e tente de novo.',
    },
  },
  skip: () => isTest,
});

/**
 * Limite da ingestao, contado por APARELHO (ou por usuario que repassa).
 *
 * Generoso de proposito: aqui e maquina falando com maquina. O firmware manda
 * STATE a cada 2 s, ou seja 30/min por pulseira em regime normal, e um lote
 * bufferizado depois de uma queda de rede vem em rajada. Apertar isto nao
 * protege nada e perde telemetria de paciente.
 *
 * A chave nao e o IP: um hospital inteiro sai pelo mesmo NAT, e uma pulseira
 * nao deve gastar a cota das outras. Por isso roda DEPOIS do
 * authenticateIngest, que e quem resolve a identidade.
 */
export const ingestLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (req.device) return `device:${String(req.device._id)}`;
    if (req.user) return `user:${req.user.id}`;
    // Inalcancavel: o limite roda depois do authenticateIngest. Fica como
    // rede de seguranca, com ipKeyGenerator porque um /128 de IPv6 por
    // cliente deixaria o limite por IP sem efeito nenhum.
    return `ip:${ipKeyGenerator(req.ip ?? '')}`;
  },
  message: {
    erro: {
      codigo: 'TOO_MANY_REQUESTS',
      mensagem: 'Telemetria acima do limite para este aparelho. Agrupe os frames em lote.',
    },
  },
  skip: () => isTest,
});
