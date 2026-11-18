import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
// z vem de shared/zod.js, que ja aplicou o extendZodWithOpenApi. Ver o
// comentario daquele modulo: a ordem importa no Zod 4.
import { z } from '../shared/zod.js';

import {
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
} from '../modules/auth/auth.schemas.js';
import { listUsersSchema, updateMeSchema } from '../modules/users/user.schemas.js';
import { listAlertsSchema, listReadingsSchema } from '../modules/telemetry/telemetry.schemas.js';
import { exportPatientSchema } from '../modules/exports/export.schemas.js';
import {
  createPatientSchema,
  listPatientsSchema,
  updatePatientSchema,
} from '../modules/patients/patient.schemas.js';
import {
  createCareLinkSchema,
  updateCareLinkSchema,
} from '../modules/carelinks/careLink.schemas.js';
import {
  assignDeviceSchema,
  createDeviceSchema,
  releaseDeviceSchema,
  updateDeviceSchema,
} from '../modules/devices/device.schemas.js';
import { firmwareTelemetrySchema } from '../modules/telemetry/telemetry.schemas.js';
import { logger } from '../shared/logger.js';

const registry = new OpenAPIRegistry();

const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

const erroSchema = registry.register(
  'Erro',
  z.object({
    erro: z.object({
      codigo: z.string(),
      mensagem: z.string(),
      detalhes: z.unknown().optional(),
    }),
  }),
);

const tokenPairSchema = registry.register(
  'ParDeTokens',
  z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.number().int(),
  }),
);

/** Registra os schemas de entrada para aparecerem em #/components/schemas. */
registry.register('RegistroEntrada', registerSchema);
registry.register('LoginEntrada', loginSchema);
registry.register('RefreshEntrada', refreshSchema);
registry.register('LogoutEntrada', logoutSchema);
registry.register('AtualizarMeuPerfilEntrada', updateMeSchema);
registry.register('CriarPacienteEntrada', createPatientSchema);
registry.register('AtualizarPacienteEntrada', updatePatientSchema);
registry.register('CriarVinculoEntrada', createCareLinkSchema);
registry.register('AtualizarVinculoEntrada', updateCareLinkSchema);
registry.register('CriarPulseiraEntrada', createDeviceSchema);
registry.register('AtualizarPulseiraEntrada', updateDeviceSchema);
registry.register('AtribuirPulseiraEntrada', assignDeviceSchema);
registry.register('LiberarPulseiraEntrada', releaseDeviceSchema);
/**
 * Registrado ainda sem rota: e o contrato do frame do firmware, que a equipe
 * do app e a do embarcado precisam ver antes de existir ingestao.
 */
registry.register('TelemetriaDoFirmware', firmwareTelemetrySchema);

const respostaErro = (descricao: string) => ({
  description: descricao,
  content: { 'application/json': { schema: erroSchema } },
});

function rotaJson(config: {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  body?: z.ZodType;
  // O registry exige um objeto para query/params, porque cada chave vira um
  // parametro separado no documento OpenAPI.
  query?: z.ZodObject;
  params?: z.ZodObject;
  protegida?: boolean;
  respostas: Record<number, { description: string; schema?: z.ZodType }>;
}) {
  registry.registerPath({
    method: config.method,
    path: config.path,
    tags: config.tags,
    summary: config.summary,
    description: config.description,
    ...(config.protegida ? { security: [{ [bearerAuth.name]: [] }] } : {}),
    request: {
      ...(config.body
        ? { body: { content: { 'application/json': { schema: config.body } } } }
        : {}),
      ...(config.query ? { query: config.query } : {}),
      ...(config.params ? { params: config.params } : {}),
    },
    responses: {
      ...Object.fromEntries(
        Object.entries(config.respostas).map(([codigo, r]) => [
          codigo,
          r.schema
            ? { description: r.description, content: { 'application/json': { schema: r.schema } } }
            : { description: r.description },
        ]),
      ),
      400: respostaErro('Dados invalidos'),
      401: respostaErro('Nao autenticado'),
      403: respostaErro('Sem permissao'),
      404: respostaErro('Nao encontrado'),
      409: respostaErro('Conflito'),
    },
  });
}

const idParam = z.object({ id: z.string() });
/** Paginacao, so para o documento: redeclarada para nao arrastar coerce. */
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// --- auth ---
rotaJson({
  method: 'post',
  path: '/api/auth/register',
  tags: ['Autenticacao'],
  summary: 'Cadastra um responsavel ou membro da enfermagem',
  description:
    'Pede e-mail, senha, nome e papel - nada mais. O papel "admin" nao pode ser pedido aqui: admins nascem pelo seed ou por BOOTSTRAP_ADMIN_EMAIL. ATENCAO ao status da resposta: responsavel recebe 201 com os tokens e entra na hora; enfermagem recebe 202 SEM token, porque a conta nasce pendente e um admin precisa aprovar.',
  body: registerSchema,
  respostas: {
    201: { description: 'Criado e autenticado (responsavel)', schema: tokenPairSchema },
    202: { description: 'Criado, aguardando aprovacao (enfermagem): resposta sem token' },
  },
});
rotaJson({
  method: 'post',
  path: '/api/auth/login',
  tags: ['Autenticacao'],
  summary: 'Autentica e devolve o par de tokens',
  description:
    'Erros de conta vem com codigo proprio no envelope: ACCOUNT_PENDING (aguardando aprovacao) e ACCOUNT_DISABLED (desativada), ambos 403. Senha errada continua 401. Nao mostre "senha incorreta" para 403.',
  body: loginSchema,
  respostas: {
    200: { description: 'Autenticado', schema: tokenPairSchema },
    401: { description: 'E-mail ou senha incorretos' },
    403: { description: 'ACCOUNT_PENDING ou ACCOUNT_DISABLED' },
  },
});
rotaJson({
  method: 'post',
  path: '/api/auth/refresh',
  tags: ['Autenticacao'],
  summary: 'Troca o refresh token por um par novo',
  description:
    'O refresh token e rotativo e de uso unico. Reapresentar um token ja usado revoga todas as sessoes do usuario.',
  body: refreshSchema,
  respostas: { 200: { description: 'Renovado', schema: tokenPairSchema } },
});
rotaJson({
  method: 'post',
  path: '/api/auth/logout',
  tags: ['Autenticacao'],
  summary: 'Revoga a sessao atual ou todas',
  body: logoutSchema,
  protegida: true,
  respostas: { 204: { description: 'Sessao encerrada' } },
});

// --- usuarios ---
rotaJson({
  method: 'get',
  path: '/api/users/me',
  tags: ['Usuarios'],
  summary: 'Dados do usuario autenticado',
  protegida: true,
  respostas: { 200: { description: 'Perfil' } },
});
rotaJson({
  method: 'patch',
  path: '/api/users/me',
  tags: ['Usuarios'],
  summary: 'Atualiza o proprio perfil',
  body: updateMeSchema,
  protegida: true,
  respostas: { 200: { description: 'Perfil atualizado' } },
});

rotaJson({
  method: 'get',
  path: '/api/users',
  tags: ['Usuarios'],
  summary: 'Lista e busca usuarios (admin)',
  description:
    'A fila de aprovacao e GET /api/users?status=pending. Filtra tambem por role e por q (nome ou e-mail). Mais antigo primeiro: quem esperou mais aparece no topo.',
  query: listUsersSchema,
  protegida: true,
  respostas: { 200: { description: 'Lista paginada' } },
});
rotaJson({
  method: 'get',
  path: '/api/users/me/export',
  tags: ['Usuarios'],
  summary: 'Exporta os proprios dados (LGPD art. 18)',
  description:
    'Cadastro, vinculos e a propria trilha de acesso, em JSON. Nao inclui senha (so existe o hash bcrypt) nem telemetria: os dados da pulseira sao do PACIENTE e saem por GET /api/patients/{id}/export.',
  protegida: true,
  respostas: { 200: { description: 'Os proprios dados' } },
});
rotaJson({
  method: 'post',
  path: '/api/users/{id}/approve',
  tags: ['Usuarios'],
  summary: 'Libera a conta (admin)',
  description:
    'Aprova quem estava pendente e religa quem foi desativado - e o unico caminho de volta. Idempotente.',
  params: idParam,
  protegida: true,
  respostas: { 200: { description: 'Conta ativa' } },
});
rotaJson({
  method: 'post',
  path: '/api/users/{id}/disable',
  tags: ['Usuarios'],
  summary: 'Desativa a conta (admin)',
  description:
    'Revoga os refresh tokens no mesmo passo. O access token ja emitido continua valido ate expirar (15 min). Nao apaga o usuario: ele aparece em createdBy e em alertas reconhecidos. Recusa desativar a propria conta e o ultimo admin ativo.',
  params: idParam,
  protegida: true,
  respostas: {
    200: { description: 'Conta desativada' },
    400: { description: 'Ultimo admin ou propria conta' },
  },
});

// --- telemetria e historico ---
rotaJson({
  method: 'get',
  path: '/api/patients/{id}/readings',
  tags: ['Telemetria'],
  summary: 'Historico de leituras do paciente',
  description:
    'Exige a permissao viewHistory no vinculo. from/to sao hora de SERVIDOR (receivedAt), nunca uptime - uptime zera no reboot da pulseira. Leituras expiram 30 dias apos a coleta (TTL). Este acesso entra na trilha de auditoria.',
  params: idParam,
  query: listReadingsSchema,
  protegida: true,
  respostas: { 200: { description: 'Leituras, da mais recente para a mais antiga' } },
});
rotaJson({
  method: 'get',
  path: '/api/patients/{id}/alerts',
  tags: ['Telemetria'],
  summary: 'Alertas do paciente',
  description:
    'Filtre status=active para a tela inicial. panic e fall sao latched: so saem de active por reconhecimento. Alertas NAO expiram. Este acesso entra na trilha de auditoria.',
  params: idParam,
  query: listAlertsSchema,
  protegida: true,
  respostas: { 200: { description: 'Ocorrencias de alerta' } },
});
rotaJson({
  method: 'post',
  path: '/api/alerts/{id}/acknowledge',
  tags: ['Telemetria'],
  summary: 'Reconhece um alerta',
  description:
    'Assina quem atendeu e tira o alerta da lista de ativos. Exige a permissao acknowledgeAlerts no vinculo: a enfermagem nasce com ela, o responsavel nao (configuravel pelo vinculo dono). Idempotente. LIMITE IMPORTANTE: nao chega a pulseira - panic e fall continuam acesos no aparelho e no painel do gateway, porque nao existe canal de descida. A propagacao entra com a ingestao.',
  params: idParam,
  protegida: true,
  respostas: { 200: { description: 'Alerta reconhecido' } },
});
rotaJson({
  method: 'get',
  path: '/api/patients/{id}/history',
  tags: ['Telemetria'],
  summary: 'Linha do tempo do que foi feito com o paciente',
  description:
    'Cadastro, vinculos criados e revogados, pulseira atribuida e liberada, alertas reconhecidos - com quem fez cada coisa. Montada dos campos que cada acao ja grava, sem colecao de eventos paralela.',
  params: idParam,
  query: paginationSchema,
  protegida: true,
  respostas: { 200: { description: 'Eventos, do mais recente ao mais antigo' } },
});
rotaJson({
  method: 'get',
  path: '/api/patients/{id}/access-log',
  tags: ['Telemetria'],
  summary: 'Quem leu os dados deste paciente (vinculo dono)',
  description:
    'Trilha de acesso da LGPD. Registra acesso pesado - abrir historico, abrir alertas, exportar, e ler esta propria trilha. NAO registra GET /patients/{id}, que so tem o nome e e a tela que mais recarrega.',
  params: idParam,
  query: paginationSchema,
  protegida: true,
  respostas: { 200: { description: 'Acessos, do mais recente ao mais antigo' } },
});
rotaJson({
  method: 'get',
  path: '/api/patients/{id}/export',
  tags: ['Telemetria'],
  summary: 'Exporta os dados da pulseira do paciente',
  description:
    'Resposta em STREAM, com Content-Disposition de anexo - nao e JSON para consumir em tela. CSV abre no Excel (com BOM) e comporta uma tabela: use type=readings ou type=alerts. JSON com type=all traz meta, periodos de uso, alertas e leituras. Medido: 320 mil linhas saem em 38 MB com a memoria do processo praticamente constante. Limitado a 5 pedidos por minuto. Este acesso entra na trilha de auditoria, com o volume exportado.',
  params: idParam,
  query: exportPatientSchema,
  protegida: true,
  respostas: { 200: { description: 'Arquivo CSV ou JSON' } },
});

// --- pacientes ---
rotaJson({
  method: 'post',
  path: '/api/patients',
  tags: ['Pacientes'],
  summary: 'Cadastra um paciente',
  description:
    'Cria tambem o vinculo DONO de quem cadastrou. Sem esse vinculo o paciente seria invisivel, ja que toda leitura passa por CareLink.',
  body: createPatientSchema,
  protegida: true,
  respostas: { 201: { description: 'Criado' } },
});
rotaJson({
  method: 'get',
  path: '/api/patients',
  tags: ['Pacientes'],
  summary: 'Lista os pacientes com vinculo ativo',
  query: listPatientsSchema,
  protegida: true,
  respostas: { 200: { description: 'Lista paginada' } },
});
rotaJson({
  method: 'get',
  path: '/api/patients/{id}',
  tags: ['Pacientes'],
  summary: 'Detalhe de um paciente',
  description:
    'Exige vinculo ativo com ESTE paciente. Ter papel de medico nao da acesso a paciente de outro medico. Sem vinculo a resposta e 404, nao 403, para nao permitir enumerar a base.',
  params: idParam,
  protegida: true,
  respostas: { 200: { description: 'Paciente' } },
});
rotaJson({
  method: 'patch',
  path: '/api/patients/{id}',
  tags: ['Pacientes'],
  summary: 'Atualiza um paciente',
  params: idParam,
  body: updatePatientSchema,
  protegida: true,
  respostas: { 200: { description: 'Atualizado' } },
});

// --- vinculos ---
rotaJson({
  method: 'post',
  path: '/api/patients/{id}/carelinks',
  tags: ['Vinculos'],
  summary: 'Vincula um cuidador ao paciente',
  description:
    'O vinculo dono (enfermagem) e o admin podem criar qualquer relacao. Um responsavel vinculado pode convidar apenas outro responsavel, para o mesmo paciente, com teto de 5 responsaveis ativos (409 ao estourar). Convite feito por nao-dono IGNORA o campo permissions e usa os padroes da relacao. Identifique o cuidador por e-mail ou id.',
  params: idParam,
  body: createCareLinkSchema,
  protegida: true,
  respostas: { 201: { description: 'Vinculado' } },
});
rotaJson({
  method: 'get',
  path: '/api/patients/{id}/carelinks',
  tags: ['Vinculos'],
  summary: 'Lista quem cuida do paciente',
  description:
    'E a consulta do fan-out de alerta: quem avisar quando a pulseira dispara. Filtre por permissions.receiveAlerts.',
  params: idParam,
  protegida: true,
  respostas: { 200: { description: 'Lista de vinculos' } },
});
rotaJson({
  method: 'patch',
  path: '/api/carelinks/{id}',
  tags: ['Vinculos'],
  summary: 'Altera as permissoes de um vinculo',
  params: idParam,
  body: updateCareLinkSchema,
  protegida: true,
  respostas: { 200: { description: 'Atualizado' } },
});
rotaJson({
  method: 'delete',
  path: '/api/carelinks/{id}',
  tags: ['Vinculos'],
  summary: 'Revoga um vinculo',
  description:
    'Revoga, nao apaga: o historico de quem teve acesso a dado de saude e exatamente o que uma auditoria pede.',
  params: idParam,
  protegida: true,
  respostas: { 204: { description: 'Revogado' } },
});

// --- pulseiras ---
rotaJson({
  method: 'post',
  path: '/api/devices',
  tags: ['Pulseiras'],
  summary: 'Cadastra uma pulseira (admin)',
  body: createDeviceSchema,
  protegida: true,
  respostas: { 201: { description: 'Criada' } },
});
rotaJson({
  method: 'get',
  path: '/api/devices',
  tags: ['Pulseiras'],
  summary: 'Lista pulseiras visiveis para o usuario',
  protegida: true,
  respostas: { 200: { description: 'Lista paginada' } },
});
rotaJson({
  method: 'patch',
  path: '/api/devices/{id}',
  tags: ['Pulseiras'],
  summary: 'Atualiza uma pulseira (admin)',
  params: idParam,
  body: updateDeviceSchema,
  protegida: true,
  respostas: { 200: { description: 'Atualizada' } },
});
rotaJson({
  method: 'post',
  path: '/api/devices/{id}/assign',
  tags: ['Pulseiras'],
  summary: 'Atribui a pulseira a um paciente',
  description:
    'Fecha o periodo anterior e abre um novo, de forma atomica. A pulseira e do hospital e passa de paciente para paciente, por isso o vinculo tem intervalo de validade.',
  params: idParam,
  body: assignDeviceSchema,
  protegida: true,
  respostas: { 201: { description: 'Atribuida' } },
});
rotaJson({
  method: 'post',
  path: '/api/devices/{id}/release',
  tags: ['Pulseiras'],
  summary: 'Libera a pulseira do paciente atual',
  description:
    'Com revokeResponsaveis: true, revoga no mesmo passo todos os responsaveis do paciente - tirar a pulseira E a alta na pratica. Exige papel de enfermagem ou admin para usar a flag. A resposta inclui responsaveisRevogados (null quando a flag nao foi usada).',
  params: idParam,
  body: releaseDeviceSchema,
  protegida: true,
  respostas: { 200: { description: 'Liberada' } },
});
rotaJson({
  method: 'post',
  path: '/api/devices/{id}/revoke-responsaveis',
  tags: ['Pulseiras'],
  summary: 'Revoga todos os responsaveis do paciente desta pulseira (enfermagem/admin)',
  description:
    'Higiene de alta: a pulseira passa de paciente para paciente e a familia anterior nao tem o que receber alerta da proxima pessoa. Usa o ULTIMO periodo de uso, nao so o aberto. Nao toca em vinculos de enfermagem nem em patient.isActive.',
  params: idParam,
  protegida: true,
  respostas: { 200: { description: 'Quantos vinculos foram revogados' } },
});
rotaJson({
  method: 'get',
  path: '/api/devices/{id}/assignments',
  tags: ['Pulseiras'],
  summary: 'Historico de emprestimo da pulseira',
  description:
    'Responde "de quem era esta queda?" meses depois. Os periodos nao se sobrepoem, garantido por indice unico parcial.',
  params: idParam,
  protegida: true,
  respostas: { 200: { description: 'Periodos de uso' } },
});

// --- Ingestao -------------------------------------------------------------

rotaJson({
  method: 'post',
  path: '/api/ingest/telemetry',
  tags: ['Ingestao'],
  summary: 'Recebe telemetria da pulseira (token de aparelho OU token de usuario)',
  description: [
    'A unica rota de ESCRITA de telemetria. Aceita um frame do firmware ou um',
    'lote deles, em ordem cronologica.',
    '',
    'Duas credenciais, de proposito: o transporte da pulseira ate aqui ainda',
    'nao foi decidido. Com Authorization: Bearer vwd_... e a propria pulseira',
    'falando por wifi (source "direct"); com um access token de usuario e o',
    'celular repassando o que recebeu por BLE (source "app"), e nesse caso',
    'exige vinculo ativo com o paciente da pulseira.',
    '',
    'De quem e o dado NAO vem no frame: o servidor resolve o paciente pelo',
    'DeviceAssignment aberto no momento da chegada e grava o patientId na',
    'leitura. Corrigir uma atribuicao depois nao reescreve o passado. Sem',
    'atribuicao aberta, a leitura e guardada com patientId nulo.',
    '',
    'Idempotente: receber o mesmo frame duas vezes, ou pelos dois caminhos,',
    'nao duplica nada - o indice unico {deviceId, bootAt, uptimeMs} resolve.',
    'Por isso a resposta separa "gravadas" de "duplicadas".',
    '',
    'Amostragem: nem todo frame vira leitura. Grava uma por minuto mais toda',
    'mudanca de postura, movimento, queda, panico, nivel de alerta ou ligada.',
    'ALERTAS nunca sao amostrados.',
  ].join('\n'),
  body: firmwareTelemetrySchema,
  respostas: {
    202: {
      description:
        'Lote aceito. O corpo diz quantas leituras foram gravadas, quantas eram reentrega e quantas a amostragem descartou - e o que o firmware precisa para limpar o buffer.',
    },
  },
});

rotaJson({
  method: 'post',
  path: '/api/devices/{id}/ingest-token',
  tags: ['Pulseiras'],
  summary: 'Emite o token de ingestao do aparelho (admin)',
  description:
    'Devolve o segredo UMA vez: o banco guarda apenas o SHA-256. Emitir de novo rotaciona e invalida o anterior, que e como se tira de operacao uma pulseira perdida sem apagar o aparelho e levar o historico de emprestimo junto.',
  params: idParam,
  protegida: true,
  respostas: { 201: { description: 'O token em claro, visivel so nesta resposta' } },
});

rotaJson({
  method: 'delete',
  path: '/api/devices/{id}/ingest-token',
  tags: ['Pulseiras'],
  summary: 'Revoga o token de ingestao do aparelho (admin)',
  description: 'A pulseira para de conseguir enviar na hora. O aparelho e seu historico ficam.',
  params: idParam,
  protegida: true,
  respostas: { 200: { description: 'Token revogado' } },
});

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'VitalWatch API',
      version: '0.1.0',
      description: [
        'Backend de identidade, autorizacao e historico do VitalWatch.',
        '',
        'Regra invariavel de autorizacao: o PAPEL diz o que o usuario pode fazer,',
        'o VINCULO (CareLink) diz para quem. Nenhuma rota de paciente decide',
        'apenas pelo papel.',
        '',
        'A pulseira NAO mede batimento cardiaco nem SpO2: o sensor foi testado e',
        'abandonado. Os alertas sao quatro: panic, fall, tremor e odd_motion.',
        'panic e fall sao criticos e ficam acesos ate alguem reconhecer.',
        '',
        'Esta e uma ferramenta de APOIO a enfermagem, nao substituto do',
        'prontuario: o paciente tem apenas nome. Idade, quarto e contato vem da',
        'pulseira em cada frame de telemetria.',
        '',
        'A pulseira tambem nao tem relogio. Todos os campos *_ms do firmware sao',
        'uptime e zeram no reboot; a hora confiavel e o receivedAt do servidor.',
        '',
        'A telemetria entra por POST /api/ingest/telemetry, que aceita o mesmo',
        'frame vindo da pulseira por wifi ou repassado pelo celular por BLE -',
        'o transporte ainda nao foi decidido, e a rota nao tem opiniao sobre',
        'isso. Ver docs/contrato-firmware.md.',
      ].join('\n'),
    },
    servers: [{ url: 'http://localhost:3000', description: 'Desenvolvimento' }],
    tags: [
      { name: 'Autenticacao' },
      { name: 'Usuarios' },
      { name: 'Pacientes' },
      { name: 'Vinculos' },
      { name: 'Pulseiras' },
      { name: 'Ingestao' },
    ],
  });
}

/** Monta /docs (Swagger UI) e /docs.json (o documento cru). */
export function mountDocs(app: Express): void {
  let documento: ReturnType<typeof buildOpenApiDocument>;
  try {
    documento = buildOpenApiDocument();
  } catch (err) {
    // Documentacao quebrada nao pode derrubar a API.
    logger.error({ err }, 'Falha ao gerar o documento OpenAPI; /docs ficou indisponivel');
    return;
  }

  app.get('/docs.json', (_req, res) => res.json(documento));
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(documento, { customSiteTitle: 'VitalWatch API' }),
  );
}
