# VitalWatch — Modelo de dados e autorização

Especificação acordada em 2026-11-10. Esta é a referência para implementação;
quando divergir do código, o código está errado.

## Objetivo que define os cortes

> Ferramenta de **apoio** para a enfermagem cadastrar e monitorar dados de
> pacientes vindos das pulseiras, rápido e fácil.
>
> **Não é substituto do prontuário do hospital.** Qualquer dado que não seja
> necessário ao funcionamento e não venha da pulseira é descartado.

Consequência direta: saem CRM, data de nascimento, idade, quarto, telefone do
paciente e anotações clínicas. O que a pulseira fornece fica na pulseira.

O papel `medico` saiu do objetivo. Um médico que precise acompanhar um paciente
é vinculado como `responsavel` — lê histórico, recebe alerta, não mexe na
pulseira.

## As 9 coleções

### `users` — quem faz login

| campo          | tipo                                     | nota                                                           |
| -------------- | ---------------------------------------- | -------------------------------------------------------------- |
| `email`        | String                                   | único, minúsculo                                               |
| `passwordHash` | String                                   | bcrypt 12 rounds, `select: false`                              |
| `name`         | String                                   | obrigatório                                                    |
| `phone`        | String                                   | opcional, **normalizado** para `+5585999990001` (E.164, só BR) |
| `roles`        | `['responsavel'\|'enfermagem'\|'admin']` | mín 1, sem repetição                                           |
| `status`       | `pending`\|`active`\|`disabled`          | ver abaixo                                                     |

`phone` é funcional, não decorativo: é o número que o app disca quando um
alerta dispara. Lixo no campo quebra o `tel:` do app, e o mesmo número escrito
de três formas impede reconhecer que é a mesma pessoa.

**Só atendemos o Brasil**, então o `+55` é assumido quando falta — a enfermagem
digita `85999990001` com pressa e o número guardado continua discável de
qualquer DDD. A regra, sobre os dígitos (parênteses, espaços, hifens e o zero de
operadora saem antes):

| entrada                             | guardado                                            |
| ----------------------------------- | --------------------------------------------------- |
| 10 ou 11 dígitos                    | prefixa `+55` — `85999990001` → `+5585999990001`    |
| 12 ou 13 dígitos começando com `55` | só prefixa `+` — `5585999990001` → `+5585999990001` |
| `085999990001`                      | zero de operadora cai → `+5585999990001`            |
| qualquer outro tamanho              | **400**                                             |

O teste de tamanho vem antes do de prefixo de propósito: `5533334444` tem 10
dígitos e é um fixo do DDD 55 (Rio Grande do Sul), não um número com código de
país — vira `+555533334444`.

#### `status`: por que não é um booleano

"Não entra" tem duas causas que a tela precisa distinguir. Quem acabou de se
cadastrar vê _"aguarde aprovação"_; quem foi desligado vê outra coisa. Com um
`isActive` booleano as duas viravam o mesmo 401 genérico, o app escrevia _"senha
incorreta"_ e quem tinha acabado de se cadastrar ligava para o suporte.

| papel pedido no cadastro  | nasce     | resposta de `POST /auth/register` |
| ------------------------- | --------- | --------------------------------- |
| `responsavel`             | `active`  | **201** com os tokens             |
| `enfermagem` (ou os dois) | `pending` | **202 sem token**                 |

No login, `pending` → 403 `ACCOUNT_PENDING`, `disabled` → 403
`ACCOUNT_DISABLED`, senha errada → 401. **A checagem de estado vem depois da
senha**, de propósito: só quem acertou a senha fica sabendo em que estado a
conta está — senão a rota vira um verificador de quem tem conta pendente.

Enfermagem precisa de aprovação por decisão do produto: o papel não dá acesso a
paciente nenhum (quem dá é o `CareLink`), mas é a enfermagem que cadastra
paciente e opera pulseira, e a instituição quer dizer quem é da equipe. Custo
aceito, contra o objetivo de "mínimo de atraso": o cadastro dela deixa de ser
imediato.

Desativar **revoga os refresh tokens** no mesmo passo. O access token já emitido
vale até expirar (até 15 min): a alternativa seria consultar o banco a cada
request — latência em todas as chamadas por um corte imediato que raramente
importa.

Não apaga o usuário: ele aparece em `CareLink.createdBy`, em `revokedBy` e em
alertas reconhecidos, e apagar a linha destruiria a trilha.

### `patients` — registro clínico, não um login

| campo       | nota                                                         |
| ----------- | ------------------------------------------------------------ |
| `name`      | identidade estável; a pulseira troca de paciente, o nome não |
| `userId`    | nullable; a porta para "paciente tem conta"                  |
| `createdBy` | quem cadastrou                                               |
| `isActive`  | alta/arquivamento sem apagar histórico                       |

Quatro campos. **Cadastrar paciente é um campo só: o nome.**

`name`, `age`, `room` e `contact` são configurados no portal cativo da
pulseira, ficam na NVS dela e chegam em **todo frame** de telemetria. A pulseira
é a fonte da verdade desses dados; guardar cópia aqui criaria duas versões que
divergem na primeira correção feita só num lado. Eles já estão contratados em
`firmwareTelemetrySchema` e vão para `readings` quando a ingestão existir.

### `carelinks` — quem cuida de quem

`patientId` · `caregiverId` · `relation` · `status` (`active`|`revoked`) ·
`permissions` (`viewHistory`, `receiveAlerts`, `manageDevice`,
`acknowledgeAlerts`) · `isOwner` · `createdBy` · `revokedAt` · `revokedBy`

É a coleção central. Faz "o paciente acionar os outros usuários" ser **uma**
consulta, e é o que substituiu o desenho original de três coleções de usuário:

```js
CareLink.find({ patientId, status: 'active', 'permissions.receiveAlerts': true }).populate(
  'caregiverId',
  'name email phone',
); // quem ligar
```

Revoga em vez de apagar: quem teve acesso a dado de saúde e até quando é
exatamente o que uma auditoria pede. `createdBy` e `revokedBy` fecham a trilha —
quem trouxe cada pessoa e quem a tirou.

### `devices` — a pulseira

`bandNumber` (1–9999, o `<N>` do firmware) · `deviceId` · `deviceName` ·
`firmware` · `linkMode` · `status` · `batteryPct` · `rssi` · `lastSeenAt` ·
`lastUptimeMs` · `currentBootAt` · `ownerOrg` · `notes`

**Não tem `patientId`**, de propósito: a pulseira é do hospital e passa de
paciente para paciente. O vínculo vive em `deviceassignments`, com intervalo.

`lastUptimeMs` + `currentBootAt` substituem a coleção `bootsessions` (ver
"Tempo" abaixo).

### `deviceassignments` — empréstimo com intervalo

`deviceId` · `patientId` · `assignedAt` · `releasedAt` · `assignedBy` ·
`releasedBy` · `notes`

Responde _"de quem era esta queda?"_ meses depois. Dois índices únicos parciais
(`releasedAt: null`) garantem **no banco** que uma pulseira está em no máximo um
paciente, e um paciente usa no máximo uma pulseira.

#### Por que não é um array dentro de `devices`

A pergunta certa não é "coleção ou array?" mas **o que o banco precisa
garantir sozinho**. A regra que não pode ser quebrada é: _uma pulseira está em,
no máximo, um paciente ao mesmo tempo._ Com os períodos num array, o índice
único não alcança essa regra — dentro de **um mesmo documento** o índice
deduplica as chaves, então dois períodos abertos passam sem erro. Medido:

```
array com dois periodos abertos no MESMO documento   ACEITO  <- furo
mesmo paciente aberto em DOIS documentos             RECUSADO (E11000)
```

Ou seja: o array protege contra o erro entre pulseiras e deixa passar
exatamente o erro que importa — a pulseira com dois pacientes abertos. Numa
coleção separada, cada período é um documento, e aí `{deviceId, releasedAt:null}`
único parcial é inviolável, inclusive por código com bug ou por quem mexer no
banco à mão.

O que **não** é motivo: velocidade. O array indexa bem — com índice multikey a
busca "qual pulseira a paciente X tem agora" examinou 1 chave e 1 documento em
500 pulseiras. Quem diz o contrário está adivinhando.

Os outros dois motivos, menores:

- **Escrita concorrente.** Trocar a pulseira de paciente mexe em dois períodos
  (fecha um, abre outro). Em documentos separados, cada um é um `updateOne`
  isolado. No array, as duas operações disputam o mesmo documento.
- **Array sem teto.** A pulseira é do hospital e vive anos; o documento cresce
  para sempre. O limite de 16 MB não chega perto aqui (algumas dezenas de
  internações por ano), mas o padrão de array ilimitado é o que a documentação
  do MongoDB pede para evitar.

**A regra geral, para levar para outros casos:** embuta o que você sempre lê
junto com o pai e que tem tamanho limitado (foi o que fizemos com
`permissions` dentro de `carelinks`); separe o que precisa de garantia própria
no banco, cresce sem limite, ou é consultado por si só. Isto aqui é um
_intervalo de validade_ — o mesmo padrão de `valid_from`/`valid_to` em SQL, não
uma invenção do Mongo.

### `accesslogs` — quem leu o quê

`userId` · `patientId` · `action` · `detail` · `resultCount` · `ip` ·
`userAgent` · `at`

A trilha que a LGPD pede para dado sensível. O `carelink` revogado em vez de
apagado diz quem **tinha** acesso; esta diz quem **usou**.

**Escolha central: registra o acesso pesado, não todo `GET`.** Registrar cada
leitura pareceria mais seguro e seria pior — uma enfermeira com o painel aberto
gera milhares de linhas por turno, quase todas iguais, a coleção de auditoria
fica maior que a de telemetria, e aí ninguém acha o acesso que importa no meio
do ruído.

| entra                                        | fica fora                                                      |
| -------------------------------------------- | -------------------------------------------------------------- |
| `read_readings`, `read_alerts`               | `GET /patients/:id` — só o nome, e é a tela que mais recarrega |
| `export_patient`, `export_self`              | `GET /patients` — lista do próprio vínculo                     |
| `read_access_log` — quem audita também entra | login e refresh — já há `refreshtokens`                        |

`resultCount` existe porque _"exportou"_ sem o volume não distingue dez linhas
de um mês inteiro de telemetria.

Gravar nunca derruba a requisição: se o insert falhar, o erro vai para o log do
servidor em nível `error` e a resposta segue. Troca consciente — uma enfermeira
não deve perder a tela de alertas porque a auditoria está indisponível. O preço
é que falha de banco deixa buraco na trilha.

TTL de **2 anos**. Não é número técnico, é política: tem de sobreviver às
leituras que descreve (que expiram em 30 dias) e durar o suficiente para uma
auditoria ou um pedido do titular. É um palpite defensável, **não um requisito
legal verificado** — precisa passar por quem responde juridicamente pelo
serviço.

### `refreshtokens` — sessões

`userId` · `tokenHash` · `expiresAt` · `usedAt` · `revokedAt` ·
`replacedByHash`

Guarda o SHA-256, nunca o token. Rotativo e de uso único; reuso revoga todas as
sessões do usuário. TTL em `expiresAt` limpa sozinho.

### `readings` — telemetria crua

`deviceId` · `patientId` · `bootAt` · `receivedAt` · `uptimeMs` · `posture` ·
`movement` · `fall` · `panic` · `batteryPct` · `rssi` · `source`

`patientId` é **desnormalizado** no momento da ingestão. Resolver por join
depois daria a resposta errada, porque a pulseira troca de paciente.

**Não existe `heartRate`, `bpm`, `spo2` nem `vitals`** — o sensor foi testado e
abandonado ("no pulso a leitura é pouco confiável, encarece a pulseira e gasta
bateria"). Há teste que varre o schema e falha se algum aparecer.

TTL de 30 dias. Ver "Volume" abaixo.

### `alerts` — ocorrência, não booleano

`deviceId` · `patientId` · `bootAt` · `alertKey` · `level` · `detail` ·
`sinceUptimeMs` · `firstSeenAt` · `lastSeenAt` · `status` · `isLatched` ·
`acknowledgedAt` · `acknowledgedBy` · `acknowledgedVia`

Os quatro alertas do firmware:

| `alertKey`   | `level`  | `isLatched` | comportamento                    |
| ------------ | -------- | ----------- | -------------------------------- |
| `panic`      | critical | **true**    | aceso até alguém reconhecer      |
| `fall`       | critical | **true**    | idem                             |
| `tremor`     | warn     | false       | se limpa quando a condição passa |
| `odd_motion` | warn     | false       | idem                             |

`status` é enum de três valores porque o firmware tem três situações:
`active` (pegando fogo), `normalized` (o `active:false` do firmware — "acabou de
normalizar, mostre esmaecido e sem som", que **não** é resolvido) e
`acknowledged` (alguém atendeu).

Sem TTL: `readings` expira, ocorrência de alerta fica.

## Histórico, export e reconhecimento de alerta — implementado (ToDo 2)

```
GET  /api/patients/:id/readings     viewHistory      paginado, filtra from/to
GET  /api/patients/:id/alerts       viewHistory      filtra status e alertKey
POST /api/alerts/:id/acknowledge    acknowledgeAlerts
GET  /api/patients/:id/history      viewHistory      linha do tempo das ações
GET  /api/patients/:id/access-log   vínculo dono     quem leu os dados
GET  /api/patients/:id/export       viewHistory      stream CSV ou JSON
GET  /api/users/me/export           autenticado      portabilidade LGPD
```

### `acknowledgeAlerts`: a quarta permissão

`panic` e `fall` são _latched_ — o firmware os mantém acesos até alguém
reconhecer. Sem uma saída no backend, o índice `{patientId, status,
firstSeenAt}` nunca encolhe: uma queda de três semanas atrás continua `active`
no topo da tela, e em pouco tempo a enfermagem para de olhar. É o modo clássico
de falha de sistema de alarme.

Nasce `true` para `enfermagem` e `false` para `responsavel`, e o vínculo dono
pode liberar caso a caso. O motivo do padrão: se um familiar apaga o alerta de
queda, a enfermagem deixa de vê-lo sem ninguém ter ido até a paciente.

**Limite que precisa estar escrito:** o ack **não chega à pulseira.** Não existe
canal de descida do backend para o gateway, então o aparelho e o painel local
continuam acesos. O que isto registra é _"quem atendeu e quando"_ —
`firstSeenAt` → `acknowledgedAt` é o tempo de resposta, que é a frente de
trabalho "Resposta ao alerta" dos documentos. A propagação até o aparelho entra
com a ingestão.

### Export: medido, não estimado

Stream com cursor, não `JSON.stringify`. Medido em três tamanhos:

| linhas  | CSV gerado | crescimento do heap |
| ------- | ---------- | ------------------- |
| 20 mil  | 2,3 MB     | +30,8 MB            |
| 80 mil  | 9,4 MB     | +32,5 MB            |
| 320 mil | 38,0 MB    | +43,6 MB            |

16× mais linhas, 16× mais saída, e a memória praticamente a mesma — ela é
limitada pelo lote do cursor, não pelo tamanho do resultado. **125 B por
linha**, o que dá ~154 MB para um paciente-mês (1,3 milhão de linhas). Montar
isso em memória derrubaria o processo nos 512 MB do Render free.

Consequência de desenho que o código precisa respeitar: **tudo que pode falhar
falha antes do primeiro `res.write()`.** Depois do cabeçalho enviado não há como
devolver um erro JSON — o cliente receberia um CSV truncado sem explicação. Por
isso paciente, pulseiras e nomes de quem reconheceu são resolvidos primeiro, e
há um teste de que erro de autorização volta como JSON.

Decisões menores, com motivo:

- **CSV leva BOM.** Sem ele o Excel no Windows lê o arquivo como latin-1 e os
  acentos dos nomes saem trocados.
- **CSV tem coluna `banda`.** Redundante por linha, essencial no conjunto: o
  mesmo paciente pode ter usado duas pulseiras no intervalo pedido, e sem a
  coluna as linhas são ambíguas.
- **CSV comporta uma tabela.** `type=all` em CSV sai como as leituras; para os
  dois conjuntos juntos, `format=json`, que traz `meta` com os períodos de uso.
- **Sem teto de intervalo.** A TTL de 30 dias já limita o máximo possível, e
  intervalo grande custa tempo, não memória. O que protege é o limite de 5
  pedidos por minuto, porque o free tier dá 0,1 vCPU.

### `history`: sem coleção de eventos

A linha do tempo é montada de campos que cada ação **já grava** no documento que
ela mudou: `Patient.createdBy`, `CareLink.createdBy`/`revokedBy`,
`DeviceAssignment.assignedBy`/`releasedBy`, `Alert.acknowledgedBy`. Uma coleção
de eventos paralela duplicaria isso e abriria a porta para as duas versões
discordarem.

O preço são cinco consultas e a junção em memória. Cabe porque são dezenas de
linhas por paciente — vínculos, empréstimos e alertas reconhecidos — e não
telemetria. Se um dia um paciente tiver milhares de eventos, a conta muda e vale
materializar.

### `/users/me/export`: o que não entra

Não é stream, porque são poucas linhas por definição. Traz cadastro, vínculos e
a própria trilha de acesso. **Não traz telemetria**, e isso não é omissão: os
dados da pulseira são do **paciente**, não do cuidador, e saem pela rota do
paciente, por quem tem vínculo com ele. Também não traz senha — só existe o hash
bcrypt, que é irreversível. As duas coisas estão escritas no campo `aviso` da
resposta.

## Ingestão de telemetria — implementada

**A restrição que define o desenho:** o transporte não está decidido. O ESP32
pode falar WiFi direto com o servidor, ou BLE com o celular, que repassa. Logo
a ingestão aceita o **mesmo frame** pelos dois caminhos, sem saber qual é.

```
POST /api/ingest/telemetry
  Authorization: Bearer vwd_...   -> a pulseira por wifi      source 'direct'
  Authorization: Bearer <JWT>     -> o celular por BLE        source 'app'
```

Uma rota, duas credenciais, resolvidas por `middleware/authenticateIngest.ts`.
Duas rotas com o mesmo corpo divergiriam.

### O paciente é resolvido na chegada, e nunca reescrito

A pulseira não sabe de quem ela é — nem deve. Quem responde é o
`DeviceAssignment` aberto no instante em que o dado chega, e o `patientId` é
gravado na leitura.

Carimbar na chegada é o que faz o passado não mudar de dono: corrigir uma
atribuição depois **não** relabela o histórico já gravado. O oposto — resolver o
paciente na hora da consulta — faria o histórico inteiro mudar a cada troca de
leito.

Sem atribuição aberta, `patientId` fica nulo e a leitura é guardada mesmo assim.
Recusar seria perder dado por falta de papelada; e ninguém alcança essa leitura
por rota de paciente até alguém atribuir.

### Idempotência: entrega dupla é esperada, não erro

Com dois caminhos de entrega, o mesmo frame chegando duas vezes é o caso normal,
não a exceção. O índice único `{deviceId, bootAt, uptimeMs}` já resolvia isso
antes de existir rota — foi para isso que ele nasceu.

A gravação usa `bulkWrite` com `upsert` e `$setOnInsert`, não `insertMany`: a
reentrega sai como `matchedCount` em vez de exceção, e **quem chegou primeiro
fica**. O índice continua sendo a garantia contra corrida entre dois requests.

A resposta é **202** e separa `gravadas`, `duplicadas` e `amostradas`, somando
`recebidos`. As três significam "pode limpar o buffer".

### Ligada da pulseira: `boot_id` é um pedido ao firmware

O servidor infere reboot pelo uptime voltar para trás. Funciona ao vivo e
**falha no buffer**, e isso está demonstrado em teste: reenviar um lote
bufferizado começa com uptime menor que o último visto, o servidor lê como
reboot, abre ligada nova, e as leituras entram de novo com outro `bootAt` — fora
do alcance do índice único. Dois frames reentregues viram quatro leituras.

Com `boot_id` na NVS, a chave `{device_id, boot_id, uptime_ms}` é exata e a
inferência vira rede de segurança. `Device.currentBootId` já existe e o schema
do frame já aceita o campo. Ver **`docs/contrato-firmware.md`**.

### Hora de chegada de um lote sai do uptime

Um lote bufferizado representa minutos ou horas de coleta. Carimbar tudo com o
instante da reconexão comprimiria o histórico num ponto: a queda de 14h02
apareceria às 15h30.

O espaçamento é reconstruído de trás para frente a partir dos deltas de uptime —
a mesma conta que o app Kotlin já faz em `VitalWatchViewModel.registrarEventos`.
Quatro minutos de coleta continuam quatro minutos no histórico.

### Credencial do aparelho

`Device.ingestTokenHash` guarda o SHA-256, nunca o token: mesma escolha da senha
e do refresh token. O segredo aparece **uma única vez**, na resposta de
`POST /api/devices/:id/ingest-token` (só admin). Emitir outro rotaciona e
invalida o anterior — é assim que se tira de operação uma pulseira perdida sem
apagar o aparelho e levar o histórico de empréstimo junto.

### Quem pode repassar pelo celular

Basta vínculo **ativo**, sem exigir `manageDevice`. O caso principal do caminho
BLE é o familiar em casa, que não tem essa permissão: exigi-la mataria o único
cenário que o caminho existe para atender. Quem já vê a telemetria do paciente
poder entregá-la não é escalada de privilégio.

O risco que sobra — um cuidador vinculado injetar dado falso — é tratado por
atribuição, não por bloqueio: `Reading.deliveredBy` e `Alert.deliveredBy`
guardam quem repassou. Dado forjado fica assinado.

## Autorização

> **Papel diz o QUE você pode fazer. Vínculo diz PARA QUEM.**

Nenhuma rota de paciente decide pelo papel. Toda rota passa por
`authorizePatient`, que resolve o `CareLink` ativo. Sem vínculo a resposta é
**404, não 403** — um 403 confirmaria que aquele id existe e permitiria varrer a
base.

Admin passa sem vínculo: é o papel da instituição.

| vínculo       | `viewHistory` | `receiveAlerts` | `manageDevice` | cria paciente | convida                     | aprovação    |
| ------------- | ------------- | --------------- | -------------- | ------------- | --------------------------- | ------------ |
| `enfermagem`  | ✓             | ✓               | **✓**          | ✓             | qualquer relação            | admin aprova |
| `responsavel` | ✓             | ✓               | ✗              | ✗             | só `responsavel`, **máx 5** | instantânea  |
| `admin`       | ✓             | ✓               | ✓              | ✓             | qualquer                    | —            |

`manageDevice` na enfermagem porque é quem coloca a pulseira no paciente
fisicamente. O médico/familiar lê dados; não opera aparelho.

### Isolamento verificado

Todo acesso resolve por `patientId`, nunca por `deviceId`. A família da
paciente A **nunca** vê a paciente B, mesmo na mesma pulseira — `authorizePatient`
busca por `patientId`, `listPatients` escopa por `CareLink.patientId`, e
`Reading.patientId` é gravado na ingestão.

Isso significa que `revoke-responsaveis` (abaixo) é **higiene de alta**, não
contenção de vazamento. Esquecer de executar deixa dado antigo acessível por
mais tempo que o devido; não expõe um paciente a outro.

## Tempo: a pulseira não tem relógio

`timestamp_ms`, `since_ms` e `t_ms` são **uptime** e zeram no reboot;
`events[].seq` reinicia em 0. A única hora confiável é o `receivedAt` do
servidor.

O problema concreto que isso cria:

```
10:00  pulseira liga          uptime 0
13:00  QUEDA                  since_ms = 10800000
13:05  bateria acaba, reboot  uptime volta a 0
16:05  QUEDA de novo          since_ms = 10800000   <- MESMO número
```

Duas quedas com chave natural idêntica: a segunda seria descartada como
duplicata, e um alerta crítico desapareceria.

**Solução:** a ingestão compara o `uptimeMs` recebido com `devices.lastUptimeMs`.
Se veio **menor**, a pulseira rebootou e `devices.currentBootAt` passa a ser a
hora atual do servidor. Esse `bootAt` é gravado em cada `readings` e `alerts`,
e entra nas chaves únicas.

É a mesma detecção que o app já faz em
`VitalWatchViewModel.registrarEventos` (`maior < ultimo`), agora no servidor.
Substitui a coleção `bootsessions` por dois campos numa coleção de 8 documentos.

## Volume: medido, não estimado

Custo real em disco de um `Reading`, com dados variados:

```
avgObjSize           427 bytes
dados em disco        91 B/doc   (comprime 4,7x)
índices em disco      52 B/doc   (índices quase não comprimem)
custo total          143 B/doc
```

Os índices custam mais da metade do total. Cada índice novo em `readings` é caro.

Projeção com 8 pulseiras (máximo do gateway) e retenção de 30 dias:

| intervalo                              | docs/mês   | disco        | Atlas M0 (512 MB) |
| -------------------------------------- | ---------- | ------------ | ----------------- |
| **a cada 2 s** (como o firmware manda) | 10.368.000 | **1.412 MB** | **estoura 2,8x**  |
| a cada 30 s                            | 691.200    | 94 MB        | cabe              |
| a cada 60 s                            | 345.600    | 47 MB        | cabe              |
| a cada 5 min                           | 69.120     | 9 MB         | cabe              |

**Se a ingestão gravar tudo que chega, o Atlas gratuito enche antes do primeiro
mês.** O TTL controla o teto, e o teto é 1,4 GB.

Política adotada — **implementada** em `ingest.service.ts` (`devoGravar`):
**o backend é o histórico da pulseira, não o espelho dela.** Uma amostra por
minuto, mais todo frame em que algo observável mude — postura, classe de
movimento, queda, pânico, pior nível de alerta, ou ligada nova. Tempo real o app
já tem pelo WebSocket do gateway.

Trinta frames parados viram **uma** leitura; o instante em que a paciente cai é
gravado exato. `devoGravar` é pura e testada sem banco, porque é a regra que
decide o que o sistema lembra.

Duas consequências que vale deixar escritas:

- **Alerta nunca é amostrado.** Perder a amostra de um segundo parado é
  irrelevante; perder a ocorrência de uma queda não é. O descarte acontece
  depois de os alertas serem processados, então o firmware pode continuar
  mandando a cada 2 s sem medo.
- **Ligada nova sempre grava.** Sem essa exceção, uma pulseira que reinicia
  parada no mesmo lugar não geraria leitura nenhuma na ligada nova: postura e
  movimento dariam igual, o minuto ainda não teria fechado, e o `bootAt`
  recém-criado ficaria sem nenhuma leitura que o apontasse. O reboot
  desapareceria do histórico — e reboot em pulseira de paciente é justamente o
  que alguém precisa investigar.

### Velocidade de busca já está resolvida

Medido com 50 mil leituras, na consulta que a tela de histórico faz:

```
índice usado          patientId_1_receivedAt_-1
chaves examinadas     100
docs examinados       100
docs retornados       100
tempo                 0 ms
ordenação em memória  false
```

100 chaves para 100 documentos é a razão ideal. `SORT` em memória — o que derruba
query de série temporal — não acontece, porque o índice já entrega ordenado.
Isso se mantém com 10 milhões de documentos: a árvore cresce em log.

No Mongo, velocidade depende de o índice casar com a consulta, **não** de quantas
coleções existem. `readings` e `alerts` não fazem `populate` nenhum, e é por isso
que a parte de alto volume é rápida.

## Regras de vínculo

### Responsável convida responsável — implementado (bloco 2)

| quem convida                              | pode criar                                  |
| ----------------------------------------- | ------------------------------------------- |
| `admin`, ou o vínculo dono (`enfermagem`) | qualquer relação                            |
| `responsavel` com vínculo ativo           | **apenas** `responsavel`, no mesmo paciente |
| `enfermagem` com vínculo, sem ser dona    | **403** — ver pendência abaixo              |
| sem vínculo nenhum                        | 404                                         |

A rota perdeu o `ownerOnly`; a decisão mora em
`careLink.service.permissoesDoConvite`, que tem o vínculo do requisitante em
mãos.

**Convite feito por não-dono ignora o campo `permissions`** e usa os padrões
fixos. Sem isso, um responsável daria `manageDevice: true` a um convidado e
ganharia indiretamente o que ele próprio não tem, bastando convidar um segundo
e-mail dele.

A cadeia é auditável por `CareLink.createdBy`. Quem sai não derruba quem
convidou: o vínculo de B é de B, não emprestado de A. E convidar não é ser
dono — quem convidou não manda no vínculo que criou.

**Teto de 5 responsáveis ativos** (409 ao estourar), e vale **para todo mundo**,
inclusive admin e o vínculo dono. O teto não existe para limitar quem convida:
ele limita o fan-out de alerta. Trinta pessoas recebendo o aviso de uma queda
são trinta pessoas supondo que outra já ligou.

Contar e inserir não é atômico: dois convites simultâneos podem resultar em
seis. Não vale um contador desnormalizado no paciente para evitar isso —
ultrapassar em um não tem consequência nenhuma.

### Limpar responsáveis na troca de paciente — implementado (bloco 2)

```
POST /api/devices/:id/revoke-responsaveis      enfermagem | admin
    -> { patientId, responsaveisRevogados }

POST /api/devices/:id/release                  { revokeResponsaveis?: boolean }
    -> { ...assignment, responsaveisRevogados }   // null quando a flag nao foi usada
```

Exige **as duas coisas**: papel `enfermagem`/`admin` _e_ vínculo com
`manageDevice` no paciente. Papel diz o QUE, vínculo diz PARA QUEM — nenhum dos
dois sozinho basta. Só o `manageDevice` não serviria: o dono pode tê-lo
concedido a um responsável, e aí um familiar derrubaria o acesso dos outros
familiares. Enfermeira sem vínculo com aquele paciente recebe 404.

No `release`, a checagem do papel acontece **antes** de liberar: pedir a flag
sem poder usá-la não libera a pulseira pela metade. A revogação roda depois da
transação de liberação, de propósito — se ela falhar, a pulseira já voltou ao
estoque e a limpeza se refaz pela rota dedicada (que usa o último período). O
inverso deixaria a família sem acesso a uma internação que continua.

Resolve o `DeviceAssignment` da pulseira → paciente → revoga todos os vínculos
ativos com `relation: 'responsavel'` daquele paciente.

- Usa o **último** assignment, não só o aberto: o enfermeiro pode liberar a
  pulseira primeiro e limpar depois.
- Revoga, não apaga.
- **Não toca** nos vínculos de `enfermagem`: a equipe mantém o histórico.
- **Não toca** em `patient.isActive`.

A flag no `release` existe porque tirar a pulseira do paciente _é_ a alta: uma
chamada em vez de duas.

## Mudanças de contrato para a equipe do app

1. **`POST /auth/register` deixa de devolver token para `enfermagem`** — responde
   **202** sem credencial, porque a conta nasce `pending`. Para `responsavel`
   continua 201 com os tokens.
2. **`POST /auth/login` ganha códigos distintos** — `ACCOUNT_PENDING` e
   `ACCOUNT_DISABLED`, ambos 403. Sem isso o app escreve "senha incorreta" para
   quem acabou de se cadastrar.
3. **`medico` deixa de ser papel aceito.**
4. **`GET /patients/:id` não devolve mais `age`, `room`, `contactPhone`, `notes`.**
5. **`POST /devices/:id/release` ganha `responsaveisRevogados`** na resposta
   (`null` quando a flag `revokeResponsaveis` não foi usada) e **`POST
/devices/:id/revoke-responsaveis`** é uma rota nova.
6. **`POST /patients/:id/carelinks` não é mais só do dono** — um `responsavel`
   vinculado pode convidar outro `responsavel`. O campo `permissions` enviado
   por quem não é dono é **silenciosamente ignorado**: confira o que voltou na
   resposta em vez de assumir que foi aplicado. Teto de 5 → 409.
7. **`phone` assume `+55`** quando o `+` não vem.

## Ordem de execução

| bloco | conteúdo                                                                                                                                           | natureza                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **1** | remover `doctorprofiles` e CRM · enxugar `Patient` · remover `medico`, adicionar `enfermagem` · permissões por relação · `bootsessions` → `bootAt` | só deleção               |
| **2** | responsável convida responsável (teto 5) · `revoke-responsaveis`                                                                                   | regras novas — **feito** |
| **3** | `isActive` → `status` (`pending`\|`active`\|`disabled`) · 3 rotas de admin · `BOOTSTRAP_ADMIN_EMAIL`                                               | autenticação — **feito** |

| **ToDo 2** | `acknowledgeAlerts` · rotas de leitura de telemetria · ack · `history` · `accesslogs` · export CSV/JSON em stream · `/users/me/export` | leitura e LGPD — **feito** |
| **Ingestão** | `POST /api/ingest/telemetry` com credencial dupla · token de aparelho · `boot_id` · amostragem (bloco F) · `deliveredBy` | escrita — **feito** |

Separados porque misturar deleção com código novo faz o teste vermelho não dizer
qual dos dois quebrou.

## Administração de contas — implementado (bloco 3)

```
GET  /api/users?status=pending&role=&q=&page=&limit=    admin
POST /api/users/:id/approve                             admin
POST /api/users/:id/disable                             admin
```

Aqui o papel basta: não há paciente envolvido, e `admin` é o papel da
instituição. A fila é `?status=pending`, mais antigo primeiro — quem esperou
mais aparece no topo. A busca `q` casa nome ou e-mail, com a entrada escapada
antes de virar regex (sem isso um `(` derruba a rota com 500).

`approve` libera a conta e serve para os dois casos: aprovar quem estava
`pending` e **religar quem foi desativado** — é o único caminho de volta, por
isso aceita ambos. Idempotente.

`disable` recusa dois casos, e os dois são a mesma falha:

- **a própria conta** — o admin se trancaria fora do sistema com um clique;
- **o último admin ativo** — sem nenhum admin, ninguém aprova conta de
  enfermagem nunca mais.

O segundo só é alcançável por um caminho estreito, que é justamente o que o
teste cobre: o admin A foi desativado por B, mas o access token de A vale ainda
por até 15 min, e com ele A derrubaria B.

Vincular uma conta `pending` é recusado com 400: o vínculo pareceria acesso e
não seria, e a enfermeira acharia que avisou alguém.

### O primeiro admin — `BOOTSTRAP_ADMIN_EMAIL`

O seed cria um admin, mas não roda em produção. No Render com banco vazio
ninguém pode aprovar ninguém — o sistema nasceria travado.

A variável **promove um usuário que já existe**, e só quando não há nenhum admin
ativo. Não cria conta: senha de admin em variável de ambiente ficaria no painel
do Render, no log de deploy e no histórico do shell de quem configurou.

```
1. subir sem a variável
2. POST /api/auth/register com roles: ['responsavel']   (nasce ativo)
3. pôr o e-mail em BOOTSTRAP_ADMIN_EMAIL               (o Render reinicia)
4. no boot a conta é promovida; depois a variável pode sair
```

Idempotente de duas formas: não faz nada se já existe admin ativo, e não duplica
o papel se rodar de novo. Esquecer a variável no ambiente não é porta aberta.

### Pendências conhecidas

**Enfermeira não-dona não convida ninguém.** Hoje responde 403: a tabela de
quem convida quem só prevê o dono, o admin e o responsável. É assimétrico — um
familiar convida e a colega de plantão não. Na troca de turno quem cadastrou o
paciente pode não estar no hospital. Minha recomendação é passar a aceitar
qualquer `enfermagem` com vínculo ativo, igual ao dono; fica como decisão sua,
não implementei por conta própria.

**O ack não chega à pulseira.** A ingestão entrou, mas o canal de **descida**
não: não existe caminho do servidor para o gateway nem para a pulseira. `panic` e
`fall` reconhecidos no app continuam acesos no aparelho e no painel local. Ver
`docs/contrato-firmware.md`, seção 7.

**TTL de 2 anos da trilha de acesso** é palpite, não requisito verificado.
Precisa passar por quem responde juridicamente pelo serviço — junto com TCLE e
política de retenção, que é a frente de trabalho "f" dos documentos.

**Amostragem de `readings`** (bloco F): **decidida e implementada** — uma por
minuto, mais toda mudança. Ver "Volume".

**`boot_id` no firmware** é o único pedido aberto que muda o frame. Sem ele, o
reenvio de um lote bufferizado é indistinguível de um reboot e duplica leituras
numa ligada nova. Há teste cobrindo os dois casos.

**Notificação pelo servidor** continua fora: o fan-out 3×@0/7/14 s é do firmware,
via ntfy. O backend sabe quem deveria receber
(`permissions.receiveAlerts`) e não envia nada.

**Model novo precisa entrar em `src/db/models.ts`.** Um model que ninguém importa
não fica registrado no Mongoose, então o `syncIndexes()` do boot não o enxerga e
os índices dele nunca são criados em produção. Já aconteceu com `Reading`,
`Alert` e `BootSession`.
