package com.example.mypet

import com.example.mypet.data.GatewayClient
import com.example.mypet.data.Pulseira
import com.example.mypet.data.Telemetria
import com.example.mypet.data.Textos
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TelemetryTest {

    // Exemplo da seção 6 do "VitalWatch_Comunicacao.pdf" (pânico ativo)
    private val exemplo = """
        {"device":"VitalWatch Band","firmware":"0.3.0","device_id":12,"device_name":"VitalWatch12",
         "mode":"normal","buzzer":false,"timestamp_ms":512400,"uptime_s":512,"free_heap":152000,"samples":51240,
         "patient":{"name":"Maria Souza","age":82,"room":"204","contact":"(11) 99999-0000"},
         "panic":{"active":true,"count":1,"since_ms":509800},
         "posture":{"id":"lying","label":"deitado","inclination":85,"stable":true},
         "fall":{"detected":false,"simulated":false,"phase":0,"count":0},
         "movement":{"class":"rest","label":"parado","energy":0.012,"dom_freq":0.0,"dom_ratio":0.10,
                     "tremor":false,"tremor_freq":0.0,"tremor_s":0,"odd":false,"odd_score":0.4},
         "alerts":[{"id":"panic","level":"critical","title":"Pedido de ajuda (botao)",
                    "detail":"o paciente apertou o botao da pulseira","since_ms":509800,"active":true}],
         "alert_worst":"critical",
         "events":[{"seq":7,"t_ms":509800,"id":"panic","text":"..."}],
         "motion":{"ax":0.010,"ay":0.020,"az":0.998,"gx":0.10,"gy":-0.20,"gz":0.00,
                   "magnitude":0.999,"moving":false,"temperature_c":0.0},
         "sensors":{"mpu6050":"ok"},
         "network":{"link":"espnow","mode":"STA","ssid":"CasaWiFi","ip":"192.168.0.13","clients":1},
         "gateway":{"name":"vitalwatchgateway","firmware":"0.1.0","channel":10,"rssi":-58,
                    "bands_online":1,"lost":3,"age_ms":420}}
    """.trimIndent()

    @Test
    fun leExemploDoPdf() {
        val t = Telemetria.de(exemplo)

        assertEquals(12, t.deviceId)
        assertEquals("VitalWatch12", t.deviceName)
        assertEquals(512400L, t.timestampMs)
        assertEquals("Maria Souza", t.paciente.nome)
        assertEquals(82, t.paciente.idade)
        assertEquals("204", t.paciente.quarto)
        assertTrue(t.panico.ativo)
        assertEquals("Deitado", Textos.postura(t.postura))
        assertEquals(85, t.postura.inclinacao)
        assertEquals("Parado", Textos.movimento(t.movimento))
        assertFalse(t.queda.detectada)

        val alerta = t.alertas.single()
        assertTrue(alerta.critico)
        assertTrue(alerta.ativo)
        assertEquals("Pedido de ajuda (botão)", Textos.tituloAlerta(alerta))
        assertEquals(2600L, t.timestampMs - alerta.sinceMs)

        assertEquals(7, t.eventos.single().seq)
        assertEquals("ok", t.sensor)
        assertEquals("espnow", t.link)
        assertEquals(-58, t.gateway?.rssi)
        assertEquals(420L, t.gateway?.ageMs)
    }

    @Test
    fun jsonDaPulseiraSemGatewayEIdadeNula() {
        val t = Telemetria.de("""{"device_id":3,"patient":{"name":"","age":null},"alerts":[],"extra":{"novo":1}}""")
        assertNull(t.gateway)
        assertNull(t.paciente.idade)
        assertTrue(t.alertas.isEmpty())
        assertEquals("unknown", t.postura.id)
    }

    @Test
    fun alertaNormalizado() {
        val t = Telemetria.de("""{"alerts":[{"id":"tremor","level":"warn","since_ms":1,"active":false}]}""")
        val a = t.alertas.single()
        assertFalse(a.ativo)
        assertFalse(a.critico)
        assertEquals("Tremor detectado", Textos.tituloAlerta(a))
    }

    @Test
    fun leListaDePulseiras() {
        val lista = Pulseira.lista(
            """[{"id":12,"mac":"aa:bb:cc:dd:ee:ff","patient":"Maria Souza","online":true,"age_ms":840,
                "rssi":-58,"frames":15320,"lost":3,"alerts":1,"panic":true}]"""
        )
        val p = lista.single()
        assertEquals(12, p.id)
        assertEquals("Maria Souza", p.paciente)
        assertTrue(p.online && p.panico)
        assertEquals(1, p.alertas)
    }

    @Test
    fun normalizaEndereco() {
        assertEquals("http://192.168.0.10", GatewayClient.normalizar(" 192.168.0.10/ "))
        assertEquals("https://ntfy.sh", GatewayClient.normalizar("https://ntfy.sh/"))
    }
}
