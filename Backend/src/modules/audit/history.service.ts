import type { Types } from 'mongoose';
import { paginated, type Pagination } from '../../shared/validation.js';
import { CareLink } from '../carelinks/careLink.model.js';
import { DeviceAssignment } from '../devices/deviceAssignment.model.js';
import { Device } from '../devices/device.model.js';
import { Patient } from '../patients/patient.model.js';
import { User } from '../users/user.model.js';
import { Alert } from '../telemetry/alert.model.js';

export type TipoDeEvento =
  | 'paciente_cadastrado'
  | 'cuidador_vinculado'
  | 'cuidador_revogado'
  | 'pulseira_atribuida'
  | 'pulseira_liberada'
  | 'alerta_reconhecido';

interface Evento {
  at: Date;
  tipo: TipoDeEvento;
  detalhe: string;
  porId: Types.ObjectId | null;
}

/**
 * Linha do tempo do que foi FEITO com este paciente.
 *
 * Nao existe colecao de historico, de proposito: cada acao ja grava quem a fez
 * e quando, no proprio documento que ela mudou - `CareLink.createdBy` e
 * `revokedBy`, `DeviceAssignment.assignedBy` e `releasedBy`,
 * `Alert.acknowledgedBy`. Uma colecao de eventos paralela duplicaria isso e
 * abriria a porta para as duas versoes discordarem.
 *
 * O preco e este metodo: cinco consultas e a juncao em memoria. Cabe porque
 * sao dezenas de linhas por paciente - vinculos, emprestimos e alertas
 * reconhecidos - e nao telemetria. Se um dia um paciente tiver milhares de
 * eventos, a conta muda e vale materializar.
 */
export async function patientHistory(patientId: Types.ObjectId, query: Pagination) {
  const [paciente, links, assignments, alertas] = await Promise.all([
    Patient.findById(patientId).lean(),
    CareLink.find({ patientId })
      .populate<{ caregiverId: { _id: Types.ObjectId; name: string } }>('caregiverId', 'name')
      .lean(),
    DeviceAssignment.find({ patientId }).lean(),
    Alert.find({ patientId, acknowledgedAt: { $ne: null } }).lean(),
  ]);

  const bandas = new Map<string, number>();
  if (assignments.length > 0) {
    const devices = await Device.find({
      _id: { $in: assignments.map((a) => a.deviceId) },
    })
      .select('bandNumber')
      .lean();
    for (const d of devices) bandas.set(String(d._id), d.bandNumber);
  }

  const eventos: Evento[] = [];

  if (paciente) {
    eventos.push({
      at: paciente.createdAt,
      tipo: 'paciente_cadastrado',
      detalhe: paciente.name,
      porId: paciente.createdBy,
    });
  }

  for (const link of links) {
    const nome = (link.caregiverId as unknown as { name?: string }).name ?? 'cuidador removido';
    eventos.push({
      at: link.createdAt,
      tipo: 'cuidador_vinculado',
      detalhe: `${nome} como ${link.relation}`,
      porId: link.createdBy,
    });
    if (link.revokedAt) {
      eventos.push({
        at: link.revokedAt,
        tipo: 'cuidador_revogado',
        detalhe: `${nome} como ${link.relation}`,
        porId: link.revokedBy ?? null,
      });
    }
  }

  for (const a of assignments) {
    const banda = bandas.get(String(a.deviceId));
    const nomeBanda = banda ? `banda ${String(banda)}` : 'pulseira removida';
    eventos.push({
      at: a.assignedAt,
      tipo: 'pulseira_atribuida',
      detalhe: nomeBanda,
      porId: a.assignedBy,
    });
    if (a.releasedAt) {
      eventos.push({
        at: a.releasedAt,
        tipo: 'pulseira_liberada',
        detalhe: nomeBanda,
        porId: a.releasedBy ?? null,
      });
    }
  }

  for (const al of alertas) {
    if (!al.acknowledgedAt) continue;
    eventos.push({
      at: al.acknowledgedAt,
      tipo: 'alerta_reconhecido',
      detalhe: `${al.alertKey} (${al.level})`,
      porId: al.acknowledgedBy ?? null,
    });
  }

  eventos.sort((a, b) => b.at.getTime() - a.at.getTime());

  const total = eventos.length;
  const skip = (query.page - 1) * query.limit;
  const pagina = eventos.slice(skip, skip + query.limit);

  // Um unico SELECT para os nomes de quem agiu, so da pagina devolvida.
  const ids = [...new Set(pagina.map((e) => e.porId).filter((v) => v !== null))];
  const autores = await User.find({ _id: { $in: ids } })
    .select('name email')
    .lean();
  const porId = new Map(autores.map((u) => [String(u._id), u]));

  return paginated(
    pagina.map((e) => {
      const autor = e.porId ? porId.get(String(e.porId)) : undefined;
      return {
        at: e.at,
        tipo: e.tipo,
        detalhe: e.detalhe,
        // Null quando a conta que agiu foi apagada. Nao apagamos usuario, mas
        // a trilha nao deve sumir se um dia alguem apagar.
        por: autor ? { id: String(autor._id), nome: autor.name, email: autor.email } : null,
      };
    }),
    total,
    query,
  );
}
