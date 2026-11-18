/**
 * Popula o banco com um cenario completo para desenvolvimento e demonstracao.
 *
 * Apaga e recria TODAS as colecoes do VitalWatch, por isso recusa rodar com
 * NODE_ENV=production.
 *
 * Uso: npm run seed
 */
import bcrypt from 'bcryptjs';
import type { Types } from 'mongoose';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase, syncIndexes } from '../src/db/connect.js';
import '../src/db/models.js';
import { CareLink } from '../src/modules/carelinks/careLink.model.js';
import { Device } from '../src/modules/devices/device.model.js';
import { DeviceAssignment } from '../src/modules/devices/deviceAssignment.model.js';
import { Patient } from '../src/modules/patients/patient.model.js';
import { AccessLog } from '../src/modules/audit/accessLog.model.js';
import { Alert } from '../src/modules/telemetry/alert.model.js';
import { Reading } from '../src/modules/telemetry/reading.model.js';
import { RefreshToken } from '../src/modules/auth/refreshToken.model.js';
import { User } from '../src/modules/users/user.model.js';
import {
  DEFAULT_PERMISSIONS_BY_RELATION,
  LATCHED_ALERTS,
  type AlertKey,
} from '../src/shared/types.js';

const SENHA = 'vitalwatch123';

async function main() {
  if (env.NODE_ENV === 'production') {
    throw new Error('O seed apaga dados e nao roda em producao.');
  }

  await connectDatabase();
  console.log(`Conectado em ${env.MONGODB_URI}`);

  // Num banco vazio os indices unicos parciais ainda nao existem, e o seed
  // inseriria dados que a API depois recusaria.
  await syncIndexes();

  await Promise.all([
    User.deleteMany({}),
    RefreshToken.deleteMany({}),
    Patient.deleteMany({}),
    CareLink.deleteMany({}),
    Device.deleteMany({}),
    DeviceAssignment.deleteMany({}),
    Reading.deleteMany({}),
    Alert.deleteMany({}),
    AccessLog.deleteMany({}),
  ]);
  console.log('Colecoes limpas');

  const passwordHash = await bcrypt.hash(SENHA, 12);

  // --- usuarios ---
  const [admin, carla, joana, ana, bruno, celia, denise] = await User.create([
    {
      email: 'admin@vitalwatch.local',
      passwordHash,
      name: 'Administracao VitalWatch',
      roles: ['admin'],
      status: 'active',
    },
    {
      email: 'carla@exemplo.com',
      passwordHash,
      name: 'Carla Mendes',
      phone: '+5585999990010',
      roles: ['enfermagem'],
    },
    {
      email: 'joana@exemplo.com',
      passwordHash,
      name: 'Joana Ribeiro',
      phone: '+5585999990011',
      roles: ['enfermagem'],
    },
    {
      email: 'ana@exemplo.com',
      passwordHash,
      name: 'Ana Souza',
      phone: '+5585999990001',
      roles: ['responsavel'],
    },
    {
      email: 'bruno@exemplo.com',
      passwordHash,
      name: 'Bruno Lima',
      phone: '+5585999990002',
      roles: ['responsavel'],
    },
    {
      email: 'celia@exemplo.com',
      passwordHash,
      name: 'Celia Souza',
      phone: '+5585999990003',
      roles: ['responsavel'],
    },
    // Aguardando aprovacao: e o que GET /api/users?status=pending mostra.
    // Nao recebe vinculo nem faz login enquanto nao for aprovada.
    {
      email: 'denise@exemplo.com',
      passwordHash,
      name: 'Denise Carvalho',
      phone: '+5585999990012',
      roles: ['enfermagem'],
      status: 'pending',
    },
  ]);
  if (!admin || !carla || !joana || !ana || !bruno || !celia || !denise) {
    throw new Error('Falha ao criar usuarios');
  }
  console.log('7 usuarios criados (1 admin, 2 enfermagem ativas, 1 pendente, 3 responsaveis)');

  // --- pacientes: apenas o nome, o resto vem da pulseira ---
  const [dona, seu, maria] = await Patient.create([
    { name: 'Dona Terezinha Alves', createdBy: carla._id },
    { name: 'Seu Joaquim Ferreira', createdBy: joana._id },
    { name: 'Maria das Gracas Pinto', createdBy: carla._id },
  ]);
  if (!dona || !seu || !maria) throw new Error('Falha ao criar pacientes');

  // --- vinculos ---
  const daEnfermagem = DEFAULT_PERMISSIONS_BY_RELATION.enfermagem;
  const doResponsavel = DEFAULT_PERMISSIONS_BY_RELATION.responsavel;

  await CareLink.create([
    // A enfermagem cadastrou os pacientes, logo e dona dos vinculos.
    {
      patientId: dona._id,
      caregiverId: carla._id,
      relation: 'enfermagem',
      isOwner: true,
      permissions: daEnfermagem,
      createdBy: carla._id,
    },
    {
      patientId: maria._id,
      caregiverId: carla._id,
      relation: 'enfermagem',
      isOwner: true,
      permissions: daEnfermagem,
      createdBy: carla._id,
    },
    {
      patientId: seu._id,
      caregiverId: joana._id,
      relation: 'enfermagem',
      isOwner: true,
      permissions: daEnfermagem,
      createdBy: joana._id,
    },
    // Familiares, convidados pela enfermagem. Sem manageDevice.
    {
      patientId: dona._id,
      caregiverId: ana._id,
      relation: 'responsavel',
      isOwner: false,
      permissions: doResponsavel,
      createdBy: carla._id,
    },
    {
      patientId: seu._id,
      caregiverId: bruno._id,
      relation: 'responsavel',
      isOwner: false,
      permissions: doResponsavel,
      createdBy: joana._id,
    },
    // Celia foi convidada por ANA, nao pela enfermagem: a familia se organiza
    // sozinha. O createdBy guarda a cadeia, e as permissoes sao as fixas da
    // relacao - convite de nao-dono nao escolhe permissao.
    {
      patientId: dona._id,
      caregiverId: celia._id,
      relation: 'responsavel',
      isOwner: false,
      permissions: doResponsavel,
      createdBy: ana._id,
    },
    // A mesma enfermeira acompanha paciente cadastrado pela colega: e o caso
    // que o desenho de colecoes separadas por tipo de usuario nao cobria.
    {
      patientId: seu._id,
      caregiverId: carla._id,
      relation: 'enfermagem',
      isOwner: false,
      permissions: daEnfermagem,
      createdBy: joana._id,
    },
  ]);
  console.log('3 pacientes e 7 vinculos criados');

  // --- pulseiras ---
  const agora = Date.now();
  const umDia = 24 * 60 * 60 * 1000;
  const inicioSessao = new Date(agora - 6 * 60 * 60 * 1000); // ligada ha 6h

  const [banda1, banda2, banda3] = await Device.create([
    {
      bandNumber: 1,
      deviceId: 'vitalwatch-0001',
      deviceName: 'VitalWatch1',
      firmware: '2.0.0',
      linkMode: 'espnow',
      status: 'assigned',
      batteryPct: 68,
      rssi: -54,
      lastSeenAt: new Date(agora),
      lastUptimeMs: 6 * 60 * 60 * 1000,
      currentBootAt: inicioSessao,
      ownerOrg: 'Hospital Escola',
    },
    {
      bandNumber: 2,
      deviceId: 'vitalwatch-0002',
      deviceName: 'VitalWatch2',
      firmware: '2.0.0',
      linkMode: 'espnow',
      status: 'assigned',
      batteryPct: 31,
      rssi: -71,
      lastSeenAt: new Date(agora),
      lastUptimeMs: 6 * 60 * 60 * 1000,
      currentBootAt: inicioSessao,
      ownerOrg: 'Hospital Escola',
    },
    {
      bandNumber: 3,
      deviceId: 'vitalwatch-0003',
      deviceName: 'VitalWatch3',
      firmware: '2.0.0',
      linkMode: 'wifi',
      status: 'available',
      ownerOrg: 'Hospital Escola',
      notes: 'Reserva, no carregador da enfermagem.',
    },
  ]);
  if (!banda1 || !banda2 || !banda3) throw new Error('Falha ao criar pulseiras');

  // A banda 1 esteve com Maria e depois passou para Dona Terezinha: e o
  // cenario de emprestimo que justifica o historico com intervalo.
  await DeviceAssignment.create([
    {
      deviceId: banda1._id,
      patientId: maria._id,
      assignedAt: new Date(agora - 30 * umDia),
      releasedAt: new Date(agora - 10 * umDia),
      assignedBy: carla._id,
      releasedBy: carla._id,
      notes: 'Devolvida na alta.',
    },
    {
      deviceId: banda1._id,
      patientId: dona._id,
      assignedAt: new Date(agora - 9 * umDia),
      releasedAt: null,
      assignedBy: carla._id,
    },
    {
      deviceId: banda2._id,
      patientId: seu._id,
      assignedAt: new Date(agora - 20 * umDia),
      releasedAt: null,
      assignedBy: joana._id,
    },
  ]);
  console.log('3 pulseiras e 3 periodos de emprestimo criados');

  // --- telemetria ---
  const leituras = [
    ...gerarLeituras(banda1._id, dona._id, inicioSessao, 100, 68),
    ...gerarLeituras(banda2._id, seu._id, inicioSessao, 100, 31),
  ];
  await Reading.insertMany(leituras);
  console.log(`${leituras.length} leituras geradas`);

  // Um alerta de cada tipo, incluindo uma queda critica AINDA NAO reconhecida:
  // e o estado que a tela inicial do app precisa saber desenhar.
  await Alert.create([
    alerta(banda1._id, dona._id, inicioSessao, 'fall', 'critical', 'Queda detectada', {
      sinceUptimeMs: 5 * 60 * 60 * 1000,
      minutosAtras: 42,
      status: 'active',
    }),
    alerta(banda1._id, dona._id, inicioSessao, 'panic', 'critical', 'Pedido de ajuda (3 toques)', {
      sinceUptimeMs: 2 * 60 * 60 * 1000,
      minutosAtras: 240,
      status: 'acknowledged',
      acknowledgedBy: carla._id,
    }),
    alerta(banda2._id, seu._id, inicioSessao, 'tremor', 'warn', 'Tremor ritmado por 38 s', {
      sinceUptimeMs: 4 * 60 * 60 * 1000,
      minutosAtras: 110,
      status: 'normalized',
    }),
    alerta(
      banda2._id,
      seu._id,
      inicioSessao,
      'odd_motion',
      'warn',
      'Movimento muito acima do normal do paciente',
      { sinceUptimeMs: 60 * 60 * 1000, minutosAtras: 300, status: 'normalized' },
    ),
  ]);
  console.log('4 alertas criados (1 queda critica em aberto, 1 panico reconhecido pela carla)');

  console.log('\n--- credenciais ---');
  console.log(`senha de todos: ${SENHA}`);
  console.log('  admin@vitalwatch.local  admin');
  console.log('  carla@exemplo.com       enfermagem (dona de Terezinha e Maria)');
  console.log('  joana@exemplo.com       enfermagem (dona de Joaquim)');
  console.log('  ana@exemplo.com         responsavel (familiar de Terezinha)');
  console.log('  bruno@exemplo.com       responsavel (familiar de Joaquim)');
  console.log('  celia@exemplo.com       responsavel (convidada por ana, nao pela enfermagem)');
  console.log('  denise@exemplo.com      enfermagem PENDENTE (login da 403 ACCOUNT_PENDING)');
  console.log('\nTeste de isolamento: logue como ana e tente abrir o Seu');
  console.log('Joaquim por GET /api/patients/<id>. Deve dar 404.');
  console.log('\nFila de aprovacao: logue como admin e veja');
  console.log('GET /api/users?status=pending, depois POST /api/users/<id>/approve.');
  console.log('\nHistorico e export: como carla, veja');
  console.log('  GET /api/patients/<id>/history      quem fez o que, e quando');
  console.log('  GET /api/patients/<id>/readings     telemetria paginada');
  console.log('  GET /api/patients/<id>/export?format=csv&type=readings');
  console.log(
    '  GET /api/patients/<id>/access-log   quem leu os dados (depois dos acessos acima)\n',
  );
}

/** Gera uma serie plausivel, com a postura mudando ao longo das horas. */
function gerarLeituras(
  deviceId: Types.ObjectId,
  patientId: Types.ObjectId,
  bootAt: Date,
  quantidade: number,
  bateriaInicial: number,
) {
  const posturas = ['lying', 'sitting', 'standing', 'moving'] as const;
  const movimentos = ['rest', 'light', 'walking'] as const;
  const intervaloMs = 3 * 60 * 1000; // 3 min entre amostras no seed

  return Array.from({ length: quantidade }, (_, i) => {
    const uptimeMs = i * intervaloMs;
    const postura = posturas[Math.floor(i / 25) % posturas.length] ?? 'unknown';
    const movimento = movimentos[i % movimentos.length] ?? 'unknown';
    return {
      deviceId,
      patientId,
      bootAt,
      receivedAt: new Date(bootAt.getTime() + uptimeMs),
      uptimeMs,
      posture: {
        id: postura,
        inclination: postura === 'lying' ? 82 : postura === 'sitting' ? 44 : 8,
        stable: true,
      },
      movement: {
        class: movimento,
        energy: movimento === 'rest' ? 0.04 : movimento === 'light' ? 0.22 : 0.61,
        tremor: false,
        tremorFreq: 0,
        tremorS: 0,
        odd: false,
      },
      fall: { detected: false, simulated: false, phase: null, count: 0 },
      panic: { active: false, count: 0 },
      // Bateria caindo devagar: ~40 mA numa celula de 400 mAh da cerca de 8 h.
      batteryPct: Math.max(5, Math.round(bateriaInicial - (i / quantidade) * 12)),
      rssi: -50 - (i % 25),
      source: 'seed' as const,
    };
  });
}

function alerta(
  deviceId: Types.ObjectId,
  patientId: Types.ObjectId,
  bootAt: Date,
  alertKey: AlertKey,
  level: 'critical' | 'warn',
  detail: string,
  opts: {
    sinceUptimeMs: number;
    minutosAtras: number;
    status: 'active' | 'normalized' | 'acknowledged';
    acknowledgedBy?: Types.ObjectId;
  },
) {
  const primeiro = new Date(Date.now() - opts.minutosAtras * 60 * 1000);
  return {
    deviceId,
    patientId,
    bootAt,
    alertKey,
    level,
    detail,
    sinceUptimeMs: opts.sinceUptimeMs,
    firstSeenAt: primeiro,
    lastSeenAt: new Date(primeiro.getTime() + 60 * 1000),
    status: opts.status,
    isLatched: LATCHED_ALERTS.includes(alertKey),
    acknowledgedAt: opts.status === 'acknowledged' ? new Date(primeiro.getTime() + 95_000) : null,
    acknowledgedBy: opts.acknowledgedBy ?? null,
    acknowledgedVia: opts.status === 'acknowledged' ? ('app' as const) : null,
  };
}

main()
  .then(() => disconnectDatabase())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await mongoose.connection.close().catch(() => undefined);
    process.exit(1);
  });
