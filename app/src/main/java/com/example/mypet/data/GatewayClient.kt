package com.example.mypet.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/**
 * API do gateway na rede local (HTTP porta 80, sem autenticação).
 * Ver "VitalWatch_Comunicacao.pdf", seção 5. A pulseira em modo wifi serve as mesmas rotas, menos /api/bands.
 */
object GatewayClient : FonteGateway {

    private val http = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(4, TimeUnit.SECONDS)
        .build()

    // Sem quadro por um tempo é normal (nenhuma pulseira no ar): quem vigia o silêncio é o ViewModel
    private val ws = http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()

    fun normalizar(url: String): String {
        val limpo = url.trim().trimEnd('/')
        return if ("://" in limpo) limpo else "http://$limpo"
    }

    sealed interface Ao {
        data object Aberto : Ao
        data class Quadro(val telemetria: Telemetria) : Ao
    }

    /** Fluxo ao vivo: o gateway manda o JSON completo a cada 250 ms enquanto houver pulseira no ar. */
    override fun aoVivo(baseUrl: String): Flow<Ao> = callbackFlow<Any> {
        val pedido = Request.Builder().url(normalizar(baseUrl) + "/ws").build()
        val socket = ws.newWebSocket(pedido, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                trySend(SinalAberto)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                trySend(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                this@callbackFlow.close()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                this@callbackFlow.close(t)
            }
        })
        awaitClose { socket.cancel() }
    }
        // Com 4 quadros por segundo, só o mais recente interessa
        .conflate()
        .mapNotNull { item ->
            when (item) {
                SinalAberto -> Ao.Aberto
                is String -> runCatching { Ao.Quadro(Telemetria.de(item)) }.getOrNull()
                else -> null
            }
        }
        .flowOn(Dispatchers.Default)

    private object SinalAberto

    override suspend fun pulseiras(baseUrl: String): List<Pulseira> = withContext(Dispatchers.IO) {
        val pedido = Request.Builder().url(normalizar(baseUrl) + "/api/bands").build()
        http.newCall(pedido).execute().use { r ->
            if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
            Pulseira.lista(r.body?.string().orEmpty())
        }
    }

    enum class Comando(val caminho: String) {
        RECONHECER("/api/alerts/ack"),
        TESTE_PANICO("/api/test/panic"),
        TESTE_QUEDA("/api/test/fall"),
        TESTE_BEEP("/api/test/beep"),
    }

    override suspend fun enviar(baseUrl: String, comando: Comando, nivelBeep: Int): Int = withContext(Dispatchers.IO) {
        val corpo = FormBody.Builder().apply {
            if (comando == Comando.TESTE_BEEP) add("level", nivelBeep.coerceIn(1, 4).toString())
        }.build()
        val pedido = Request.Builder().url(normalizar(baseUrl) + comando.caminho).post(corpo).build()
        http.newCall(pedido).execute().use { it.code }
    }

    fun descreverErro(e: Throwable): String = when (e) {
        is UnknownHostException -> "Endereço não encontrado na rede. Use \"Procurar na rede\" ou digite o IP do gateway."
        is ConnectException -> "O gateway recusou a conexão. Confira o endereço."
        is SocketTimeoutException -> "O gateway não respondeu a tempo."
        else -> e.message ?: e.javaClass.simpleName
    }
}
