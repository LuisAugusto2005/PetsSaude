import { randomBytes } from 'node:crypto';
import type mongoose from 'mongoose';
import { Types } from 'mongoose';
import { AppError } from '../../shared/AppError.js';
import {
  PREFIXO_TOKEN_DE_APARELHO,
  hashDoTokenDeAparelho,
} from '../../middleware/authenticateIngest.js';
import { withOptionalTransaction } from '../../shared/transaction.js';
import { populado, type AuthenticatedUser } from '../../shared/types.js';
import { paginated } from '../../shared/validation.js';
import { CareLink } from '../carelinks/careLink.model.js';
import { revokeResponsaveisDoPaciente } from '../carelinks/careLink.service.js';
import { Patient } from '../patients/patient.model.js';
import { Device, type DeviceDoc } from './device.model.js';
import { DeviceAssignment, type DeviceAssignmentDoc } from './deviceAssignment.model.js';
import type {
  AssignDeviceInput,
  CreateDeviceInput,
  ListDevicesQuery,
  ReleaseDeviceInput,
  UpdateDeviceInput,
} from './device.schemas.js';

export async function createDevice(input: CreateDeviceInput): Promise<DeviceDoc> {
  return Device.create(input);
}

export async function updateDevice(deviceId: string, input: UpdateDeviceInput): Promise<DeviceDoc> {
  const device = await Device.findById(deviceId);
  if (!device) throw AppError.notFound('Pulseira nao encontrada');

  // 'assigned' nao e definido a mao: ele e consequencia do assignment aberto.
  if (input.status && input.status !== 'available') {
    const aberto = await DeviceAssignment.exists({ deviceId: device._id, releasedAt: null });
    if (aberto) {
      throw AppError.conflict(
        'Libere a pulseira do paciente antes de marca-la como manutencao ou baixa',
      );
    }
  }

  Object.assign(device, input);
  await device.save();
  return device;
}

/**
 * Lista pulseiras. Admin ve o parque inteiro; os demais veem apenas as
 * atribuidas aos pacientes com quem tem vinculo ativo, mais nada.
 */
export async function listDevices(actor: AuthenticatedUser, query: ListDevicesQuery) {
  const filtro: mongoose.FilterQuery<unknown> = {};
  if (query.status) filtro.status = query.status;

  if (!actor.roles.includes('admin')) {
    const links = await CareLink.find({
      caregiverId: new Types.ObjectId(actor.id),
      status: 'active',
    }).select('patientId');
    const patientIds = links.map((l) => l.patientId);

    if (patientIds.length === 0) return paginated([], 0, query);

    const assignments = await DeviceAssignment.find({
      patientId: { $in: patientIds },
      releasedAt: null,
    }).select('deviceId');
    const deviceIds = assignments.map((a) => a.deviceId);

    if (deviceIds.length === 0) return paginated([], 0, query);
    filtro._id = { $in: deviceIds };
  }

  const skip = (query.page - 1) * query.limit;
  const [devices, total] = await Promise.all([
    Device.find(filtro).sort({ bandNumber: 1 }).skip(skip).limit(query.limit),
    Device.countDocuments(filtro),
  ]);

  // Anexa o paciente atual de cada pulseira, que e o que a tela quer mostrar.
  const abertos = await DeviceAssignment.find({
    deviceId: { $in: devices.map((d) => d._id) },
    releasedAt: null,
  }).populate<{ patientId: { _id: Types.ObjectId; name: string } }>('patientId', 'name');

  const porDevice = new Map(abertos.map((a) => [String(a.deviceId), a]));

  return paginated(
    devices.map((d) => {
      const atual = porDevice.get(String(d._id));
      const paciente = atual?.patientId;
      return {
        ...d.toJSON(),
        pacienteAtual: paciente ? { id: paciente._id, nome: paciente.name } : null,
      };
    }),
    total,
    query,
  );
}

export async function getDevice(deviceId: string): Promise<DeviceDoc> {
  const device = await Device.findById(deviceId);
  if (!device) throw AppError.notFound('Pulseira nao encontrada');
  return device;
}

/**
 * Pode ver a pulseira quem e admin, ou quem tem vinculo ativo com algum
 * paciente que a usa OU ja usou. O historico de emprestimo inclui periodos
 * antigos, entao a checagem olha todos os assignments, nao so o aberto.
 */
export async function assertPodeVerDevice(
  deviceId: string,
  actor: AuthenticatedUser,
): Promise<void> {
  if (actor.roles.includes('admin')) return;

  const links = await CareLink.find({
    caregiverId: new Types.ObjectId(actor.id),
    status: 'active',
  }).select('patientId');
  if (links.length === 0) throw AppError.notFound('Pulseira nao encontrada');

  const temAcesso = await DeviceAssignment.exists({
    deviceId: new Types.ObjectId(deviceId),
    patientId: { $in: links.map((l) => l.patientId) },
  });
  if (!temAcesso) throw AppError.notFound('Pulseira nao encontrada');
}

/**
 * Atribui a pulseira a um paciente, fechando a atribuicao anterior no mesmo
 * passo. A troca precisa ser atomica: se o fechamento acontecesse sem a
 * abertura, a pulseira ficaria orfa e a telemetria chegaria sem paciente.
 */
export async function assignDevice(
  deviceId: string,
  actor: AuthenticatedUser,
  input: AssignDeviceInput,
): Promise<DeviceAssignmentDoc> {
  const device = await Device.findById(deviceId);
  if (!device) throw AppError.notFound('Pulseira nao encontrada');
  if (device.status === 'retired') {
    throw AppError.conflict('Esta pulseira esta baixada e nao pode ser atribuida');
  }
  if (device.status === 'maintenance') {
    throw AppError.conflict('Esta pulseira esta em manutencao');
  }

  const patientId = new Types.ObjectId(input.patientId);
  const patient = await Patient.findById(patientId);
  if (!patient) throw AppError.notFound('Paciente nao encontrado');
  if (!patient.isActive) throw AppError.badRequest('Paciente inativo');

  await assertPodeGerenciarPulseiraDoPaciente(patientId, actor);

  const abertoDesteDevice = await DeviceAssignment.findOne({
    deviceId: device._id,
    releasedAt: null,
  });
  // Idempotente: reatribuir ao mesmo paciente nao cria um periodo novo.
  if (abertoDesteDevice?.patientId.equals(patientId)) {
    return abertoDesteDevice;
  }

  // A pulseira que o paciente usava antes, se for outra, volta ao estoque.
  const abertoDoPaciente = await DeviceAssignment.findOne({
    patientId,
    releasedAt: null,
    deviceId: { $ne: device._id },
  });

  return withOptionalTransaction(async (s) => {
    const agora = new Date();
    const releasedBy = new Types.ObjectId(actor.id);
    const opts = s ? { session: s } : {};

    // Fecha tudo que estava aberto, desta pulseira e deste paciente. Os dois
    // indices unicos parciais (um por deviceId, um por patientId) barrariam a
    // insercao abaixo se sobrasse qualquer periodo em aberto.
    await DeviceAssignment.updateMany(
      { releasedAt: null, $or: [{ deviceId: device._id }, { patientId }] },
      { $set: { releasedAt: agora, releasedBy } },
      opts,
    );

    const [novo] = await DeviceAssignment.create(
      [
        {
          deviceId: device._id,
          patientId,
          assignedAt: agora,
          assignedBy: new Types.ObjectId(actor.id),
          notes: input.notes,
        },
      ],
      opts,
    );
    if (!novo) throw new Error('Falha ao criar atribuicao');

    await Device.updateOne({ _id: device._id }, { $set: { status: 'assigned' } }, opts);
    if (abertoDoPaciente) {
      await Device.updateOne(
        { _id: abertoDoPaciente.deviceId },
        { $set: { status: 'available' } },
        opts,
      );
    }

    return novo;
  });
}

export interface ReleaseResult {
  assignment: DeviceAssignmentDoc;
  /** Null quando a limpeza nao foi pedida; numero de vinculos revogados quando foi. */
  responsaveisRevogados: number | null;
}

export async function releaseDevice(
  deviceId: string,
  actor: AuthenticatedUser,
  input: ReleaseDeviceInput,
): Promise<ReleaseResult> {
  const device = await Device.findById(deviceId);
  if (!device) throw AppError.notFound('Pulseira nao encontrada');

  const aberto = await DeviceAssignment.findOne({ deviceId: device._id, releasedAt: null });
  if (!aberto) throw AppError.conflict('Esta pulseira nao esta atribuida a ninguem');

  await assertPodeGerenciarPulseiraDoPaciente(aberto.patientId, actor);
  if (input.revokeResponsaveis) assertPodeLimparResponsaveis(actor);

  const assignment = await withOptionalTransaction(async (s) => {
    const opts = s ? { session: s } : {};
    aberto.releasedAt = new Date();
    aberto.releasedBy = new Types.ObjectId(actor.id);
    if (input.notes) aberto.notes = input.notes;
    await aberto.save(opts);

    await Device.updateOne({ _id: device._id }, { $set: { status: 'available' } }, opts);
    return aberto;
  });

  // Fora da transacao, e depois dela de proposito. Se a revogacao falhar, a
  // pulseira ja voltou ao estoque e a limpeza se refaz por
  // POST /devices/:id/revoke-responsaveis, que usa o ULTIMO assignment. O
  // inverso - revogar e nao liberar - deixaria a familia sem acesso a uma
  // internacao que continua.
  const responsaveisRevogados = input.revokeResponsaveis
    ? await revokeResponsaveisDoPaciente(aberto.patientId, actor)
    : null;

  return { assignment, responsaveisRevogados };
}

/**
 * Limpar responsaveis e ato da equipe de saude.
 *
 * O manageDevice do vinculo nao basta: o dono pode te-lo concedido a um
 * responsavel, e ai um familiar derrubaria o acesso dos outros familiares.
 * Papel diz O QUE; o vinculo, verificado antes, diz PARA QUEM.
 */
function assertPodeLimparResponsaveis(actor: AuthenticatedUser): void {
  const permitido = actor.roles.some((r) => r === 'enfermagem' || r === 'admin');
  if (!permitido) {
    throw AppError.forbidden('Apenas a equipe de enfermagem pode limpar os responsaveis');
  }
}

/**
 * Revoga os responsaveis do paciente que esta (ou estava) com esta pulseira.
 *
 * Usa o ULTIMO assignment, nao apenas o aberto: na pratica o enfermeiro tira a
 * pulseira primeiro e lembra da limpeza depois, e exigir a ordem inversa so
 * geraria um 409 inutil no meio da troca de leito.
 */
export async function revokeResponsaveisDoDevice(
  deviceId: string,
  actor: AuthenticatedUser,
): Promise<{ patientId: Types.ObjectId; revogados: number }> {
  const device = await Device.findById(deviceId);
  if (!device) throw AppError.notFound('Pulseira nao encontrada');

  const ultimo = await DeviceAssignment.findOne({ deviceId: device._id }).sort({ assignedAt: -1 });
  if (!ultimo) throw AppError.conflict('Esta pulseira nunca foi atribuida a um paciente');

  await assertPodeGerenciarPulseiraDoPaciente(ultimo.patientId, actor);
  assertPodeLimparResponsaveis(actor);

  const revogados = await revokeResponsaveisDoPaciente(ultimo.patientId, actor);
  return { patientId: ultimo.patientId, revogados };
}

/**
 * Emite o token de ingestao do aparelho e devolve o segredo UMA vez.
 *
 * O banco guarda apenas o SHA-256: a mesma escolha da senha e do refresh
 * token. Isso significa que nao existe "ver o token depois" - se quem
 * provisiona perder o valor, o caminho e emitir outro, que invalida o
 * anterior. E a propriedade que vale ter: um vazamento do banco nao entrega
 * credencial de aparelho nenhuma.
 *
 * Emitir de novo ROTACIONA: o token antigo para de funcionar na hora. E assim
 * que se tira de operacao uma pulseira perdida sem precisar apagar o
 * aparelho, que levaria o historico de emprestimo junto.
 */
export async function issueIngestToken(
  deviceId: string,
): Promise<{ device: DeviceDoc; token: string }> {
  const device = await getDevice(deviceId);

  // 32 bytes de entropia. base64url para caber em header HTTP e em NVS sem
  // escape, e o prefixo para o servidor reconhecer a credencial sem adivinhar.
  const token = PREFIXO_TOKEN_DE_APARELHO + randomBytes(32).toString('base64url');
  device.ingestTokenHash = hashDoTokenDeAparelho(token);
  device.ingestTokenCreatedAt = new Date();
  await device.save();

  return { device, token };
}

/** Revoga o token: a pulseira para de conseguir enviar, e o aparelho fica. */
export async function revokeIngestToken(deviceId: string): Promise<DeviceDoc> {
  const device = await getDevice(deviceId);
  device.ingestTokenHash = null;
  device.ingestTokenCreatedAt = null;
  await device.save();
  return device;
}

export async function listAssignments(deviceId: string): Promise<unknown[]> {
  const assignments = await DeviceAssignment.find({ deviceId: new Types.ObjectId(deviceId) })
    .populate<{ patientId: { _id: Types.ObjectId; name: string } }>('patientId', 'name')
    .sort({ assignedAt: -1 });

  return assignments.map((a) => {
    const paciente = populado<{ _id: Types.ObjectId; name: string }>(a.patientId);
    return {
      id: String(a._id),
      assignedAt: a.assignedAt,
      releasedAt: a.releasedAt,
      emUso: a.releasedAt === null,
      notes: a.notes ?? null,
      paciente: { id: paciente._id, nome: paciente.name },
    };
  });
}

/** Precisa de vinculo ativo com manageDevice, ou ser admin. */
async function assertPodeGerenciarPulseiraDoPaciente(
  patientId: Types.ObjectId,
  actor: AuthenticatedUser,
): Promise<void> {
  if (actor.roles.includes('admin')) return;

  const link = await CareLink.findOne({
    patientId,
    caregiverId: new Types.ObjectId(actor.id),
    status: 'active',
  });
  if (!link) throw AppError.notFound('Paciente nao encontrado');
  if (!link.permissions?.manageDevice) {
    throw AppError.forbidden('Seu vinculo nao tem a permissao "manageDevice"');
  }
}
