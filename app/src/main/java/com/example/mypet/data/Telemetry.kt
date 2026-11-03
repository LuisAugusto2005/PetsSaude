package com.example.mypet.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * JSON de telemetria do gateway (WebSocket /ws, GET /api/data e BLE).
 * Ver "VitalWatch_Comunicacao.pdf", seção 6. Campos desconhecidos são ignorados.
 */
data class Telemetria(
    val deviceId: Int,
    val deviceName: String,
    val firmware: String,
    val mode: String,
    val timestampMs: Long, // tempo desde que a pulseira ligou, não é hora do relógio
    val uptimeS: Long,
    val paciente: Paciente,
    val panico: Panico,
    val postura: Postura,
    val queda: Queda,
    val movimento: Movimento,
    val alertas: List<Alerta>, // já vêm do mais grave ao menos grave
    val alertaPior: String?,
    val eventos: List<Evento>,
    val sensor: String,
    val link: String,
    val gateway: InfoGateway?, // só quando vem do gateway
) {
    data class Paciente(val nome: String, val idade: Int?, val quarto: String, val contato: String)
    data class Panico(val ativo: Boolean, val contagem: Int)
    data class Postura(val id: String, val label: String, val inclinacao: Int)
    data class Queda(val detectada: Boolean, val simulada: Boolean, val fase: Int, val contagem: Int)
    data class Movimento(
        val classe: String,
        val label: String,
        val energia: Double,
        val tremor: Boolean,
        val tremorFreq: Double,
        val tremorS: Int,
        val atipico: Boolean,
    )
    data class Alerta(
        val id: String,
        val nivel: String, // critical | warn | info
        val titulo: String,
        val detalhe: String,
        val sinceMs: Long,
        val ativo: Boolean, // false = já normalizou; mostrar esmaecido e sem som
    ) {
        val critico get() = nivel == "critical"
    }
    data class Evento(val seq: Int, val tMs: Long, val id: String, val texto: String)
    data class InfoGateway(val nome: String, val firmware: String, val canal: Int, val rssi: Int, val perdidos: Int, val ageMs: Long)

    companion object {
        fun de(texto: String): Telemetria = de(JSONObject(texto))

        fun de(j: JSONObject): Telemetria {
            val paciente = j.optJSONObject("patient") ?: JSONObject()
            val panico = j.optJSONObject("panic") ?: JSONObject()
            val postura = j.optJSONObject("posture") ?: JSONObject()
            val queda = j.optJSONObject("fall") ?: JSONObject()
            val mov = j.optJSONObject("movement") ?: JSONObject()
            val gw = j.optJSONObject("gateway")
            return Telemetria(
                deviceId = j.optInt("device_id"),
                deviceName = j.optString("device_name"),
                firmware = j.optString("firmware"),
                mode = j.optString("mode"),
                timestampMs = j.optLong("timestamp_ms"),
                uptimeS = j.optLong("uptime_s"),
                paciente = Paciente(
                    nome = paciente.optString("name"),
                    idade = if (paciente.isNull("age")) null else paciente.optInt("age"),
                    quarto = paciente.optString("room"),
                    contato = paciente.optString("contact"),
                ),
                panico = Panico(panico.optBoolean("active"), panico.optInt("count")),
                postura = Postura(postura.optString("id", "unknown"), postura.optString("label"), postura.optInt("inclination")),
                queda = Queda(queda.optBoolean("detected"), queda.optBoolean("simulated"), queda.optInt("phase"), queda.optInt("count")),
                movimento = Movimento(
                    classe = mov.optString("class", "unknown"),
                    label = mov.optString("label"),
                    energia = mov.optDouble("energy", 0.0),
                    tremor = mov.optBoolean("tremor"),
                    tremorFreq = mov.optDouble("tremor_freq", 0.0),
                    tremorS = mov.optInt("tremor_s"),
                    atipico = mov.optBoolean("odd"),
                ),
                alertas = objetos(j.optJSONArray("alerts")).map {
                    Alerta(
                        id = it.optString("id"),
                        nivel = it.optString("level", "info"),
                        titulo = it.optString("title"),
                        detalhe = it.optString("detail"),
                        sinceMs = it.optLong("since_ms"),
                        ativo = it.optBoolean("active", true),
                    )
                },
                alertaPior = j.optString("alert_worst").ifBlank { null },
                eventos = objetos(j.optJSONArray("events")).map {
                    Evento(it.optInt("seq"), it.optLong("t_ms"), it.optString("id"), it.optString("text"))
                },
                sensor = j.optJSONObject("sensors")?.optString("mpu6050").orEmpty(),
                link = j.optJSONObject("network")?.optString("link").orEmpty(),
                gateway = gw?.let {
                    InfoGateway(
                        nome = it.optString("name"),
                        firmware = it.optString("firmware"),
                        canal = it.optInt("channel"),
                        rssi = it.optInt("rssi"),
                        perdidos = it.optInt("lost"),
                        ageMs = it.optLong("age_ms"),
                    )
                },
            )
        }
    }
}

/** Item de GET /api/bands: pulseiras que o gateway conhece. */
data class Pulseira(val id: Int, val paciente: String, val online: Boolean, val ageMs: Long, val rssi: Int, val alertas: Int, val panico: Boolean) {
    companion object {
        fun lista(texto: String): List<Pulseira> = objetos(JSONArray(texto)).map {
            Pulseira(
                id = it.optInt("id"),
                paciente = it.optString("patient"),
                online = it.optBoolean("online"),
                ageMs = it.optLong("age_ms"),
                rssi = it.optInt("rssi"),
                alertas = it.optInt("alerts"),
                panico = it.optBoolean("panic"),
            )
        }
    }
}

private fun objetos(lista: JSONArray?): List<JSONObject> =
    if (lista == null) emptyList() else (0 until lista.length()).mapNotNull { lista.optJSONObject(it) }

/** O firmware manda textos sem acento; o PDF recomenda o app escolher os próprios textos pelo id. */
object Textos {

    fun tituloAlerta(a: Telemetria.Alerta) = when (a.id) {
        "panic" -> "Pedido de ajuda (botão)"
        "fall" -> "Queda detectada"
        "tremor" -> "Tremor detectado"
        "odd_motion" -> "Movimento atípico"
        else -> a.titulo.ifBlank { a.id }
    }

    fun detalheAlerta(a: Telemetria.Alerta) = when (a.id) {
        "panic" -> "O paciente apertou o botão da pulseira."
        "fall" -> "A pulseira percebeu uma possível queda."
        "tremor" -> "Tremor ritmado acontecendo agora."
        "odd_motion" -> "Agitação bem acima do normal deste paciente."
        else -> a.detalhe
    }

    fun postura(p: Telemetria.Postura) = when (p.id) {
        "standing" -> "Em pé"
        "sitting" -> "Sentado"
        "lying" -> "Deitado"
        "moving" -> "Em movimento"
        "unknown" -> "Desconhecida"
        else -> p.label.ifBlank { p.id }
    }

    fun movimento(m: Telemetria.Movimento) = when (m.classe) {
        "rest" -> "Parado"
        "light" -> "Movimento leve"
        "walking" -> "Andando"
        "tremor" -> "Tremor"
        "agitated" -> "Agitado"
        "unknown" -> "Desconhecido"
        else -> m.label.ifBlank { m.classe }
    }

    fun evento(e: Telemetria.Evento) = when (e.id) {
        "panic" -> "Pedido de ajuda"
        "fall" -> "Queda"
        "tremor" -> "Tremor"
        "odd_motion" -> "Movimento atípico"
        "config" -> "Configuração"
        "ack" -> "Alertas reconhecidos"
        "boot" -> "Pulseira ligada"
        else -> e.id
    }

    fun faseQueda(fase: Int) = when {
        fase <= 0 -> "Nenhuma"
        fase >= 3 -> "Confirmada"
        else -> "Em análise (fase $fase de 3)"
    }
}
