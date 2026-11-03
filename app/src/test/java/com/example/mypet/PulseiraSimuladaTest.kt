package com.example.mypet

import com.example.mypet.data.Telemetria
import com.example.mypet.simulacao.PulseiraSimulada
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class PulseiraSimuladaTest {

    private val ligada = 1_000_000L
    private val pulseira = PulseiraSimulada(ligada, Random(42))

    // O JSON simulado passa pelo mesmo leitor do app real
    private fun ler(agora: Long) = Telemetria.de(pulseira.estado(agora).toString())

    @Test
    fun estadoInicialSemAlertas() {
        val t = ler(ligada + 5000)
        assertEquals(12, t.deviceId)
        assertEquals("Maria Souza", t.paciente.nome)
        assertEquals(5000L, t.timestampMs)
        assertEquals("sitting", t.postura.id)
        assertTrue(t.alertas.isEmpty())
        assertEquals("boot", t.eventos.single().id)
    }

    @Test
    fun panicoFicaTravadoAteReconhecer() {
        pulseira.apertarBotao(ligada + 1000)
        pulseira.passo(ligada + 60_000)
        var t = ler(ligada + 60_000)
        assertTrue(t.panico.ativo)
        val alerta = t.alertas.single()
        assertEquals("panic", alerta.id)
        assertTrue(alerta.critico && alerta.ativo)
        assertEquals(1000L, alerta.sinceMs)

        pulseira.reconhecer(ligada + 61_000)
        t = ler(ligada + 61_000)
        assertFalse(t.panico.ativo)
        assertTrue(t.alertas.isEmpty())
        assertEquals("ack", t.eventos.last().id)
    }

    @Test
    fun quedaPassaPelasFasesAteConfirmar() {
        pulseira.cair(ligada)
        pulseira.passo(ligada + 100)
        assertEquals(1, ler(ligada + 100).queda.fase)
        pulseira.passo(ligada + 500)
        assertEquals(2, ler(ligada + 500).queda.fase)
        pulseira.passo(ligada + 2500)
        val t = ler(ligada + 2500)
        assertEquals(3, t.queda.fase)
        assertTrue(t.queda.detectada)
        assertEquals("lying", t.postura.id)
        assertEquals("fall", t.alertas.single().id)
    }

    @Test
    fun tremorNormalizaEDepoisSome() {
        pulseira.tremer(ligada, 10)
        pulseira.passo(ligada + 5000)
        var t = ler(ligada + 5000)
        assertTrue(t.movimento.tremor)
        assertEquals("tremor", t.movimento.classe)
        assertEquals(5, t.movimento.tremorS)
        assertTrue(t.alertas.single().ativo)

        // Passou o tremor: o alerta fica alguns segundos como active:false
        pulseira.passo(ligada + 10_000)
        t = ler(ligada + 10_000)
        assertFalse(t.movimento.tremor)
        assertFalse(t.alertas.single().ativo)

        pulseira.passo(ligada + 16_000)
        assertTrue(ler(ligada + 16_000).alertas.isEmpty())
    }

    @Test
    fun alertasVemDoMaisGraveAoMenosGrave() {
        pulseira.tremer(ligada, 30)
        pulseira.apertarBotao(ligada + 1000)
        val ids = ler(ligada + 2000).alertas.map { it.id }
        assertEquals(listOf("panic", "tremor"), ids)
    }

    @Test
    fun guardaSoOsUltimosOitoEventos() {
        repeat(6) { i ->
            pulseira.apertarBotao(ligada + i * 10L)
            pulseira.reconhecer(ligada + i * 10L + 5)
        }
        val eventos = ler(ligada + 1000).eventos
        assertEquals(8, eventos.size)
        assertEquals(13, eventos.last().seq) // boot + 6 x (pânico + reconhecimento)
    }
}
