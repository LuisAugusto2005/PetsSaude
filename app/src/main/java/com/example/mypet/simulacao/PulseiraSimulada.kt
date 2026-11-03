package com.example.mypet.simulacao

import org.json.JSONArray
import org.json.JSONObject
import kotlin.random.Random

/**
 * Pulseira de mentira da versão simulada. Monta o mesmo JSON de telemetria do firmware
 * ("VitalWatch_Comunicacao.pdf", seção 6), para o app passar pelo mesmo caminho de leitura do real.
 * O horário é sempre passado de fora, para os testes não precisarem esperar.
 */
class PulseiraSimulada(private val ligadaEm: Long, private val aleatorio: Random = Random.Default) {

    data class Paciente(val nome: String, val idade: Int?, val quarto: String, val contato: String)

    class Alerta(val id: String, val nivel: String, val titulo: String, val detalhe: String, val desde: Long) {
        var ativo = true
            internal set
        internal var normalizouEm = 0L
    }

    private class Evento(val seq: Int, val tMs: Long, val id: String, val texto: String)

    val deviceId = 12
    var paciente = Paciente("Maria Souza", 82, "204", "(85) 99999-0000")
    var postura = "sitting" // standing | sitting | lying | moving
    var atividade = "rest" // rest | light | walking

    var panicoAtivo = false
        private set
    private var panicoContagem = 0
    private var panicoDesde = 0L

    var quedaDetectada = false
        private set
    private var quedaSimulada = false
    private var quedaFase = 0
    private var quedaContagem = 0
    private var quedaInicio = 0L

    private var tremorDesde = 0L
    private var tremorAte: Long? = null
    private var atipicoAte: Long? = null

    private val alertas = mutableListOf<Alerta>()
    private val eventos = ArrayDeque<Evento>()
    private var seq = 0

    /** Fica true quando um alerta surge ou muda: a pulseira manda o estado na hora, sem esperar os 2 s. */
    var alertaMudou = false

    val temAlertaAtivo get() = alertas.any { it.ativo }
    val temAlertaCritico get() = alertas.any { it.ativo && it.nivel == "critical" }
    fun alertasAtivos(): List<Alerta> = alertas.filter { it.ativo }

    init {
        registrar(ligadaEm, "boot", "pulseira ligada")
    }

    private fun t(agora: Long) = agora - ligadaEm

    fun apertarBotao(agora: Long, teste: Boolean = false) {
        if (panicoAtivo) return
        panicoAtivo = true
        panicoContagem++
        panicoDesde = t(agora)
        registrar(agora, "panic", if (teste) "panico simulado (teste)" else "3 toques no botao")
        abrir(agora, "panic", "critical", "Pedido de ajuda (botao)", "o paciente apertou o botao da pulseira")
    }

    /** A queda é reconhecida em etapas: corpo "leve", batida e depois a pessoa parada. */
    fun cair(agora: Long, teste: Boolean = false) {
        if (quedaFase != 0 || quedaDetectada) return
        quedaInicio = agora
        quedaFase = 1
        quedaSimulada = teste
    }

    fun tremer(agora: Long, segundos: Int) {
        if (tremorAte == null) {
            tremorDesde = agora
            registrar(agora, "tremor", "tremor ritmado")
            abrir(agora, "tremor", "warn", "Tremor detectado", "tremor ritmado detectado")
        }
        tremorAte = agora + segundos * 1000L
    }

    fun agitar(agora: Long, segundos: Int) {
        if (atipicoAte == null) {
            registrar(agora, "odd_motion", "movimento atipico")
            abrir(agora, "odd_motion", "warn", "Movimento atipico", "agitacao bem acima do normal do paciente")
        }
        atipicoAte = agora + segundos * 1000L
    }

    /** O reconhecimento limpa a lista de alertas e destrava pânico e queda. */
    fun reconhecer(agora: Long) {
        alertas.clear()
        panicoAtivo = false
        quedaDetectada = false
        quedaSimulada = false
        quedaFase = 0
        registrar(agora, "ack", "alertas reconhecidos")
        alertaMudou = true
    }

    /** Avança o relógio da pulseira: fases da queda, fim do tremor e limpeza de alertas já normalizados. */
    fun passo(agora: Long) {
        if (quedaFase in 1..2) {
            val decorrido = agora - quedaInicio
            if (quedaFase == 1 && decorrido >= 400) quedaFase = 2
            if (quedaFase == 2 && decorrido >= 2400) {
                quedaFase = 3
                quedaDetectada = true
                quedaContagem++
                postura = "lying"
                atividade = "rest"
                registrar(agora, "fall", if (quedaSimulada) "queda simulada (teste)" else "impacto seguido de imobilidade")
                abrir(agora, "fall", "critical", "Queda detectada", "impacto forte seguido de imobilidade")
            }
        }
        tremorAte?.let { fim ->
            if (agora >= fim) {
                tremorAte = null
                normalizar(agora, "tremor")
            }
        }
        atipicoAte?.let { fim ->
            if (agora >= fim) {
                atipicoAte = null
                normalizar(agora, "odd_motion")
            }
        }
        // Alerta normalizado continua visível uns segundos (active:false) para poder ser lido
        if (alertas.removeAll { !it.ativo && agora - it.normalizouEm > 5000 }) alertaMudou = true
    }

    private fun abrir(agora: Long, id: String, nivel: String, titulo: String, detalhe: String) {
        alertas.removeAll { it.id == id }
        alertas += Alerta(id, nivel, titulo, detalhe, t(agora))
        alertaMudou = true
    }

    private fun normalizar(agora: Long, id: String) {
        alertas.firstOrNull { it.id == id && it.ativo }?.let {
            it.ativo = false
            it.normalizouEm = agora
            alertaMudou = true
        }
    }

    private fun registrar(agora: Long, id: String, texto: String) {
        eventos.addLast(Evento(++seq, t(agora), id, texto))
        while (eventos.size > 8) eventos.removeFirst()
    }

    /** Estado completo, como o firmware envia ao gateway (sem o bloco "gateway", que o gateway acrescenta). */
    fun estado(agora: Long): JSONObject {
        val ms = t(agora)
        val tremendo = tremorAte != null
        val agitado = atipicoAte != null
        val classe = when {
            tremendo -> "tremor"
            agitado -> "agitated"
            else -> atividade
        }
        val energia = when (classe) {
            "rest" -> 0.012
            "light" -> 0.08
            "walking" -> 0.25
            "tremor" -> 0.15
            else -> 0.6
        } * (0.8 + aleatorio.nextDouble() * 0.4)
        val inclinacao = when (postura) {
            "standing" -> 8
            "sitting" -> 40
            "lying" -> 85
            else -> 20
        } + aleatorio.nextInt(-3, 4)
        val ordenados = alertas.sortedWith(compareBy<Alerta>({ ordemNivel(it.nivel) }, { !it.ativo }, { -it.desde }))
        val ruido = { escala: Double -> (aleatorio.nextDouble() - 0.5) * escala }

        return JSONObject()
            .put("device", "VitalWatch Band")
            .put("firmware", "0.3.0-sim")
            .put("device_id", deviceId)
            .put("device_name", "VitalWatch$deviceId")
            .put("mode", "normal")
            .put("buzzer", true)
            .put("timestamp_ms", ms)
            .put("uptime_s", ms / 1000)
            .put("free_heap", 120_000 + aleatorio.nextInt(2000))
            .put("samples", ms / 10)
            .put(
                "patient", JSONObject()
                    .put("name", paciente.nome)
                    .put("age", paciente.idade ?: JSONObject.NULL)
                    .put("room", paciente.quarto)
                    .put("contact", paciente.contato)
            )
            .put("panic", JSONObject().put("active", panicoAtivo).put("count", panicoContagem).put("since_ms", panicoDesde))
            .put(
                "posture", JSONObject()
                    .put("id", postura)
                    .put("label", rotuloPostura(postura))
                    .put("inclination", inclinacao)
                    .put("stable", classe == "rest")
            )
            .put(
                "fall", JSONObject()
                    .put("detected", quedaDetectada)
                    .put("simulated", quedaSimulada)
                    .put("phase", quedaFase)
                    .put("count", quedaContagem)
            )
            .put(
                "movement", JSONObject()
                    .put("class", classe)
                    .put("label", rotuloMovimento(classe))
                    .put("energy", energia)
                    .put("dom_freq", if (tremendo) 5.0 else 0.0)
                    .put("dom_ratio", if (tremendo) 0.7 else 0.1)
                    .put("tremor", tremendo)
                    .put("tremor_freq", if (tremendo) 4.8 + aleatorio.nextDouble() * 0.6 else 0.0)
                    .put("tremor_s", if (tremendo) (agora - tremorDesde) / 1000 else 0)
                    .put("odd", agitado)
                    .put("odd_score", if (agitado) 3.2 else 0.4)
            )
            .put("alerts", JSONArray().apply {
                ordenados.take(4).forEach {
                    put(
                        JSONObject()
                            .put("id", it.id)
                            .put("level", it.nivel)
                            .put("title", it.titulo)
                            .put("detail", it.detalhe)
                            .put("since_ms", it.desde)
                            .put("active", it.ativo)
                    )
                }
            })
            .put("alert_worst", ordenados.firstOrNull()?.nivel ?: "info")
            .put("events", JSONArray().apply {
                eventos.forEach {
                    put(JSONObject().put("seq", it.seq).put("t_ms", it.tMs).put("id", it.id).put("text", it.texto))
                }
            })
            .put(
                "motion", JSONObject()
                    .put("ax", ruido(energia))
                    .put("ay", ruido(energia))
                    .put("az", 1.0 + ruido(energia))
                    .put("gx", ruido(1.0))
                    .put("gy", ruido(1.0))
                    .put("gz", ruido(1.0))
                    .put("magnitude", 1.0 + ruido(energia))
                    .put("moving", classe != "rest")
                    .put("temperature_c", 0.0)
            )
            .put("sensors", JSONObject().put("mpu6050", "ok"))
            .put(
                "network", JSONObject()
                    .put("link", "espnow")
                    .put("mode", "STA")
                    .put("ssid", "CasaWiFi")
                    .put("ip", "0.0.0.0")
                    .put("clients", 1)
            )
    }

    private fun ordemNivel(nivel: String) = when (nivel) {
        "critical" -> 0
        "warn" -> 1
        else -> 2
    }

    // O firmware manda os rótulos sem acento
    private fun rotuloPostura(id: String) = when (id) {
        "standing" -> "em pe"
        "sitting" -> "sentado"
        "lying" -> "deitado"
        "moving" -> "em movimento"
        else -> "desconhecida"
    }

    private fun rotuloMovimento(classe: String) = when (classe) {
        "rest" -> "parado"
        "light" -> "leve"
        "walking" -> "andando"
        "tremor" -> "tremor"
        "agitated" -> "agitado"
        else -> "desconhecido"
    }
}
