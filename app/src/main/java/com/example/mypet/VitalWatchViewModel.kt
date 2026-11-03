package com.example.mypet

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.mypet.data.AppSettings
import com.example.mypet.data.FonteGateway
import com.example.mypet.data.FonteNtfy
import com.example.mypet.data.GatewayClient
import com.example.mypet.data.GatewayDiscovery
import com.example.mypet.data.NtfyClient
import com.example.mypet.data.NtfyMessage
import com.example.mypet.data.Pulseira
import com.example.mypet.data.SettingsStore
import com.example.mypet.data.Telemetria
import com.example.mypet.data.Textos
import com.example.mypet.simulacao.Simulador
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.abs

sealed interface Conexao {
    data object Parado : Conexao
    data object Conectando : Conexao
    data object Ok : Conexao
    data class Erro(val mensagem: String) : Conexao
}

/** Evento do diário da pulseira, carimbado com a hora do celular (a pulseira não tem relógio). */
data class RegistroEvento(val uid: Long, val deviceId: Int, val horaMs: Long, val titulo: String, val texto: String)

class VitalWatchViewModel(private val app: Application) : AndroidViewModel(app) {

    private val store = SettingsStore(app)
    var settings by mutableStateOf(store.load())
        private set

    // Gateway: fluxo ao vivo pelo WebSocket
    var gateway by mutableStateOf<Conexao>(Conexao.Conectando)
        private set
    var telemetria by mutableStateOf<Telemetria?>(null)
        private set
    var ultimoQuadro by mutableStateOf<Long?>(null)
        private set
    var pulseiras by mutableStateOf<List<Pulseira>>(emptyList())
        private set
    // A pulseira e o gateway guardam só os últimos 8 eventos; o histórico longo fica no app
    val historico = mutableStateListOf<RegistroEvento>()
    var enviando by mutableStateOf(false)
        private set
    var mensagemComando by mutableStateOf<String?>(null)
        private set

    // ntfy (avisos push)
    var ntfy by mutableStateOf<Conexao>(Conexao.Parado)
        private set
    val alertas = mutableStateListOf<NtfyMessage>()
    var naoLidos by mutableIntStateOf(0)
        private set

    // Tela de configurações
    var procurando by mutableStateOf(false)
        private set
    var encontrados by mutableStateOf<List<GatewayDiscovery.Encontrado>>(emptyList())
        private set
    var mensagemConfig by mutableStateOf<String?>(null)
        private set

    private var aoVivoJob: Job? = null
    private var pulseirasJob: Job? = null
    private var ntfyJob: Job? = null
    private val fonte: FonteGateway = if (BuildConfig.SIMULADO) Simulador else GatewayClient
    private val ntfyClient: FonteNtfy = if (BuildConfig.SIMULADO) Simulador.ntfy else NtfyClient()
    private val ultimoSeq = mutableMapOf<Int, Int>()
    private var proximoUid = 0L
    private var alertasAvisados = emptySet<String>()

    init {
        iniciarGateway()
        iniciarNtfy()
    }

    fun salvar(novas: AppSettings) {
        val trocouGateway = novas.gatewayUrl != settings.gatewayUrl
        settings = novas
        store.save(novas)
        mensagemConfig = "Configurações salvas"
        if (trocouGateway) {
            telemetria = null
            ultimoQuadro = null
            iniciarGateway()
        }
        iniciarNtfy()
    }

    fun marcarAlertasLidos() {
        naoLidos = 0
    }

    fun limparAlertas() {
        alertas.clear()
        naoLidos = 0
    }

    fun procurarGateway() {
        if (procurando) return
        procurando = true
        mensagemConfig = "Procurando na rede…"
        viewModelScope.launch {
            encontrados = if (BuildConfig.SIMULADO) Simulador.procurarNaRede() else GatewayDiscovery.procurar(app)
            mensagemConfig = if (encontrados.isEmpty()) {
                "Nada encontrado. Confira se o celular está no mesmo Wi-Fi do gateway ou digite o IP."
            } else {
                "Toque em um item para usar o endereço e depois em Salvar."
            }
            procurando = false
        }
    }

    fun reconhecerAlertas() =
        comando(GatewayClient.Comando.RECONHECER, "Alertas reconhecidos. Em até 1 s eles somem da tela.")

    fun testar(comando: GatewayClient.Comando, nivelBeep: Int = 2) =
        comando(comando, "Teste enviado à pulseira.", nivelBeep)

    private fun comando(comando: GatewayClient.Comando, sucesso: String, nivelBeep: Int = 2) {
        if (enviando) return
        enviando = true
        mensagemComando = null
        viewModelScope.launch {
            mensagemComando = try {
                when (val codigo = fonte.enviar(settings.gatewayUrl, comando, nivelBeep)) {
                    in 200..299 -> sucesso
                    409 -> "Nenhuma pulseira no ar para receber o comando."
                    else -> "O gateway respondeu HTTP $codigo."
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                "Falha ao enviar: ${GatewayClient.descreverErro(e)}"
            }
            enviando = false
            val mostrada = mensagemComando
            delay(6000)
            if (mensagemComando == mostrada) mensagemComando = null
        }
    }

    private fun iniciarGateway() {
        aoVivoJob?.cancel()
        pulseirasJob?.cancel()
        val url = settings.gatewayUrl
        gateway = Conexao.Conectando
        aoVivoJob = viewModelScope.launch {
            while (isActive) {
                try {
                    conectarAoVivo(url)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    gateway = Conexao.Erro(GatewayClient.descreverErro(e))
                }
                delay(3000)
            }
        }
        pulseirasJob = viewModelScope.launch {
            while (isActive) {
                // A pulseira em modo wifi não tem /api/bands: aí a lista fica vazia
                pulseiras = runCatching { fonte.pulseiras(url) }.getOrDefault(emptyList())
                delay(5000)
            }
        }
    }

    private suspend fun conectarAoVivo(url: String) = coroutineScope {
        var ultimaAtividade = System.currentTimeMillis()
        val coleta = launch {
            fonte.aoVivo(url).collect { ao ->
                ultimaAtividade = System.currentTimeMillis()
                when (ao) {
                    GatewayClient.Ao.Aberto -> gateway = Conexao.Ok
                    is GatewayClient.Ao.Quadro -> receber(ao.telemetria)
                }
            }
            gateway = Conexao.Erro("O gateway fechou a conexão")
        }
        // Sem pulseira no ar o gateway fica em silêncio. Se o silêncio for longo, reconecta,
        // porque o gateway pode ter sido desligado sem fechar o socket.
        val vigia = launch {
            while (true) {
                delay(5000)
                if (System.currentTimeMillis() - ultimaAtividade > 20_000) {
                    coleta.cancel()
                    break
                }
            }
        }
        coleta.join()
        vigia.cancel()
    }

    private fun receber(t: Telemetria) {
        telemetria = t
        ultimoQuadro = System.currentTimeMillis()
        registrarEventos(t)
        avisarAlertas(t)
    }

    private fun registrarEventos(t: Telemetria) {
        if (t.eventos.isEmpty()) return
        val maior = t.eventos.maxOf { it.seq }
        var ultimo = ultimoSeq[t.deviceId] ?: 0
        if (maior < ultimo) ultimo = 0 // a pulseira reiniciou e a numeração recomeçou
        val agora = System.currentTimeMillis()
        t.eventos.filter { it.seq > ultimo }.sortedBy { it.seq }.forEach { e ->
            val hora = agora - (t.timestampMs - e.tMs).coerceAtLeast(0)
            historico.add(0, RegistroEvento(proximoUid++, t.deviceId, hora, Textos.evento(e), e.texto))
        }
        ultimoSeq[t.deviceId] = maior
        while (historico.size > 200) historico.removeAt(historico.lastIndex)
    }

    // Com ntfy configurado o aviso chega por ele (funciona também fora de casa e com o app fechado)
    private fun avisarAlertas(t: Telemetria) {
        val ativos = t.alertas.filter { it.ativo }
        val chaves = ativos.associateBy { "${t.deviceId}:${it.id}:${it.sinceMs}" }
        if (settings.ntfyTopic.isBlank()) {
            val paciente = t.paciente.nome.ifBlank { t.deviceName }
            for ((chave, a) in chaves) {
                if (chave in alertasAvisados) continue
                Notifications.alerta(app, "${Textos.tituloAlerta(a)} - $paciente", Textos.detalheAlerta(a), chave.hashCode())
            }
        }
        alertasAvisados = chaves.keys
    }

    private fun iniciarNtfy() {
        ntfyJob?.cancel()
        ntfyClient.fechar()
        val s = settings
        if (s.ntfyTopic.isBlank()) {
            ntfy = Conexao.Parado
            return
        }
        val inicio = System.currentTimeMillis() / 1000
        ntfyJob = viewModelScope.launch {
            // Na primeira vez traz os avisos das últimas 12 h; depois continua do último recebido
            var desde = "12h"
            while (isActive) {
                ntfy = Conexao.Conectando
                try {
                    ntfyClient.assinar(s.ntfyServer, s.ntfyTopic, desde).collect { evento ->
                        when (evento) {
                            NtfyClient.Evento.Aberto -> ntfy = Conexao.Ok
                            is NtfyClient.Evento.Mensagem -> {
                                desde = evento.msg.id
                                receberAviso(evento.msg, inicio)
                            }
                        }
                    }
                    ntfy = Conexao.Erro("Conexão encerrada pelo servidor")
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    ntfy = Conexao.Erro(e.message ?: e.javaClass.simpleName)
                }
                delay(5000)
            }
        }
    }

    private val sufixoRepeticao = Regex("""\s*\(\d+/\d+\)\s*$""")

    private fun receberAviso(msg: NtfyMessage, inicio: Long) {
        if (alertas.any { it.id == msg.id }) return
        // O gateway manda cada alerta 3 vezes (0 s, 7 s e 14 s, com "(1/3)" no título): repetição não vira aviso novo
        val titulo = msg.title?.replace(sufixoRepeticao, "")
        if (alertas.any { it.title == titulo && abs(it.time - msg.time) <= 30 }) return
        alertas.add(0, msg.copy(title = titulo))
        // Mensagens antigas (do histórico do ntfy) entram na lista, mas não tocam notificação
        if (msg.time >= inicio) {
            naoLidos++
            Notifications.alerta(app, titulo ?: "VitalWatch", msg.message, msg.id.hashCode())
        }
    }

    override fun onCleared() {
        ntfyClient.fechar()
    }
}
