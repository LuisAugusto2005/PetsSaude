# Contrato de ingestão: o que o firmware precisa fazer

Este documento é para a conversa com quem cuida do ESP32. Ele diz o que o
servidor espera, o que ele já aceita hoje, e os três pedidos que dependem do
firmware.

O transporte **não está decidido**: a pulseira pode falar por WiFi direto com o
servidor, ou por BLE com o celular, que repassa. O servidor foi construído para
não precisar escolher — a rota de ingestão aceita o mesmo frame pelos dois
caminhos, e receber o mesmo dado duas vezes não estraga nada.

---

## 1. O princípio: a pulseira sabe quem ELA é, não de quem ela é

A pulseira é do hospital e passa de paciente para paciente. Por isso **a
identidade do paciente não mora no aparelho.**

Quem responde _"de quem é este dado"_ é o servidor, pelo empréstimo aberto
(`DeviceAssignment`) no instante em que o dado chega. O carimbo é gravado em
cada leitura e nunca é reescrito: corrigir uma atribuição depois não muda o dono
do histórico já gravado.

Se a identidade do paciente morasse na NVS, toda troca de leito viraria
reconfiguração de firmware — e no dia em que alguém esquecesse, a queda de uma
paciente entraria no histórico da próxima.

Na NVS ficam **duas** coisas, e só:

```
device_id   identidade estável do aparelho
token       segredo que prova que é ele falando
```

---

## 2. Os três pedidos

### 2.1. `boot_id`: um contador de ligadas na NVS

**É o pedido mais importante, e o único que muda o formato do frame.**

A pulseira não tem relógio. `timestamp_ms`, `since_ms` e `t_ms` são uptime e
zeram a cada boot, e `events[].seq` recomeça em 0. Sem ancorar esses números a
uma ligada específica, duas quedas em ligadas diferentes podem ter `since_ms`
idêntico — e a segunda seria descartada como repetida.

O servidor hoje resolve isso por inferência: se o uptime vem **menor** que o
último visto, houve reboot. Funciona ao vivo. **Falha no buffer**, e o teste
`SEM boot_id, reentregar um lote antigo e indistinguivel de um reboot`
(`tests/ingest.test.ts`) demonstra a falha:

> Reenviar um lote bufferizado começa justamente com uptime menor que o último
> visto. O servidor lê isso como reboot, abre uma ligada nova, e as leituras
> entram **de novo** — agora com outro `bootAt`, fora do alcance do índice que
> impede duplicata. Dois frames reentregues viraram quatro leituras.

Com `boot_id`, a chave `{device_id, boot_id, uptime_ms}` é exata, a reentrega é
reconhecida, e a inferência por uptime vira só uma rede de segurança. O teste
`com boot_id, reentregar um lote inteiro sai como duplicada` prova o outro lado.

Pedido concreto:

- um `uint32` na NVS, incrementado **uma vez por boot**, antes de qualquer envio;
- enviado no frame como `boot_id`;
- precisa sobreviver a OTA; pode zerar num factory reset.

O servidor já aceita o campo. Enquanto não vier, ele usa a inferência.

### 2.2. `device_id`: hoje é o número da banda

**Já conferido no documento, não precisa confirmar:** a seção 6 traz
`"device_id":12` e a tabela de campos diz _"Número da pulseira e nome
(`VitalWatch<N>`)"_. É um **número**, não texto — e o app Kotlin confirma, lendo
o campo com `optInt`.

O servidor aceita os dois:

| no frame                         | casa com            | quando                                    |
| -------------------------------- | ------------------- | ----------------------------------------- |
| `"device_id": 12`                | `Device.bandNumber` | **é o que o firmware manda hoje**         |
| `"device_id": "vitalwatch-0012"` | `Device.deviceId`   | se um dia vier identificador alfanumérico |

A pergunta que **fica em aberto** é se vale migrar para um identificador
derivado do MAC de fábrica (efuse): estável entre reflashes, único sem
coordenação de numeração, de graça. O número da banda é atribuído por quem
monta, e dois lotes podem repetir. Não é urgente — o servidor já aceita a forma
em texto, e a troca não quebra nada.

Se vier em texto, o servidor amarra o aparelho ao primeiro valor que o token
apresentar; se depois chegar outro, recusa com **409** em vez de misturar
históricos.

### 2.3. Buffer offline preserva o uptime de origem

Se a pulseira guarda frames enquanto está sem rede, cada frame precisa carregar
o uptime **do momento da coleta**, não o do envio.

O servidor reconstrói o espaçamento a partir desses uptimes: quatro minutos de
coleta continuam quatro minutos no histórico, mesmo entregues todos de uma vez.
Se todos os frames vierem com o uptime do envio, uma hora de coleta vira um
ponto só no instante da reconexão.

Ordem importa: **o lote tem de vir em ordem cronológica.**

---

## 3. A credencial

|                              | como funciona                                                  | custo no firmware                          | quando serve                                                              |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| **A. só `bandNumber`**       | sem segredo                                                    | zero                                       | só em LAN confiável: na internet qualquer um posta como qualquer pulseira |
| **B. token por aparelho** ⭐ | string na NVS, `Authorization: Bearer`                         | baixo                                      | **é o que está implementado**                                             |
| **C. token + HMAC do corpo** | assina o payload; resiste a adulteração e replay mesmo sem TLS | médio (mbedTLS tem HMAC-SHA256)            | se houver trecho sem TLS                                                  |
| **D. mTLS**                  | certificado cliente por aparelho                               | alto: armazenar, renovar, RAM do handshake | ambiente hospitalar formal                                                |

O servidor implementa **B**. O token:

- tem a forma `vwd_` + 43 caracteres base64url (47 no total);
- é emitido por um admin em `POST /api/devices/:id/ingest-token`;
- **aparece uma única vez**, na resposta dessa chamada: o banco guarda só o
  SHA-256. Perder o valor significa emitir outro;
- emitir outro **rotaciona**: o anterior para de funcionar na hora. É assim que
  se tira de operação uma pulseira perdida sem apagar o aparelho e levar o
  histórico de empréstimo junto;
- `DELETE` na mesma rota revoga.

Guardar em base64url é de propósito: cabe em header HTTP e em NVS sem escape.

---

## 4. A chamada

```http
POST /api/ingest/telemetry
Authorization: Bearer vwd_<token do aparelho>
Content-Type: application/json

{ "device_id": 12, "boot_id": 42, "timestamp_ms": 512400,
  "posture": { "id": "lying", "label": "deitado", "inclination": 85, "stable": true },
  "movement": { "class": "rest", "energy": 0.012, "tremor": false, "odd": false },
  "fall": { "detected": false, "simulated": false, "phase": 0, "count": 0 },
  "panic": { "active": false, "count": 0 },
  "network": { "link": "espnow", "mode": "STA", "ip": "192.168.0.13" },
  "gateway": { "name": "vitalwatchgateway", "channel": 10, "rssi": -58 },
  "alerts": [] }
```

Um lote é o mesmo corpo dentro de um array, em ordem cronológica, até 200
frames — mas o teto que chega primeiro é o **limite de 256 kB do corpo**.

Campos obrigatórios: `timestamp_ms`, e `device_id` quando quem envia é o
celular. Todo o resto é opcional, e **campo desconhecido não derruba o frame**:
uma versão nova de firmware pode acrescentar o que quiser sem quebrar nada.
`motion`, `sensors`, `free_heap`, `samples` e `buzzer` chegam e são ignorados.

Tipos que valem conferir, porque errá-los dá **400** no frame inteiro — e os dois
primeiros estavam errados no servidor até serem checados contra a seção 6:

| campo                 | tipo     | observação                                 |
| --------------------- | -------- | ------------------------------------------ |
| `device_id`           | número   | o número da banda. Texto também é aceito   |
| `fall.phase`          | número   | 0 nenhuma, 3 confirmada. **Não** é texto   |
| `posture.inclination` | número   | graus                                      |
| `alerts[].since_ms`   | número   | uptime, obrigatório quando há alerta       |
| `alerts[].active`     | booleano | obrigatório                                |
| `alerts[].id`         | texto    | só `panic`, `fall`, `tremor`, `odd_motion` |

O RSSI que o servidor guarda vem de `gateway.rssi` — é a qualidade do enlace
ESP-NOW, que é o que diz se a pulseira está sendo ouvida. `network` não traz
RSSI no frame real.

### Resposta

```json
{
  "bandNumber": 1,
  "patientId": "...",
  "ligadaAt": "...",
  "source": "direct",
  "recebidos": 30,
  "gravadas": 1,
  "duplicadas": 0,
  "amostradas": 29,
  "alertas": { "criados": 0, "atualizados": 0 }
}
```

**202**, não 201: o servidor aceitou o lote, mas o que ele guarda não é o que
chegou. `gravadas + duplicadas + amostradas = recebidos`, e qualquer uma das
três significa "pode limpar o buffer" — nenhuma é perda de dado.

### Amostragem: nem todo frame vira leitura

O firmware manda STATE a cada 2 s. Gravar tudo dá ~1,3 milhão de documentos por
mês **por pulseira**: oito pulseiras por 30 dias são 1.412 MB, contra os 512 MB
do plano gratuito do Atlas. Número medido.

A regra: **uma leitura por minuto, mais toda leitura em que algo mudou** —
postura, classe de movimento, queda, pânico, pior nível de alerta, ou ligada
nova. Período parado vira uma linha por minuto; o instante em que a paciente cai
é gravado exato.

**Alertas nunca são amostrados.** Perder a amostra de um segundo parado é
irrelevante; perder a ocorrência de uma queda não é. Por isso o firmware pode
continuar mandando a 2 s sem medo: o descarte acontece no servidor, depois de os
alertas serem processados.

### Erros, e o que fazer com cada um

| código            | significado                                              | o que o firmware deve fazer                          |
| ----------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| **202**           | aceito                                                   | limpar o buffer entregue                             |
| **400**           | frame malformado, ou lote com aparelhos misturados       | **não reenviar**: reenviar não conserta. Sinalizar   |
| **401**           | token inválido ou revogado                               | **parar de enviar** e sinalizar. Insistir vira flood |
| **403**           | aparelho baixado (`retired`)                             | parar de enviar e sinalizar                          |
| **409**           | `device_id` do frame diferente do que o token representa | parar: é erro de provisionamento, não de rede        |
| **429**           | acima de 300 requests/min                                | agrupar em lote e esperar                            |
| **5xx** / timeout | servidor fora                                            | **bufferizar e tentar de novo**, com backoff         |

Só 429 e 5xx merecem retentativa. A diferença importa: um 401 em laço fechado
derruba a cota do aparelho e enche o log.

---

## 5. O caminho BLE

Se a pulseira falar BLE com o celular, o celular chama a **mesma rota**, com o
access token do cuidador em vez do token de aparelho. Nesse caso:

- o frame **precisa** ter `device_id`: é a única pista de qual pulseira é;
- o celular tem de repassar o frame **cru**, sem reinterpretar — o servidor
  precisa do mesmo JSON nos dois caminhos;
- exige vínculo ativo com o paciente, sem exigir `manageDevice`: o caso
  principal é o familiar em casa, e exigir essa permissão mataria justamente o
  cenário que o BLE existe para atender;
- a leitura fica marcada com `source: "app"` e `deliveredBy: <usuário>`. Dado
  repassado fica assinado.

Receber o mesmo frame pelos dois caminhos é esperado e inofensivo: o teste
`o mesmo frame pelo ESP e pelo celular converge no mesmo documento` garante que
sai um documento só, e que quem chegou primeiro fica.

---

## 6. Perguntas para a conversa

1. O ESP32-C3 tem RAM e flash para o handshake TLS até o Render, com o bundle de
   CA? Se não, o caminho vira BLE → celular, e o TLS passa a ser problema do app.
2. Onde o token mora na NVS (namespace e chave)? Sobrevive a OTA? A um factory
   reset?
3. Como o token é provisionado? O portal cativo já existe (`POST /api/setup`,
   `mode: "setup"` no frame) — dá para entregar o token por ali, ou é pré-gravado
   por unidade?
4. Quantos frames a pulseira guarda offline, e em que ordem reenvia?
5. O `device_id` de hoje é derivado do MAC? É estável entre reflashes?
6. Dá para incluir `boot_id`? É o único pedido que muda o frame.

---

## 7. O que ainda não existe

- **Canal de descida.** Reconhecer um alerta no app registra quem atendeu e
  quando, mas **não apaga a luz da pulseira**: `panic` e `fall` são latched no
  firmware e continuam acesos no aparelho e no painel do gateway. Não há caminho
  do servidor para a pulseira. Precisa ser desenhado junto.
- **Notificação pelo servidor.** O fan-out 3×@0/7/14 s é do firmware, via ntfy.
  O servidor sabe quem deveria receber (`permissions.receiveAlerts`), mas não
  envia nada.
