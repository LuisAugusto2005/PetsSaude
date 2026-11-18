import type mongoose from 'mongoose';
import { Types } from 'mongoose';
import { AppError } from '../../shared/AppError.js';
import { paginated } from '../../shared/validation.js';
import { withOptionalTransaction } from '../../shared/transaction.js';
import {
  DEFAULT_PERMISSIONS_BY_RELATION,
  type AuthenticatedUser,
  type CareRelation,
} from '../../shared/types.js';
import { CareLink } from '../carelinks/careLink.model.js';
import { User } from '../users/user.model.js';
import { Patient, type PatientDoc } from './patient.model.js';
import type {
  CreatePatientInput,
  ListPatientsQuery,
  UpdatePatientInput,
} from './patient.schemas.js';

/**
 * Cria o paciente e, no mesmo passo, o CareLink DONO de quem cadastrou.
 *
 * Os dois nascem juntos porque um paciente sem vinculo seria invisivel: nem
 * quem o criou conseguiria lista-lo, ja que toda leitura passa por CareLink.
 *
 * O vinculo e sempre 'enfermagem', porque so enfermagem e admin chegam aqui
 * (ver requireRole na rota). Admin cadastrando paciente tambem recebe vinculo
 * de enfermagem: ele esta agindo como equipe, e sem o vinculo o paciente
 * ficaria sem dono e ninguem poderia convidar responsaveis depois.
 */
export async function createPatient(
  actor: AuthenticatedUser,
  input: CreatePatientInput,
): Promise<{ patient: PatientDoc; relation: CareRelation }> {
  const relation: CareRelation = 'enfermagem';

  if (input.userId) {
    const existe = await User.exists({ _id: new Types.ObjectId(input.userId) });
    if (!existe) throw AppError.badRequest('userId informado nao corresponde a um usuario');
  }

  return withOptionalTransaction(async (s) => {
    const [patient] = await Patient.create(
      [
        {
          name: input.name,
          userId: input.userId ? new Types.ObjectId(input.userId) : null,
          createdBy: new Types.ObjectId(actor.id),
        },
      ],
      s ? { session: s } : {},
    );
    if (!patient) throw new Error('Falha ao criar paciente');

    await CareLink.create(
      [
        {
          patientId: patient._id,
          caregiverId: new Types.ObjectId(actor.id),
          relation,
          isOwner: true,
          permissions: DEFAULT_PERMISSIONS_BY_RELATION[relation],
          createdBy: new Types.ObjectId(actor.id),
        },
      ],
      s ? { session: s } : {},
    );

    return { patient, relation };
  });
}

/** Lista apenas os pacientes com vinculo ativo para o requisitante. */
export async function listPatients(actor: AuthenticatedUser, query: ListPatientsQuery) {
  const filtroPaciente: mongoose.FilterQuery<unknown> = {};
  if (!query.includeInactive) filtroPaciente.isActive = true;
  if (query.q) {
    // escapa regex para que o usuario nao injete um padrao caro
    filtroPaciente.name = {
      $regex: query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      $options: 'i',
    };
  }

  // Admin ve todos; qualquer outro papel ve so o que o vinculo permite.
  if (!actor.roles.includes('admin')) {
    const links = await CareLink.find({
      caregiverId: new Types.ObjectId(actor.id),
      status: 'active',
      ...(query.relation ? { relation: query.relation } : {}),
    }).select('patientId');
    const ids = links.map((l) => l.patientId);
    if (ids.length === 0) {
      return paginated([], 0, query);
    }
    filtroPaciente._id = { $in: ids };
  }

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    Patient.find(filtroPaciente).sort({ name: 1 }).skip(skip).limit(query.limit),
    Patient.countDocuments(filtroPaciente),
  ]);

  return paginated(
    items.map((p) => p.toJSON()),
    total,
    query,
  );
}

export async function getPatient(patientId: Types.ObjectId): Promise<PatientDoc> {
  const patient = await Patient.findById(patientId);
  if (!patient) throw AppError.notFound('Paciente nao encontrado');
  return patient;
}

export async function updatePatient(
  patientId: Types.ObjectId,
  input: UpdatePatientInput,
): Promise<PatientDoc> {
  const patient = await Patient.findByIdAndUpdate(
    patientId,
    { $set: input },
    { new: true, runValidators: true },
  );
  if (!patient) throw AppError.notFound('Paciente nao encontrado');
  return patient;
}
