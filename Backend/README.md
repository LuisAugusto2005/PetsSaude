# VitalWatch — Backend

Backend de **identidade, autorizacao e historico** do VitalWatch.

O VitalWatch hoje e um sistema 100% local: a pulseira ESP32-C3 fala ESP-NOW
com um gateway na tomada, que serve HTTP/WebSocket em
`vitalwatchgateway.local` e publica push no ntfy.sh. O
`VitalWatch_Comunicacao.pdf` (secao 10) registra as pendencias que isso deixa:

> _"Acesso de fora de casa — Nao existe servidor/nuvem. A API so e acessivel na
> rede local; de fora, so o push ntfy."_
> _"Historico longo e responsabilidade do app/backend."_

Esta etapa resolve a terceira pendencia, que nao estava escrita mas e a que
bloqueia as outras duas: **nao existe autenticacao em lugar nenhum** — nem no
app, nem no gateway (HTTP sem TLS nem senha), nem no topico ntfy. Sem saber
quem e quem, nao ha como decidir para quem mandar um alerta.

## O que esta pronto e o que nao esta

|                                                         | Status      |
| ------------------------------------------------------- | ----------- |
| Cadastro e login (JWT com refresh rotativo)             | pronto      |
| Papeis: responsavel, enfermagem, admin                  | pronto      |
| Aprovacao de conta de enfermagem pelo admin             | pronto      |
| Pacientes e vinculos de cuidado (CareLink)              | pronto      |
| Pulseiras e historico de emprestimo                     | pronto      |
| Leitura de telemetria, alertas e reconhecimento         | pronto      |
| Export CSV/JSON em stream, historico e trilha de acesso | pronto      |
| Ingestao de telemetria (pulseira **ou** celular)        | pronto      |
| Token de ingestao por aparelho                          | pronto      |
| Canal de descida (ack chegar a pulseira)                | nao comecou |
| Notificacao de alerta (FCM / ntfy server-side)          | nao comecou |
| WebSocket/SSE para painel ao vivo                       | nao comecou |

A ingestao nao escolhe transporte, de proposito: o ESP32 pode falar wifi direto
com o servidor ou BLE com o celular, que repassa, e **a mesma rota aceita o
mesmo frame pelos dois caminhos**. Receber o mesmo dado duas vezes nao duplica
nada. O que o firmware precisa fazer esta em `docs/contrato-firmware.md`.

O ack ficou de fora porque nao existe caminho do servidor para o gateway nem
para a pulseira: reconhecer um alerta registra quem atendeu, mas nao apaga a luz
do aparelho.

## Tres coisas que o modelo de dados assume

**1. A pulseira nao mede batimento cardiaco.** Do
`VitalWatch_onde_a_saude_entra.pdf`: _"A primeira versao da pulseira ia medir
batimento cardiaco e oxigenacao. Testamos e abandonamos: no pulso a leitura e
pouco confiavel, o sensor encarece a pulseira e gasta muita bateria."_ E do
`VitalWatch_Comunicacao.pdf` secao 7: _"os campos `vitals` e `mock` nao existem
mais."_

Nao existe `vitals`, `bpm` nem `spo2` em schema nenhum, e ha um teste que
garante isso. Os alertas sao **exatamente quatro**:

| alerta       | nivel    | comportamento                                 |
| ------------ | -------- | --------------------------------------------- |
| `panic`      | critical | **latched**: fica aceso ate alguem reconhecer |
| `fall`       | critical | **latched**                                   |
| `tremor`     | warn     | se limpa quando a condicao passa              |
| `odd_motion` | warn     | se limpa                                      |

**2. A pulseira e do hospital e passa de paciente para paciente.** Emprestimo,
devolucao na alta, higienizacao — e a frente de trabalho "e" dos documentos.
Logo `deviceId` **nao e** chave de paciente. O vinculo vive em
`DeviceAssignment`, com `assignedAt`/`releasedAt`. Sem o intervalo, a queda de
um paciente apareceria no historico do proximo.

**3. A pulseira nao tem relogio.** `timestamp_ms`, `since_ms` e `t_ms` sao
uptime e zeram no reboot; `events[].seq` reinicia em 0. A unica hora confiavel
e o `receivedAt` do servidor. Cada leitura e alerta carrega um `bootAt`, que e o
momento em que o servidor viu aquela ligada comecar: e ele que faz dois tempos
de uptime iguais, de ligadas diferentes, nao se confundirem.

**4. Esta ferramenta nao e prontuario.** Ela e apoio para a enfermagem cadastrar
e monitorar o que vem da pulseira. `Patient` guarda **so o nome** - idade,
quarto, telefone e anotacoes clinicas sao do sistema do hospital, e CRM nao e
guardado porque nao validamos CRM contra o CFM e guardar seria garantia falsa.

## A regra de autorizacao

> **Papel diz o QUE voce pode fazer. Vinculo diz PARA QUEM.**

Nenhuma rota de paciente decide apenas pelo papel: ter papel de enfermagem nao
da acesso ao paciente de outra enfermeira. Toda rota de paciente passa por
`middleware/authorizePatient.ts`, que resolve o `CareLink` ativo.

Sem vinculo a resposta e **404, nao 403**, de proposito: um 403 confirmaria que
aquele id de paciente existe, o que permitiria varrer a base.

Admin passa sem vinculo, com todas as permissoes: e o papel da instituicao, que
precisa cadastrar pulseira e corrigir atribuicao.

### Entidades

```
User (email, senha, roles[], status)  uma colecao so: login unico, e a mesma
  |                                    pessoa pode ser responsavel de um
  |                                    paciente e enfermagem de outro
  +-- CareLink ------------------+    quem cuida de quem, com permissoes
                                 |
Patient (so o nome) -------------+    NAO e um login. userId e opcional.
  |
  +-- DeviceAssignment --- Device     emprestimo com intervalo de validade
        |
        +-- Reading                   telemetria crua (TTL de 30 dias)
        +-- Alert                     ocorrencia de alerta (sem TTL)
```

Mais `accesslogs`, a trilha de acesso: nove colecoes, nenhuma a mais. O
raciocinio de cada campo e de cada indice esta em
**`docs/modelo-de-dados.md`**, inclusive por que `DeviceAssignment` e uma
colecao separada em vez de um array dentro de `Device`.

`CareLink` e o que substituiu o desenho inicial de tres colecoes de usuario.
Com ela, "o paciente acionar os outros usuarios" quando um alerta dispara e
**uma** consulta:

```js
CareLink.find({ patientId, status: 'active', 'permissions.receiveAlerts': true });
```

## Rodando

Precisa de Node 22+ e um MongoDB (local ou Atlas M0).

```bash
cp .env.example .env            # e preencha MONGODB_URI e os dois segredos
openssl rand -hex 48            # use para JWT_ACCESS_SECRET
openssl rand -hex 48            # e OUTRO valor para JWT_REFRESH_SECRET

npm install
npm run seed                    # popula o cenario de demonstracao
npm run dev                     # http://localhost:3000
```

A documentacao interativa fica em **http://localhost:3000/docs**, gerada dos
mesmos schemas Zod que validam as requisicoes — nao da para ficar
desatualizada. O documento cru esta em `/docs.json`.

### Scripts

| comando                              | o que faz                                                         |
| ------------------------------------ | ----------------------------------------------------------------- |
| `npm run dev`                        | servidor com reload                                               |
| `npm test`                           | 215 testes, com Mongo em memoria (nao precisa de Mongo instalado) |
| `npm run sync-indexes`               | cria/atualiza os indices sem apagar dado nenhum                   |
| `npm run seed`                       | recria o cenario de demonstracao (apaga os dados!)                |
| `npm run build` / `npm start`        | build de producao e execucao                                      |
| `npm run lint` / `npm run typecheck` | eslint e tsc                                                      |

### Usuarios do seed

Senha de todos: `vitalwatch123`

| e-mail                   | papel       | acesso                                         |
| ------------------------ | ----------- | ---------------------------------------------- |
| `admin@vitalwatch.local` | admin       | tudo                                           |
| `carla@exemplo.com`      | enfermagem  | dona de Dona Terezinha e Maria                 |
| `joana@exemplo.com`      | enfermagem  | dona de Seu Joaquim                            |
| `ana@exemplo.com`        | responsavel | familiar de Dona Terezinha                     |
| `bruno@exemplo.com`      | responsavel | familiar de Seu Joaquim                        |
| `celia@exemplo.com`      | responsavel | convidada pela `ana`, nao pela enfermagem      |
| `denise@exemplo.com`     | enfermagem  | **pendente**: o login da 403 `ACCOUNT_PENDING` |

Para ver o isolamento funcionando: logue como `ana`, pegue o id do Seu Joaquim
pela conta da `joana`, e chame `GET /api/patients/<id>`. Da 404.

Para ver a fila de aprovacao: logue como admin, chame
`GET /api/users?status=pending` e depois `POST /api/users/<id>/approve`.

## Endpoints

Todas as rotas sob `/api` exigem `Authorization: Bearer <accessToken>`, exceto
`/api/auth/register`, `/api/auth/login`, `/api/auth/refresh` e `/health`.

|            | rota                                   | acesso                                 |
| ---------- | -------------------------------------- | -------------------------------------- |
| POST       | `/api/auth/register`                   | publico (limitado a 10/15min)          |
| POST       | `/api/auth/login`                      | publico (limitado)                     |
| POST       | `/api/auth/refresh`                    | refresh token                          |
| POST       | `/api/auth/logout`                     | autenticado                            |
| GET PATCH  | `/api/users/me`                        | autenticado                            |
| GET        | `/api/users`                           | admin (fila: `?status=pending`)        |
| POST       | `/api/users/:id/approve` `/disable`    | admin                                  |
| POST       | `/api/patients`                        | enfermagem / admin                     |
| GET        | `/api/patients`                        | so os pacientes com vinculo ativo      |
| GET PATCH  | `/api/patients/:id`                    | vinculo ativo com **este** paciente    |
| POST       | `/api/patients/:id/carelinks`          | dono, admin, ou responsavel vinculado* |
| GET        | `/api/patients/:id/carelinks`          | vinculo ativo                          |
| PATCH      | `/api/carelinks/:id`                   | dono ou admin                          |
| DELETE     | `/api/carelinks/:id`                   | dono, admin, ou o proprio (para sair)  |
| POST PATCH | `/api/devices` `/api/devices/:id`      | admin                                  |
| GET        | `/api/devices`                         | escopado pelos vinculos                |
| POST       | `/api/devices/:id/assign` `/release`   | permissao `manageDevice`               |
| POST       | `/api/devices/:id/revoke-responsaveis` | enfermagem/admin + `manageDevice`      |
| GET        | `/api/patients/:id/readings`           | permissao `viewHistory`                |
| GET        | `/api/patients/:id/alerts`             | permissao `viewHistory`                |
| POST       | `/api/alerts/:id/acknowledge`          | permissao `acknowledgeAlerts`          |
| GET        | `/api/patients/:id/history`            | permissao `viewHistory`                |
| GET        | `/api/patients/:id/access-log`         | so o vinculo dono                      |
| GET        | `/api/patients/:id/export`             | `viewHistory` (5 pedidos/min)          |
| GET        | `/api/users/me/export`                 | autenticado                            |
| GET        | `/api/devices/:id/assignments`         | quem tem vinculo com a pulseira        |
| POST DEL   | `/api/devices/:id/ingest-token`        | admin                                  |
| POST       | `/api/ingest/telemetry`                | token de aparelho **ou** vinculo ativo |
| GET        | `/health`                              | publico                                |

\* Um `responsavel` vinculado pode convidar **apenas outro `responsavel`**, para
o mesmo paciente, com teto de 5 responsaveis ativos (409 ao estourar). O campo
`permissions` enviado por quem nao e dono e **ignorado**: confira o que voltou
na resposta em vez de assumir que foi aplicado.

### Telemetria, export e auditoria

As quatro permissoes do vinculo:

| permissao           | o que libera                         | padrao enfermagem | padrao responsavel |
| ------------------- | ------------------------------------ | ----------------- | ------------------ |
| `viewHistory`       | leituras, alertas, historico, export | sim               | sim                |
| `receiveAlerts`     | entrar no fan-out do alerta          | sim               | sim                |
| `manageDevice`      | atribuir e liberar pulseira          | sim               | **nao**            |
| `acknowledgeAlerts` | reconhecer alerta                    | sim               | **nao**            |

As duas ultimas sao configuraveis pelo vinculo dono, caso a caso. Ninguem se
concede permissao no proprio vinculo - seria escalada de privilegio.

**Reconhecer alerta.** `panic` e `fall` sao latched: so saem de `status: active`
por reconhecimento. Sem isso a lista de ativos nunca encolhe e a tela fica
inutil em poucos dias.

> **LIMITE:** o ack **nao chega a pulseira.** Nao existe canal de descida do
> backend para o gateway, entao o aparelho e o painel local continuam acesos. O
> que o backend registra e _quem atendeu e quando_. A propagacao entra com a
> ingestao.

**Export.** Resposta em stream, com `Content-Disposition` de anexo - nao e para
consumir em tela. CSV abre no Excel (tem BOM) e comporta uma tabela
(`type=readings` ou `type=alerts`); JSON com `type=all` traz `meta` com os
periodos de uso, mais alertas e leituras.

Medido: 320 mil linhas saem em 38 MB com o heap praticamente constante (+43 MB,
contra +31 MB para 20 mil linhas). Sao ~125 B por linha, o que da ~154 MB para
um paciente-mes. Por isso stream, e por isso o limite de 5 pedidos por minuto.

**Trilha de acesso** (`GET /api/patients/:id/access-log`, so o vinculo dono).
Registra o acesso pesado - abrir historico, abrir alertas, exportar, e ler a
propria trilha - e **nao** registra `GET /api/patients/:id`, que so tem o nome e
e a tela que mais recarrega. Registrar todo GET afogaria a trilha em ruido.

**Portabilidade** (`GET /api/users/me/export`, art. 18 da LGPD): cadastro,
vinculos e os proprios acessos. Nao traz senha (so existe o hash bcrypt) nem
telemetria - os dados da pulseira sao do paciente, nao do cuidador.

### Ingestao de telemetria

Uma rota, dois chamadores legitimos:

```fish
# a pulseira, por wifi
curl -X POST localhost:3000/api/ingest/telemetry \
  -H "Authorization: Bearer vwd_..." -H "Content-Type: application/json" \
  -d '{"device_id":"vitalwatch-0001","timestamp_ms":60000,
       "posture":{"id":"lying"},"battery":{"percent":88}}'

# o celular, repassando o que recebeu por BLE: mesmo corpo, access token
curl -X POST localhost:3000/api/ingest/telemetry \
  -H "Authorization: Bearer $ACCESS" -H "Content-Type: application/json" -d '...'
```

O corpo e um frame do firmware, ou um array deles em ordem cronologica (ate 200,
limitado de fato pelos 256 kB do corpo). A resposta e **202**:

```json
{
  "bandNumber": 1,
  "patientId": "...",
  "source": "direct",
  "recebidos": 30,
  "gravadas": 1,
  "duplicadas": 0,
  "amostradas": 29,
  "alertas": { "criados": 0, "atualizados": 0 }
}
```

Quatro coisas que valem saber antes de integrar:

1. **De quem e o dado nao vem no frame.** O servidor resolve o paciente pelo
   emprestimo aberto da pulseira, na chegada, e grava na leitura. Corrigir uma
   atribuicao depois nao reescreve o passado. Pulseira sem paciente grava com
   `patientId` nulo, e ninguem alcanca essa leitura ate alguem atribuir.
2. **Entrega dupla e esperada.** O mesmo frame pelos dois caminhos vira um
   documento so, e quem chegou primeiro fica. `gravadas + duplicadas +
amostradas = recebidos`, e as tres significam "pode limpar o buffer".
3. **Nem todo frame vira leitura.** Uma por minuto, mais toda mudanca de
   postura, movimento, queda, panico, nivel de alerta ou ligada. A 2 s por frame
   seriam 1.412 MB/mes com oito pulseiras, contra 512 MB do Atlas gratuito.
   **Alerta nunca e amostrado.**
4. **Pelo celular, basta vinculo ativo** — nao exige `manageDevice`, porque o
   caso principal do BLE e o familiar em casa. O que foi repassado fica assinado
   em `deliveredBy`.

O token do aparelho aparece **uma vez**, na resposta de
`POST /api/devices/:id/ingest-token`; o banco guarda so o SHA-256. Emitir outro
rotaciona e invalida o anterior.

### Formato de erro

Sempre o mesmo envelope, com mensagens em portugues:

```json
{
  "erro": {
    "codigo": "CONFLICT",
    "mensagem": "Este e-mail ja esta cadastrado",
    "detalhes": [{ "campo": "email", "mensagem": "E-mail invalido" }]
  }
}
```

`detalhes` so aparece em erro de validacao (400/422) e em conflito. Violacao de
indice unico vira **409**, nunca 500.

### Estado da conta

A conta tem `status`: `pending`, `active` ou `disabled`. Isso muda o cadastro e
o login, e o app precisa tratar:

| situacao                  | resposta                                    |
| ------------------------- | ------------------------------------------- |
| cadastro de `responsavel` | **201** com os tokens: entra na hora        |
| cadastro de `enfermagem`  | **202 sem token** — a conta nasce `pending` |
| login de conta pendente   | **403** `ACCOUNT_PENDING`                   |
| login de conta desativada | **403** `ACCOUNT_DISABLED`                  |
| senha errada              | **401** `UNAUTHORIZED`                      |

**Nao escreva "senha incorreta" para um 403.** Era justamente o que acontecia
com um booleano `isActive`: quem acabava de se cadastrar via "senha incorreta" e
ligava para o suporte.

A checagem de estado vem depois da senha, de proposito: so quem acertou a senha
fica sabendo em que estado a conta esta.

Enfermagem precisa de aprovacao porque e quem cadastra paciente e opera
pulseira, e a instituicao quer dizer quem faz parte da equipe. O papel sozinho
nao da acesso a paciente nenhum — isso continua sendo so o `CareLink`.

Desativar revoga os refresh tokens no mesmo passo, mas o access token ja emitido
vale ate expirar (**ate 15 min**). A alternativa seria consultar o banco a cada
request: latencia em todas as chamadas para um corte imediato que raramente
importa.

### Tokens

O access token dura 15 minutos; o refresh, 30 dias. O refresh e **rotativo e de
uso unico**: cada `/auth/refresh` devolve um par novo e queima o antigo.
Reapresentar um refresh token ja usado e tratado como roubo — **todas** as
sessoes daquele usuario sao revogadas e ele precisa logar de novo.

O app deve guardar os dois, renovar quando o access vencer, e tratar 401 no
refresh como "volte para a tela de login".

## Deploy

`render.yaml` esta pronto: crie um Blueprint no Render apontando para o
repositorio e preencha `MONGODB_URI` no painel (os segredos JWT o Render gera).

**O primeiro admin.** O seed nao roda em producao, e sem admin ninguem aprova
conta de enfermagem: o sistema nasceria travado. Use `BOOTSTRAP_ADMIN_EMAIL`:

1. suba sem a variavel;
2. cadastre-se por `POST /api/auth/register` com `roles: ["responsavel"]` (nasce
   ativo, entra na hora);
3. ponha esse e-mail em `BOOTSTRAP_ADMIN_EMAIL` no painel — o Render reinicia;
4. no boot a conta e promovida a admin. Depois disso a variavel pode sair.

Ela promove um usuario que **ja existe** em vez de criar um: senha de admin em
variavel de ambiente ficaria no painel, no log de deploy e no historico do shell
de quem configurou. E so age quando nao existe nenhum admin ativo, entao
esquece-la no ambiente nao e porta aberta.

**O plano gratuito hiberna depois de 15 minutos sem trafego, e a primeira
requisicao depois disso leva ~50 segundos.** Hoje isso e so incomodo. Quando a
notificacao de queda existir, e inaceitavel: ou plano pago, ou um cron batendo
em `/health`.

Em producao o `autoIndex` do Mongoose fica desligado (criar indice bloqueia a
colecao) e o boot chama `syncIndexes()` uma vez. Model novo precisa ser
acrescentado em `src/db/models.ts`, senao ele nao fica registrado e os indices
dele nunca sao criados.

## Estrutura

```
src/
  config/env.ts        process.env validado com Zod; o processo morre no boot
                       com mensagem legivel, nao na primeira request
  db/
    connect.ts         conexao, desconexao e syncIndexes
    models.ts          registro central dos models (ver comentario do arquivo)
  middleware/
    authenticate.ts    Bearer -> req.user
    requireRole.ts     o QUE o usuario pode fazer
    authorizePatient.ts para QUEM: resolve o CareLink ativo
    validate.ts        Zod em body/params/query, substituindo pelo parse
    errorHandler.ts    envelope de erro; 11000 -> 409, ZodError -> 400
  shared/
    zod.ts             ponto unico de entrada do Zod (ver comentario: a ordem
                       do extendZodWithOpenApi importa no Zod 4)
    types.ts           enums do dominio e tipos do Express
    transaction.ts     transacao quando o Mongo suporta, direto quando nao
  modules/<nome>/      model, schemas, service, controller, routes
  docs/openapi.ts      /docs e /docs.json a partir dos schemas Zod
  app.ts               monta a app sem abrir porta (e o que permite testar)
  server.ts            connect + listen + shutdown em SIGTERM
  db/bootstrapAdmin.ts promove BOOTSTRAP_ADMIN_EMAIL se nao houver admin
```

## Proximos passos

1. **`boot_id` no firmware.** E o unico pedido aberto que muda o frame, e o
   servidor ja aceita o campo. Sem ele, reenviar um lote bufferizado e
   indistinguivel de um reboot e duplica leituras numa ligada nova; ha teste
   cobrindo os dois casos. Ver `docs/contrato-firmware.md`.
2. **Canal de descida.** Reconhecer um alerta registra quem atendeu, mas nao
   apaga a luz da pulseira: `panic` e `fall` sao latched no firmware e nao ha
   caminho do servidor para o aparelho. Precisa ser desenhado junto com quem
   cuida do ESP32.
3. **Ingerir as oito pulseiras pelo gateway.** A secao 10 do documento avisa que
   `/api/data` e o WebSocket expoem apenas a pulseira **destacada** (a de pior
   alerta). O caminho `source: 'gateway'` existe no modelo, mas ingerir as oito
   exigiria um `?band=N` que o firmware ainda nao tem. Hoje os caminhos que
   funcionam sao a pulseira direto (`direct`) e o celular (`app`).
4. **Notificacao.** O fan-out de 3 publicacoes em 0/7/14 s hoje e
   comportamento do firmware; vale mover para o servidor, onde da para escalar
   por protocolo (responsavel -> enfermagem -> SAMU) e medir tempo de resposta.
   `Alert.acknowledgedAt`/`acknowledgedBy` ja existem para isso.
5. **LGPD.** A trilha de acesso (`accesslogs`) e a portabilidade
   (`/users/me/export`) ja existem. Falta o que nao e codigo: TCLE, politica de
   retencao assinada - o TTL de 2 anos da trilha e palpite defensavel, nao
   requisito verificado - e criptografia em repouso. E a frente de trabalho "f"
   dos documentos, e precisa de quem responda juridicamente pelo servico.
