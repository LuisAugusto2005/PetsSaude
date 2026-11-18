import type { Types } from 'mongoose';

/**
 * Papeis de login.
 *
 * Nao existe 'medico': quem gerencia paciente e pulseira e a enfermagem. Um
 * medico que precise acompanhar um paciente e vinculado como 'responsavel' -
 * le historico, recebe alerta, nao opera aparelho.
 *
 * O paciente tambem nao e um papel: ver src/modules/patients.
 */
export const USER_ROLES = ['responsavel', 'enfermagem', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Papeis que um usuario pode pedir no cadastro. 'admin' nasce pelo seed. */
export const SELF_SIGNUP_ROLES = ['responsavel', 'enfermagem'] as const;

/**
 * Estado da conta.
 *
 *   pending   cadastrada, aguardando aprovacao do admin. Nao faz login.
 *   active    normal.
 *   disabled  desligada pelo admin. Nao faz login, e o historico fica.
 *
 * Substituiu o isActive booleano porque "nao entra" tem duas causas que o app
 * precisa distinguir na tela: quem acabou de se cadastrar ve "aguarde
 * aprovacao", quem foi desligado ve outra coisa. Com um booleano, as duas
 * viravam "senha incorreta" e geravam ligacao para o suporte.
 */
export const USER_STATUSES = ['pending', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Papeis cuja conta nasce 'pending' e precisa de aprovacao.
 *
 * Enfermagem entra na lista por decisao do produto: o papel nao da acesso a
 * paciente nenhum (quem da acesso e o CareLink), mas e a enfermagem que
 * cadastra paciente e opera pulseira, e a instituicao quer dizer quem faz
 * parte da equipe. Custo aceito: o cadastro deixa de ser imediato para ela.
 *
 * Responsavel continua imediato - ele nao cria nada sozinho, so ve o paciente
 * ao qual alguem o vinculou.
 */
export const ROLES_QUE_EXIGEM_APROVACAO: readonly UserRole[] = ['enfermagem'];

/** Natureza do vinculo entre um cuidador e um paciente. */
export const CARE_RELATIONS = ['responsavel', 'enfermagem'] as const;
export type CareRelation = (typeof CARE_RELATIONS)[number];

/** Os quatro alertas que o firmware produz. Nao existe batimento cardiaco. */
export const ALERT_KEYS = ['panic', 'fall', 'tremor', 'odd_motion'] as const;
export type AlertKey = (typeof ALERT_KEYS)[number];

export const ALERT_LEVELS = ['critical', 'warn', 'info'] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

/** panic e fall ficam acesos ate alguem reconhecer; os outros se limpam sozinhos. */
export const LATCHED_ALERTS: readonly AlertKey[] = ['panic', 'fall'];

export const POSTURE_IDS = ['standing', 'sitting', 'lying', 'moving', 'unknown'] as const;
export type PostureId = (typeof POSTURE_IDS)[number];

export const MOVEMENT_CLASSES = [
  'rest',
  'light',
  'walking',
  'tremor',
  'agitated',
  'unknown',
] as const;
export type MovementClass = (typeof MOVEMENT_CLASSES)[number];

/** Modos de transmissao da pulseira, gravados na NVS do firmware. */
export const LINK_MODES = ['espnow', 'wifi', 'ble', 'both'] as const;
export type LinkMode = (typeof LINK_MODES)[number];

export const DEVICE_STATUSES = ['available', 'assigned', 'maintenance', 'retired'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** Permissoes carregadas junto do CareLink por authorizePatient. */
export interface CarePermissions {
  /** Ver leituras e alertas passados. */
  viewHistory: boolean;
  /** Entrar no fan-out quando um alerta dispara. */
  receiveAlerts: boolean;
  /** Atribuir e liberar pulseira. */
  manageDevice: boolean;
  /**
   * Reconhecer um alerta: apaga-lo da lista de ativos e assinar quem atendeu.
   *
   * Nasce com a enfermagem. Para o responsavel e configuravel pelo vinculo
   * dono, e o padrao e false: se um familiar apaga o alerta de queda, a
   * enfermagem deixa de ve-lo sem ninguem ter ido ate a paciente.
   */
  acknowledgeAlerts: boolean;
}

/**
 * Permissoes padrao por tipo de vinculo.
 *
 * manageDevice fica com a enfermagem porque e quem coloca a pulseira no
 * paciente fisicamente. Responsavel (e o medico que entra como responsavel)
 * le dados e recebe alerta, mas nao opera aparelho.
 */
export const DEFAULT_PERMISSIONS_BY_RELATION: Readonly<
  Record<CareRelation, Readonly<CarePermissions>>
> = {
  enfermagem: {
    viewHistory: true,
    receiveAlerts: true,
    manageDevice: true,
    acknowledgeAlerts: true,
  },
  responsavel: {
    viewHistory: true,
    receiveAlerts: true,
    manageDevice: false,
    acknowledgeAlerts: false,
  },
};

/**
 * Acoes registradas na trilha de acesso (colecao accesslogs).
 *
 * Apenas acesso PESADO a dado de saude. Ver o comentario do accessLog.model:
 * registrar todo GET afogaria a trilha em ruido de tela recarregada.
 */
export const ACCESS_ACTIONS = [
  'read_readings',
  'read_alerts',
  'export_patient',
  'read_access_log',
  'export_self',
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

/** Teto de responsaveis ativos por paciente. Ver docs/modelo-de-dados.md. */
export const MAX_RESPONSAVEIS_POR_PACIENTE = 5;

/**
 * Politica de amostragem das leituras cruas.
 *
 * O firmware manda STATE a cada 2 s. Gravar tudo da ~1,3 milhao de documentos
 * por mes POR PULSEIRA: oito pulseiras por 30 dias sao 1.412 MB, contra os
 * 512 MB do M0 gratuito do Atlas. Numero medido, nao estimado.
 *
 * A regra: uma leitura por minuto, MAIS toda leitura em que algo observavel
 * mudou. O periodo parado vira uma linha por minuto; o momento em que a
 * paciente cai, se levanta ou comeca a tremer e gravado no instante exato.
 *
 * Isto NAO afeta alertas: Alert nunca e amostrado. Perder a amostra de um
 * segundo parado e irrelevante; perder a ocorrencia de uma queda nao e.
 */
export const INTERVALO_DE_AMOSTRAGEM_MS = 60_000;

/** Lote maximo de frames por request. O teto real e o limite de 256 kB do corpo. */
export const MAX_FRAMES_POR_LOTE = 200;

/** Identidade do requisitante, montada por middleware/authenticate. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  roles: UserRole[];
}

export interface PatientAccess {
  patientId: Types.ObjectId;
  /** Nulo quando o acesso vem de um admin, que nao precisa de vinculo. */
  relation: CareRelation | null;
  permissions: CarePermissions;
  isOwner: boolean;
}

/**
 * Escape hatch tipada para campos vindos de .populate().
 *
 * Os genericos do populate do Mongoose nao sobrevivem a combinacao de
 * InferSchemaType com subdocumentos, e o campo chega como `any`. Em vez de
 * espalhar `as unknown as X` pelos services, a conversao fica concentrada
 * aqui, com nome que deixa claro que e uma promessa nossa, nao do compilador.
 */
export function populado<T>(valor: unknown): T {
  return valor as T;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      patientAccess?: PatientAccess;
    }
  }
}
