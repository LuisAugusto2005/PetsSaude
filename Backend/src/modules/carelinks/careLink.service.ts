import { Types } from 'mongoose';
import { AppError } from '../../shared/AppError.js';
import {
  DEFAULT_PERMISSIONS_BY_RELATION,
  MAX_RESPONSAVEIS_POR_PACIENTE,
  populado,
  type AuthenticatedUser,
  type CarePermissions,
  type PatientAccess,
} from '../../shared/types.js';
import { User } from '../users/user.model.js';
import { CareLink, type CareLinkDoc } from './careLink.model.js';
import type {
  CreateCareLinkInput,
  ListCareLinksQuery,
  UpdateCareLinkInput,
} from './careLink.schemas.js';

/**
 * Cria um vinculo de cuidado.
 *
 * Quem pode convidar quem:
 *
 *   admin ou o vinculo dono (enfermagem)  -> qualquer relacao
 *   responsavel com vinculo ativo         -> apenas responsavel, mesmo paciente
 *   qualquer outro com vinculo ativo      -> 403
 *   sem vinculo                           -> 404, no authorizePatient
 *
 * O responsavel convida porque a familia se organiza sozinha: o filho que
 * acompanhou a internacao chama a irma sem depender de a enfermeira que
 * cadastrou estar de plantao.
 */
export async function createCareLink(
  actor: AuthenticatedUser,
  acesso: PatientAccess,
  input: CreateCareLinkInput,
): Promise<CareLinkDoc> {
  const patientId = acesso.patientId;
  // Antes de qualquer consulta: decide o que o requisitante pode criar e com
  // quais permissoes. Convite de nao-dono NAO escolhe permissoes.
  const permissions = permissoesDoConvite(acesso, input);

  const cuidador = input.caregiverId
    ? await User.findById(input.caregiverId)
    : await User.findOne({ email: input.caregiverEmail });

  if (!cuidador) throw AppError.notFound('Cuidador nao encontrado');
  if (cuidador.status === 'pending') {
    throw AppError.badRequest(
      'Esta conta ainda nao foi aprovada pela administracao e nao pode receber vinculo',
    );
  }
  if (cuidador.status === 'disabled') {
    throw AppError.badRequest('Esta conta esta desativada');
  }

  // O papel tem de bater com o vinculo: nao se vincula como enfermagem quem
  // nao tem o papel de enfermagem.
  if (!cuidador.roles.includes(input.relation)) {
    throw AppError.badRequest(
      `Este usuario nao tem o papel "${input.relation}" e nao pode receber este vinculo`,
    );
  }

  const jaExiste = await CareLink.findOne({
    patientId,
    caregiverId: cuidador._id,
    relation: input.relation,
    status: 'active',
  });
  if (jaExiste) {
    throw AppError.conflict('Este cuidador ja possui um vinculo ativo deste tipo com o paciente');
  }

  if (input.relation === 'responsavel') {
    await assertCabeMaisUmResponsavel(patientId);
  }

  return CareLink.create({
    patientId,
    caregiverId: cuidador._id,
    relation: input.relation,
    permissions,
    isOwner: false,
    createdBy: new Types.ObjectId(actor.id),
  });
}

/**
 * Decide se o requisitante pode criar este vinculo, e com quais permissoes.
 *
 * O ponto delicado: **convite feito por nao-dono ignora o campo
 * `permissions`** e usa os padroes fixos da relacao. Sem isso um responsavel
 * daria `manageDevice: true` a um convidado e ganharia, por tabela, o que ele
 * mesmo nao tem - bastava convidar um segundo e-mail dele proprio.
 *
 * `acesso.isOwner` e true tanto para o vinculo dono quanto para admin, que o
 * authorizePatient trata como dono sem precisar de vinculo.
 */
function permissoesDoConvite(acesso: PatientAccess, input: CreateCareLinkInput): CarePermissions {
  if (acesso.isOwner) {
    return { ...DEFAULT_PERMISSIONS_BY_RELATION[input.relation], ...input.permissions };
  }

  if (acesso.relation !== 'responsavel') {
    throw AppError.forbidden(
      'Apenas quem cadastrou o paciente pode vincular outros cuidadores a ele',
    );
  }
  if (input.relation !== 'responsavel') {
    throw AppError.forbidden('Um responsavel pode convidar apenas outro responsavel');
  }

  return { ...DEFAULT_PERMISSIONS_BY_RELATION.responsavel };
}

/**
 * Teto de responsaveis ativos por paciente.
 *
 * Vale para todo mundo, inclusive admin e o vinculo dono, porque o teto nao
 * existe para limitar quem convida: ele limita o fan-out de alerta. Trinta
 * pessoas recebendo o aviso de uma queda e trinta pessoas supondo que outra
 * ja ligou.
 *
 * Contar e inserir nao e atomico: dois convites simultaneos podem resultar em
 * seis. Nao vale um contador desnormalizado no paciente para evitar isso -
 * ultrapassar em um nao tem consequencia nenhuma.
 */
async function assertCabeMaisUmResponsavel(patientId: Types.ObjectId): Promise<void> {
  const ativos = await CareLink.countDocuments({
    patientId,
    relation: 'responsavel',
    status: 'active',
  });
  if (ativos >= MAX_RESPONSAVEIS_POR_PACIENTE) {
    throw AppError.conflict(
      `Este paciente ja tem ${String(MAX_RESPONSAVEIS_POR_PACIENTE)} responsaveis ativos. ` +
        'Revogue um vinculo antes de adicionar outro.',
    );
  }
}

export async function listCareLinks(
  patientId: Types.ObjectId,
  query: ListCareLinksQuery,
): Promise<unknown[]> {
  const links = await CareLink.find({
    patientId,
    ...(query.includeRevoked ? {} : { status: 'active' }),
  })
    .populate<{
      caregiverId: { _id: Types.ObjectId; name: string; email: string; phone?: string };
    }>('caregiverId', 'name email phone')
    .sort({ isOwner: -1, createdAt: 1 });

  return links.map((link) => {
    const cuidador = populado<{
      _id: Types.ObjectId;
      name: string;
      email: string;
      phone?: string;
    }>(link.caregiverId);
    return {
      id: String(link._id),
      relation: link.relation,
      status: link.status,
      isOwner: link.isOwner,
      permissions: link.permissions,
      revokedAt: link.revokedAt,
      createdAt: link.createdAt,
      cuidador: {
        id: cuidador._id,
        nome: cuidador.name,
        email: cuidador.email,
        telefone: cuidador.phone ?? null,
      },
    };
  });
}

export async function updateCareLink(
  linkId: string,
  actor: AuthenticatedUser,
  input: UpdateCareLinkInput,
): Promise<CareLinkDoc> {
  const link = await CareLink.findById(linkId);
  if (!link || link.status !== 'active') throw AppError.notFound('Vinculo nao encontrado');

  // permitirProprio: false. Mexer nas permissoes do proprio vinculo seria
  // escalada de privilegio: qualquer cuidador se daria manageDevice.
  await assertPodeGerenciar(link, actor, { permitirProprio: false });

  for (const [chave, valor] of Object.entries(input.permissions)) {
    if (valor !== undefined) {
      (link.permissions as Record<string, boolean>)[chave] = valor;
    }
  }
  await link.save();
  return link;
}

/**
 * Revoga em vez de apagar: o historico de quem teve acesso a dado de saude e
 * exatamente o que uma auditoria pede, e apagar a linha destruiria isso.
 */
export async function revokeCareLink(linkId: string, actor: AuthenticatedUser): Promise<void> {
  const link = await CareLink.findById(linkId);
  if (!link || link.status !== 'active') throw AppError.notFound('Vinculo nao encontrado');

  if (link.isOwner) {
    throw AppError.badRequest(
      'O vinculo de quem cadastrou o paciente nao pode ser revogado. Transfira a titularidade primeiro.',
    );
  }

  // permitirProprio: true. Sair do acompanhamento por conta propria e
  // legitimo, e nao aumenta permissao nenhuma.
  await assertPodeGerenciar(link, actor, { permitirProprio: true });

  link.status = 'revoked';
  link.revokedAt = new Date();
  link.revokedBy = new Types.ObjectId(actor.id);
  await link.save();
}

/**
 * Revoga TODOS os vinculos de responsavel ativos de um paciente.
 *
 * Higiene de alta: a pulseira e do hospital e passa de paciente para paciente,
 * e a familia da internacao anterior nao tem o que receber alerta da proxima
 * pessoa. Roda a mao na troca, porque so a equipe sabe quando a troca
 * aconteceu de fato.
 *
 * Nao e prevencao de vazamento - todo acesso resolve por patientId, nunca por
 * deviceId, entao a familia antiga nunca veria o paciente novo nem sem isto. E
 * para parar de incomodar quem nao tem mais nada a ver com o caso.
 *
 * O que NAO e tocado, de proposito:
 *   - vinculos de enfermagem: a equipe mantem o historico do que cuidou
 *   - o vinculo dono: ele nao e revogavel por ninguem
 *   - patient.isActive: dar alta e outra decisao, tomada em outro lugar
 */
export async function revokeResponsaveisDoPaciente(
  patientId: Types.ObjectId,
  actor: AuthenticatedUser,
): Promise<number> {
  const resultado = await CareLink.updateMany(
    { patientId, relation: 'responsavel', status: 'active', isOwner: { $ne: true } },
    {
      $set: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedBy: new Types.ObjectId(actor.id),
      },
    },
  );
  return resultado.modifiedCount;
}

/**
 * Decide se o requisitante pode agir sobre este vinculo.
 *
 * Admin sempre pode. O dono do paciente pode sobre qualquer vinculo dele. Um
 * cuidador comum so pode sobre o PROPRIO vinculo, e apenas nas operacoes que
 * nao aumentam o que ele mesmo pode fazer: dai o permitirProprio.
 *
 * Revogar o proprio vinculo e legitimo (sair do acompanhamento). Editar as
 * permissoes do proprio vinculo nao e: seria escalada de privilegio, com o
 * cuidador se concedendo manageDevice.
 *
 * O 404 em vez de 403 quando nao ha vinculo nenhum e deliberado: um 403
 * confirmaria que aquele id de vinculo existe.
 */
async function assertPodeGerenciar(
  link: CareLinkDoc,
  actor: AuthenticatedUser,
  opts: { permitirProprio: boolean },
): Promise<void> {
  if (actor.roles.includes('admin')) return;

  const meuVinculo = await CareLink.findOne({
    patientId: link.patientId,
    caregiverId: new Types.ObjectId(actor.id),
    status: 'active',
  });
  if (!meuVinculo) throw AppError.notFound('Vinculo nao encontrado');
  if (meuVinculo.isOwner) return;

  if (opts.permitirProprio && meuVinculo._id.equals(link._id)) return;

  throw AppError.forbidden(
    'Apenas o responsavel que cadastrou o paciente pode alterar as permissoes de um vinculo',
  );
}
