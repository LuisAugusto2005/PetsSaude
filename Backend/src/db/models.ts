/**
 * Registro central dos models.
 *
 * Importar por efeito colateral, nao pelos nomes: o que importa e que cada
 * arquivo rode e chame mongoose.model().
 *
 * Existe porque um model que ninguem importa nao fica registrado, e entao o
 * syncIndexes() do boot em producao simplesmente nao o enxerga. Foi o que
 * aconteceu com Reading e Alert, que nesta versao nao tem rota:
 * o TTL de 30 dias das leituras e o indice unico de ocorrencia de alerta
 * nunca seriam criados no Atlas. Os testes nao pegariam isso, porque la cada
 * arquivo de teste importa o model de que precisa.
 *
 * Ao criar um model novo, acrescente a linha aqui.
 */
import '../modules/users/user.model.js';
import '../modules/auth/refreshToken.model.js';
import '../modules/patients/patient.model.js';
import '../modules/carelinks/careLink.model.js';
import '../modules/devices/device.model.js';
import '../modules/devices/deviceAssignment.model.js';
import '../modules/telemetry/reading.model.js';
import '../modules/telemetry/alert.model.js';
import '../modules/audit/accessLog.model.js';
