package com.example.mypet.simulacao

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.example.mypet.data.FonteGateway
import com.example.mypet.data.FonteNtfy
import com.example.mypet.data.GatewayClient
import com.example.mypet.data.GatewayDiscovery
import com.example.mypet.data.NtfyClient
import com.example.mypet.data.NtfyMessage
import com.example.mypet.data.Pulseira
import com.example.mypet.data.Telemetria
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.net.SocketException
import java.net.SocketTimeoutException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.random.Random

/**
 * Gateway e ntfy de mentira da versão "simulado". Imita os tempos e regras do
 * "VitalWatch_Comunicacao.pdf": estado da pulseira a cada 2 s (1 s com alerta), WebSocket a 250 ms,
 * silêncio quando a pulseira some por mais de 6 s, comandos com atraso do ESP-NOW e 3 pushes por alerta.
 * Tudo sai como texto JSON e passa pelos mesmos leitores do app real.
 */
object Simulador : FonteGateway {

    private val escopo = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private fun agora() = System.currentTimeMillis()

    var pulseira = PulseiraSimulada(agora())
        private set

    // Situações que a tela do simulador liga e desliga
    var gatewayLigado by mutableStateOf(true)
        private set
    var pulseiraNoAr by mutableStateOf(true)
        private set
    var sinalFraco by mutableStateOf(false)
        private set
    var ntfyComInternet by mutableStateOf(true)
        private set
    var segundaPulseira by mutableStateOf(false)
        private set

    // O que a tela do simulador mostra
    var postura by mutableStateOf(pulseira.postura)
        private set
    var atividade by mutableStateOf(pulseira.atividade)
        private set
    var situacao by mutableStateOf("")
        private set
    var conexoesAbertas by mutableIntStateOf(0)
        private set
    var quadrosEnviados by mutableIntStateOf(0)
        private set
    var quadrosPerdidos by mutableIntStateOf(0)
        private set
    var passoRoteiro by mutableStateOf<String?>(null)
        private set
    val registro = mutableStateListOf<String>()

    private var ultimoEstado: JSONObject? = null
    private var ultimoEstadoEm = 0L
    private var proximoEnvio = 0L
    private val avisos = MutableSharedFlow<String>(extraBufferCapacity = 32)
    private val pushes = mutableListOf<Push>()
    private val alertasPublicados = mutableSetOf<String>()
    private val prefixoAviso = agora()
    private var idAviso = 0
    private var roteiroJob: Job? = null
    private val formatoHora = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    private class Push(val alerta: PulseiraSimulada.Alerta, var proximo: Long) {
        var enviados = 0
        var falhas = 0
    }

    init {
        registrar("Simulador iniciado: pulseira VitalWatch12 e gateway prontos")
        escopo.launch {
            while (true) {
                passo()
                delay(100)
            }
        }
    }

    fun registrar(texto: String) {
        registro.add(0, "${formatoHora.format(Date())}  $texto")
        while (registro.size > 150) registro.removeAt(registro.lastIndex)
    }

    fun limparRegistro() = registro.clear()

    private fun passo() {
        val t = agora()
        val p = pulseira
        p.passo(t)
        if (pulseiraNoAr && (t >= proximoEnvio || p.alertaMudou)) {
            p.alertaMudou = false
            proximoEnvio = t + if (p.temAlertaAtivo) 1000 else 2000
            if (sinalFraco && Random.nextFloat() < 0.4f) {
                quadrosPerdidos++
            } else {
                ultimoEstado = p.estado(t)
                ultimoEstadoEm = t
            }
        }
        if (pulseiraNoAr) verificarNtfy(t)

        postura = p.postura
        atividade = p.atividade
        situacao = buildList {
            if (p.panicoAtivo) add("pânico travado")
            if (p.quedaDetectada) add("queda travada")
            val n = p.alertasAtivos().size
            add(if (n == 0) "sem alertas ativos" else "$n alerta(s) ativo(s)")
            if (ultimoEstado != null) add("último estado no gateway há ${(t - ultimoEstadoEm) / 1000} s")
        }.joinToString(" · ")
    }

    // O gateway considera a pulseira fora do ar após 6 s sem quadro
    private fun pulseiraOnline(t: Long) = ultimoEstado != null && t - ultimoEstadoEm <= 6000

    private fun rssi() = if (sinalFraco) -84 - Random.nextInt(5) else -58 - Random.nextInt(4)

    /** O JSON que o gateway publicaria agora, ou null quando ele fica em silêncio (nenhuma pulseira no ar). */
    private fun quadroDoGateway(t: Long): String? {
        val estado = ultimoEstado ?: return null
        if (!pulseiraOnline(t)) return null
        return JSONObject(estado.toString())
            .put(
                "gateway", JSONObject()
                    .put("name", "vitalwatchgateway")
                    .put("firmware", "0.1.0-sim")
                    .put("channel", 10)
                    .put("rssi", rssi())
                    .put("bands_online", if (segundaPulseira) 2 else 1)
                    .put("lost", quadrosPerdidos)
                    .put("age_ms", t - ultimoEstadoEm)
            )
            .toString()
    }

    // Gateway desligado da tomada: a conexão não é recusada, só não responde
    private suspend fun semResposta(): Nothing {
        delay(4000)
        throw SocketTimeoutException("gateway simulado desligado")
    }

    override fun aoVivo(baseUrl: String): Flow<GatewayClient.Ao> = flow {
        delay(400)
        if (!gatewayLigado) semResposta()
        conexoesAbertas++
        registrar("App conectou no WebSocket /ws")
        try {
            emit(GatewayClient.Ao.Aberto)
            while (true) {
                delay(250)
                if (!gatewayLigado) throw SocketException("Conexão perdida com o gateway")
                val quadro = quadroDoGateway(agora()) ?: continue
                quadrosEnviados++
                emit(GatewayClient.Ao.Quadro(Telemetria.de(quadro)))
            }
        } finally {
            conexoesAbertas--
        }
    }

    override suspend fun pulseiras(baseUrl: String): List<Pulseira> {
        delay(100)
        if (!gatewayLigado) semResposta()
        val t = agora()
        val p = pulseira
        val lista = JSONArray().put(
            JSONObject()
                .put("id", p.deviceId)
                .put("patient", p.paciente.nome)
                .put("online", pulseiraOnline(t))
                .put("age_ms", t - ultimoEstadoEm)
                .put("rssi", rssi())
                .put("alerts", p.alertasAtivos().size)
                .put("panic", p.panicoAtivo)
        )
        if (segundaPulseira) {
            lista.put(
                JSONObject().put("id", 7).put("patient", "Jose Lima").put("online", true)
                    .put("age_ms", 900).put("rssi", -63).put("alerts", 0).put("panic", false)
            )
        }
        return Pulseira.lista(lista.toString())
    }

    override suspend fun enviar(baseUrl: String, comando: GatewayClient.Comando, nivelBeep: Int): Int {
        delay(120)
        if (!gatewayLigado) semResposta()
        registrar("Gateway recebeu POST ${comando.caminho}")
        if (!pulseiraOnline(agora())) {
            registrar("Gateway respondeu 409: nenhuma pulseira no ar")
            return 409
        }
        escopo.launch {
            // O gateway repete o comando por ESP-NOW por até ~0,8 s, até o rádio da pulseira confirmar
            delay(Random.nextLong(40, 800))
            if (!pulseiraNoAr) {
                registrar("A pulseira não confirmou o comando (fora do alcance)")
                return@launch
            }
            val t = agora()
            when (comando) {
                GatewayClient.Comando.RECONHECER -> {
                    pulseira.reconhecer(t)
                    registrar("Pulseira: alertas reconhecidos, pânico e queda destravados")
                }
                GatewayClient.Comando.TESTE_PANICO -> {
                    pulseira.apertarBotao(t, teste = true)
                    registrar("Pulseira: pânico simulado")
                }
                GatewayClient.Comando.TESTE_QUEDA -> {
                    pulseira.cair(t, teste = true)
                    registrar("Pulseira: queda simulada")
                }
                GatewayClient.Comando.TESTE_BEEP -> registrar("Pulseira: buzzer tocou no nível $nivelBeep")
            }
        }
        return 200
    }

    /** O gateway publica no ntfy 3 vezes (0 s, 7 s e 14 s) enquanto o alerta continuar ativo. */
    private fun verificarNtfy(t: Long) {
        val ativos = pulseira.alertasAtivos()
        for (a in ativos) {
            if (alertasPublicados.add("${a.id}:${a.desde}")) pushes += Push(a, t)
        }
        val iterador = pushes.iterator()
        while (iterador.hasNext()) {
            val push = iterador.next()
            if (push.alerta !in ativos) {
                iterador.remove()
                continue
            }
            if (t < push.proximo) continue
            if (!ntfyComInternet) {
                push.falhas++
                if (push.falhas > 6) {
                    registrar("ntfy: desistiu de avisar \"${push.alerta.titulo}\"")
                    iterador.remove()
                } else {
                    registrar("ntfy sem internet: nova tentativa em 2,5 s")
                    push.proximo = t + 2500
                }
                continue
            }
            push.enviados++
            push.falhas = 0
            publicar(push.alerta, push.enviados)
            if (push.enviados >= 3) iterador.remove() else push.proximo = t + 7000
        }
    }

    private fun publicar(a: PulseiraSimulada.Alerta, n: Int) {
        val paciente = pulseira.paciente
        val critico = a.nivel == "critical"
        val linha = JSONObject()
            .put("id", "sim$prefixoAviso-${idAviso++}")
            .put("time", agora() / 1000)
            .put("event", "message")
            .put("topic", "vitalwatch-simulado")
            .put("title", "${a.titulo} - ${paciente.nome} (quarto ${paciente.quarto}) ($n/3)")
            .put("message", a.detalhe)
            .put("priority", if (critico) 5 else 3)
            .put("tags", JSONArray().put(if (critico) "rotating_light" else "warning"))
        avisos.tryEmit(linha.toString())
        registrar("ntfy: publicou \"${a.titulo}\" ($n/3)")
    }

    val ntfy = object : FonteNtfy {
        override fun assinar(servidor: String, topico: String, desde: String): Flow<NtfyClient.Evento> = flow {
            delay(300)
            emit(NtfyClient.Evento.Aberto)
            avisos.collect { emit(NtfyClient.Evento.Mensagem(NtfyMessage.de(JSONObject(it)))) }
        }

        override fun fechar() {}
    }

    suspend fun procurarNaRede(): List<GatewayDiscovery.Encontrado> {
        delay(1500)
        return if (gatewayLigado) {
            listOf(GatewayDiscovery.Encontrado("vitalwatchgateway (simulado)", "http://vitalwatchgateway.local"))
        } else {
            emptyList()
        }
    }

    // Ações da pulseira

    fun definirPostura(id: String) {
        pulseira.postura = id
        postura = id
    }

    fun definirAtividade(id: String) {
        pulseira.atividade = id
        atividade = id
        if (id == "walking") definirPostura("standing")
    }

    fun apertarBotao() {
        registrar("Pulseira: 3 toques no botão")
        pulseira.apertarBotao(agora())
    }

    fun cair() {
        registrar("Pulseira: queda (corpo leve, batida e imobilidade em ~2,4 s)")
        pulseira.cair(agora())
    }

    fun tremer(segundos: Int = 15) {
        registrar("Pulseira: tremor por $segundos s")
        pulseira.tremer(agora(), segundos)
    }

    fun agitar(segundos: Int = 10) {
        registrar("Pulseira: movimento atípico por $segundos s")
        pulseira.agitar(agora(), segundos)
    }

    fun reiniciarPulseira() {
        val paciente = pulseira.paciente
        pulseira = PulseiraSimulada(agora()).also { it.paciente = paciente }
        pushes.clear()
        alertasPublicados.clear()
        proximoEnvio = 0
        registrar("Pulseira reiniciada: o tempo e a numeração dos eventos recomeçam do zero")
    }

    // Situações de conexão

    fun ligarGateway(ligado: Boolean) {
        gatewayLigado = ligado
        registrar(if (ligado) "Gateway ligado na tomada" else "Gateway desligado da tomada")
    }

    fun colocarPulseiraNoAr(noAr: Boolean) {
        pulseiraNoAr = noAr
        registrar(
            if (noAr) "Pulseira voltou ao alcance do gateway"
            else "Pulseira fora do alcance (o gateway segue mandando o último estado por até 6 s)"
        )
    }

    fun usarSinalFraco(fraco: Boolean) {
        sinalFraco = fraco
        registrar(if (fraco) "Sinal fraco: 40% dos envios da pulseira se perdem" else "Sinal normal")
    }

    fun darInternetAoNtfy(com: Boolean) {
        ntfyComInternet = com
        registrar(if (com) "Gateway com internet para o ntfy" else "Gateway sem internet: pushes do ntfy falham")
    }

    fun mostrarSegundaPulseira(mostrar: Boolean) {
        segundaPulseira = mostrar
        registrar(if (mostrar) "Segunda pulseira (VitalWatch7) no gateway" else "Só a VitalWatch12 no gateway")
    }

    // Roteiro de demonstração

    fun iniciarRoteiro() {
        roteiroJob?.cancel()
        roteiroJob = escopo.launch {
            try {
                if (!gatewayLigado) ligarGateway(true)
                if (!pulseiraNoAr) colocarPulseiraNoAr(true)
                if (sinalFraco) usarSinalFraco(false)
                etapa("Paciente sentada e parada", 6000) {
                    definirPostura("sitting")
                    definirAtividade("rest")
                }
                etapa("Paciente andando pela casa", 8000) { definirAtividade("walking") }
                etapa("Paciente senta e começa um tremor de 12 s", 18_000) {
                    definirAtividade("rest")
                    definirPostura("sitting")
                    tremer(12)
                }
                etapa("Movimento atípico por 10 s", 15_000) { agitar(10) }
                etapa("Pedido de ajuda: 3 toques no botão", 0) { apertarBotao() }
                esperarReconhecimento()
                etapa("Paciente se levanta e anda", 5000) { definirAtividade("walking") }
                etapa("Queda", 0) { cair() }
                esperarReconhecimento()
                etapa("Pulseira fora do alcance por 12 s", 12_000) { colocarPulseiraNoAr(false) }
                etapa("Pulseira volta ao alcance", 4000) { colocarPulseiraNoAr(true) }
                etapa("Gateway desligado da tomada por 10 s", 10_000) { ligarGateway(false) }
                etapa("Gateway religado", 3000) { ligarGateway(true) }
                registrar("Roteiro: fim")
            } finally {
                passoRoteiro = null
            }
        }
    }

    fun pararRoteiro() {
        roteiroJob?.cancel()
        registrar("Roteiro interrompido")
    }

    private suspend fun etapa(titulo: String, duracaoMs: Long, acao: () -> Unit) {
        passoRoteiro = titulo
        registrar("Roteiro: $titulo")
        acao()
        delay(duracaoMs)
    }

    private suspend fun esperarReconhecimento() {
        delay(3500) // a queda leva ~2,4 s para ser confirmada
        passoRoteiro = "Esperando alguém tocar em \"Reconhecer alertas\" na aba Pulseira…"
        val limite = agora() + 30_000
        while (pulseira.temAlertaCritico && agora() < limite) delay(250)
        if (pulseira.temAlertaCritico) {
            registrar("Roteiro: ninguém reconheceu em 30 s, o simulador reconheceu sozinho")
            pulseira.reconhecer(agora())
        }
        delay(2000)
    }
}
