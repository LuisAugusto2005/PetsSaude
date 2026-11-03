package com.example.mypet.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class NtfyMessage(
    val id: String,
    val time: Long, // segundos (unix)
    val title: String?,
    val message: String,
    val priority: Int,
    val tags: List<String>,
) {
    companion object {
        fun de(obj: JSONObject): NtfyMessage {
            val tags = obj.optJSONArray("tags")
            return NtfyMessage(
                id = obj.optString("id"),
                time = obj.optLong("time", System.currentTimeMillis() / 1000),
                title = obj.optString("title").ifBlank { null },
                message = obj.optString("message"),
                priority = obj.optInt("priority", 3),
                tags = if (tags == null) emptyList() else (0 until tags.length()).map { tags.optString(it) },
            )
        }
    }
}

/**
 * Assinatura de um tópico do ntfy, por onde o gateway manda os avisos.
 * Usa o stream JSON do ntfy: uma mensagem JSON por linha.
 */
class NtfyClient : FonteNtfy {

    sealed interface Evento {
        data object Aberto : Evento
        data class Mensagem(val msg: NtfyMessage) : Evento
    }

    @Volatile
    private var conexao: HttpURLConnection? = null

    /** [desde] aceita um id de mensagem ou uma duração ("12h"), como na API do ntfy. */
    override fun assinar(servidor: String, topico: String, desde: String): Flow<Evento> = flow {
        val url = URL(
            GatewayClient.normalizar(servidor) + "/" + URLEncoder.encode(topico.trim(), "UTF-8") +
                "/json?since=" + URLEncoder.encode(desde, "UTF-8")
        )
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 90_000 // o ntfy manda "keepalive" a cada ~45 s
        conexao = conn
        try {
            if (conn.responseCode !in 200..299) throw IOException("ntfy respondeu HTTP ${conn.responseCode}")
            conn.inputStream.bufferedReader().use { leitor ->
                while (true) {
                    val linha = leitor.readLine() ?: break
                    if (linha.isBlank()) continue
                    val obj = JSONObject(linha)
                    when (obj.optString("event")) {
                        "open" -> emit(Evento.Aberto)
                        "message" -> emit(Evento.Mensagem(NtfyMessage.de(obj)))
                    }
                }
            }
        } finally {
            conn.disconnect()
            if (conexao === conn) conexao = null
        }
    }.flowOn(Dispatchers.IO)

    /** Interrompe a leitura bloqueada no socket. */
    override fun fechar() {
        conexao?.disconnect()
    }
}
