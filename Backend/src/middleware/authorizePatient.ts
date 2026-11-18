import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { AppError } from '../shared/AppError.js';
import type { CarePermissions } from '../shared/types.js';
import { CareLink } from '../modules/carelinks/careLink.model.js';
import { Patient } from '../modules/patients/patient.model.js';

type PermissionKey = keyof CarePermissions;

interface Options {
  /** Nome do parametro de rota que carrega o id do paciente. */
  param?: string;
  /** Permissao exigida dentro do vinculo, se houver. */
  require?: PermissionKey;
  /** Exige que seja o vinculo dono do paciente. */
  ownerOnly?: boolean;
}

/**
 * A regra invariavel do backend: papel diz O QUE o usuario pode fazer,
 * CareLink diz PARA QUEM. Nenhuma rota de paciente confia apenas em
 * req.user.roles, porque "ser medico" nao da acesso a paciente de outro
 * medico. Este middleware sempre resolve o vinculo ativo.
 *
 * Admin passa sem vinculo, com todas as permissoes: e o papel da instituicao,
 * que precisa cadastrar pulseira e corrigir atribuicao.
 */
export function authorizePatient(options: Options = {}): RequestHandler {
  const { param = 'id', require: requiredPermission, ownerOnly = false } = options;

  return (req, _res, next) => {
    void (async () => {
      try {
        if (!req.user) throw AppError.unauthorized();

        const raw = req.params[param];
        if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw)) {
          throw AppError.badRequest(`Parametro "${param}" nao e um id valido`);
        }
        const patientId = new Types.ObjectId(raw);

        const paciente = await Patient.exists({ _id: patientId });
        if (!paciente) throw AppError.notFound('Paciente nao encontrado');

        if (req.user.roles.includes('admin')) {
          req.patientAccess = {
            patientId,
            relation: null,
            permissions: {
              viewHistory: true,
              receiveAlerts: true,
              manageDevice: true,
              acknowledgeAlerts: true,
            },
            isOwner: true,
          };
          return next();
        }

        const link = await CareLink.findOne({
          patientId,
          caregiverId: new Types.ObjectId(req.user.id),
          status: 'active',
        });

        // 404 e nao 403 de proposito: responder 403 confirmaria que aquele id
        // de paciente existe, o que permite enumerar a base.
        if (!link) throw AppError.notFound('Paciente nao encontrado');

        if (ownerOnly && !link.isOwner) {
          throw AppError.forbidden('Apenas o responsavel que cadastrou o paciente pode fazer isso');
        }
        const permissoes = permissoesDoVinculo(link.permissions);
        if (requiredPermission && !permissoes[requiredPermission]) {
          throw AppError.forbidden(`Seu vinculo nao tem a permissao "${requiredPermission}"`);
        }

        req.patientAccess = {
          patientId,
          relation: link.relation,
          permissions: permissoes,
          isOwner: Boolean(link.isOwner),
        };
        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}

/** Normaliza o subdocumento de permissoes, que o Mongoose tipa como opcional. */
function permissoesDoVinculo(raw: Partial<CarePermissions> | null | undefined): CarePermissions {
  return {
    viewHistory: raw?.viewHistory ?? false,
    receiveAlerts: raw?.receiveAlerts ?? false,
    manageDevice: raw?.manageDevice ?? false,
    acknowledgeAlerts: raw?.acknowledgeAlerts ?? false,
  };
}
