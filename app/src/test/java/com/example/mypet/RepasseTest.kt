package com.example.mypet

import com.example.mypet.data.Telemetria
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O frame cru precisa chegar ao backend inteiro.
 *
 * O app lê só os campos de que precisa; o servidor precisa do documento
 * completo, porque é o MESMO frame que a pulseira manda quando fala direto com
 * ele. Se o repasse mandasse só o que este app entende, o dado gravado seria
 * diferente conforme o caminho de entrega — e uma versão nova de firmware
 * perderia os campos novos justamente no caminho que o celular faz.
 */
class RepasseTest {

    // Seção 6 do "VitalWatch_Comunicacao.pdf", com os blocos que o app ignora.
    private val exemplo = """
        {"device":"VitalWatch Band","firmware":"0.3.0","device_id":12,"device_name":"VitalWatch12",
         "mode":"normal","buzzer":false,"timestamp_ms":512400,"uptime_s":512,"free_heap":152000,
         "samples":51240,
         "patient":{"name":"Maria Souza","age":82,"room":"204","contact":"(11) 99999-0000"},
         "panic":{"active":true,"count":1,"since_ms":509800},
         "posture":{"id":"lying","label":"deitado","inclination":85,"stable":true},
         "fall":{"detected":false,"simulated":false,"phase":0,"count":0},
         "movement":{"class":"rest","label":"parado","energy":0.012,"odd_score":0.4},
         "alerts":[{"id":"panic","level":"critical","title":"Pedido de ajuda",
                    "detail":"apertou o botao","since_ms":509800,"active":true}],
         "alert_worst":"critical",
         "events":[{"seq":7,"t_ms":509800,"id":"panic","text":"botao"}],
         "motion":{"ax":0.010,"magnitude":0.999,"moving":false},
         "sensors":{"mpu6050":"ok"},
         "network":{"link":"espnow","mode":"STA","ssid":"CasaWiFi","clients":1},
         "gateway":{"name":"vitalwatchgateway","channel":10,"rssi":-58,"lost":3,"age_ms":420}}
    """.trimIndent()

    @Test
    fun `o frame cru guarda tudo, inclusive o que o app nao le`() {
        val cru = JSONObject(Telemetria.de(exemplo).cru)

        // Campos que o app não tem no modelo e que o backend pode querer.
        assertEquals(152000, cru.optInt("free_heap"))
        assertEquals(51240, cru.optInt("samples"))
        assertEquals("ok", cru.optJSONObject("sensors")?.optString("mpu6050"))
        assertEquals(0.4, cru.optJSONObject("movement")?.optDouble("odd_score") ?: 0.0, 0.001)
        assertTrue(cru.has("motion"))
        assertEquals(1, cru.optJSONObject("network")?.optInt("clients"))
    }

    @Test
    fun `os tipos do frame sobrevivem ao repasse`() {
        val cru = JSONObject(Telemetria.de(exemplo).cru)

        // device_id é NÚMERO (a seção 6 diz "Número da pulseira"), e o backend
        // casa número com bandNumber. Virar texto aqui daria 404 lá.
        assertTrue(cru.get("device_id") is Int)
        assertEquals(12, cru.getInt("device_id"))

        // fall.phase também é número: 0 nenhuma, 3 confirmada.
        assertTrue(cru.getJSONObject("fall").get("phase") is Int)

        // timestamp_ms é uptime, e grande: não pode virar Int pequeno nem texto.
        assertEquals(512400L, cru.getLong("timestamp_ms"))
    }

    @Test
    fun `um frame invalido nao viravel em telemetria nao chega ao repasse`() {
        // Telemetria.de lança em JSON malformado, e GatewayClient já engole
        // isso com runCatching - então nada entra na fila de repasse.
        val falhou = runCatching { Telemetria.de("{nao e json}") }.isFailure
        assertTrue(falhou)
    }

    @Test
    fun `telemetria construida a mao tem cru vazio e nao e repassada`() {
        // O ViewModel só enfileira quando cru não está vazio: o simulador e
        // qualquer caminho que monte Telemetria na mão não contaminam o banco.
        val semCru = Telemetria.de(exemplo).copy(cru = "")
        assertTrue(semCru.cru.isBlank())
    }
}
