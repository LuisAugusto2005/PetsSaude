package com.example.mypet.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * Cliente do backend do VitalWatch.
 *
 * Separado do [GatewayClient] de propósito, e não implementando [FonteGateway]:
 * aquela interface é moldada ao gateway — `baseUrl` em cada chamada, comandos
 * que são caminhos de rota do ESP32, retorno `Int` de código HTTP com 409
 * querendo dizer "nenhuma pulseira no ar". Forçar o backend ali distorceria as
 * duas pontas.
 *
 * Timeouts bem maiores que os 4 s do gateway: o gateway está na mesma rede e
 * ou responde na hora ou está desligado; o backend pode estar na internet, e no
 * plano gratuito do Render ele hiberna e leva alguns segundos para acordar.
 */
object BackendClient {

    /**
     * Timeouts bem mais largos que os 4 s do gateway, e o de leitura é o que
     * importa.
     *
     * O gateway está na mesma rede: ou responde na hora, ou está desligado. O
     * Render gratuito HIBERNA depois de 15 min sem tráfego, e a primeira
     * requisição depois disso leva cerca de 50 s (está escrito no próprio
     * render.yaml do backend). A conexão TCP é aceita rápido pelo roteador do
     * Render — quem demora é a resposta, então é o readTimeout que precisa
     * caber nisso. Com 30 s, o primeiro login do dia falharia sempre.
     */
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(70, TimeUnit.SECONDS)
        .build()

    private val JSON = "application/json; charset=utf-8".toMediaType()

    /** Endereço de rede local: aí http é o certo, e não há TLS para usar. */
    private val pareceLocal = Regex(
        """^(localhost|10\.0\.2\.2|\d{1,3}(\.\d{1,3}){3})(:\d+)?$|\.local(:\d+)?$"""
    )

    /**
     * Completa o endereço que a pessoa digitou.
     *
     * Diferente do [GatewayClient.normalizar], que sempre assume http: o
     * gateway é um ESP32 na rede local e não tem TLS. Aqui o padrão para um
     * domínio é **https**, porque o destino típico é o Render, que redireciona
     * http para https com 301 — e o OkHttp, ao seguir um 301 de POST, troca o
     * método por GET e deixa o corpo para trás. O login falharia com uma
     * mensagem que não explica nada.
     *
     * IP, localhost, 10.0.2.2 (o atalho do emulador) e nomes .local continuam
     * em http, que é o que existe em rede local.
     */
    fun normalizar(url: String): String {
        val limpo = url.trim().trimEnd('/')
        if ("://" in limpo) return limpo
        return if (pareceLocal.containsMatchIn(limpo)) "http://$limpo" else "https://$limpo"
    }

    /**
     * Erro vindo do backend, já com o código da API.
     *
     * O `codigo` é o que permite a tela dizer a coisa certa: ACCOUNT_PENDING é
     * "aguarde aprovação", não "senha incorreta". Foi para isso que o backend
     * separa esses dois casos em vez de devolver um 401 genérico.
     */
    class ErroApi(val http: Int, val codigo: String?, mensagem: String) : IOException(mensagem)

    data class Credenciais(
        val accessToken: String,
        val refreshToken: String,
        val email: String,
        val nome: String,
        val papeis: List<String>,
    )

    data class PacienteBackend(val id: String, val nome: String)

    data class AlertaBackend(
        val id: String,
        val chave: String,
        val nivel: String,
        val status: String,
        val detalhe: String?,
        val primeiroEmMs: Long,
        val travado: Boolean,
        val reconhecidoEmMs: Long?,
    ) {
        val critico get() = nivel == "critical"
        val reconhecido get() = status == "acknowledged"
    }

    /** Uma linha da linha do tempo do paciente, já persistida no servidor. */
    data class EventoBackend(
        val emMs: Long,
        val tipo: String,
        val detalhe: String,
        val por: String?,
    )

    data class ResultadoIngestao(
        val gravadas: Int,
        val duplicadas: Int,
        val amostradas: Int,
        val alertasCriados: Int,
    )

    // --- Autenticação -----------------------------------------------------

    suspend fun login(baseUrl: String, email: String, senha: String): Credenciais =
        withContext(Dispatchers.IO) {
            val corpo = JSONObject().put("email", email).put("password", senha)
            credenciaisDe(postJson(baseUrl, "/api/auth/login", corpo, null))
        }

    /**
     * Troca o refresh token por um par novo.
     *
     * O backend ROTACIONA: o refresh usado é marcado e um novo é emitido, e se
     * um já usado reaparecer ele revoga a família toda por suspeita de roubo.
     * Por isso o token novo tem de ser guardado — reusar o antigo derruba a
     * sessão inteira, não só a chamada.
     */
    suspend fun refresh(baseUrl: String, refreshToken: String): Pair<String, String> =
        withContext(Dispatchers.IO) {
            val j = postJson(
                baseUrl,
                "/api/auth/refresh",
                JSONObject().put("refreshToken", refreshToken),
                null,
            )
            j.getString("accessToken") to j.getString("refreshToken")
        }

    suspend fun logout(baseUrl: String, refreshToken: String, access: String) =
        withContext(Dispatchers.IO) {
            runCatching {
                postJson(
                    baseUrl,
                    "/api/auth/logout",
                    JSONObject().put("refreshToken", refreshToken),
                    access,
                )
            }
            Unit
        }

    // --- Leitura ----------------------------------------------------------

    suspend fun pacientes(baseUrl: String, access: String): List<PacienteBackend> =
        withContext(Dispatchers.IO) {
            val itens = getJson(baseUrl, "/api/patients?limit=50", access).optJSONArray("itens")
            lista(itens) { PacienteBackend(it.getString("id"), it.optString("name")) }
        }

    suspend fun alertas(baseUrl: String, access: String, pacienteId: String): List<AlertaBackend> =
        withContext(Dispatchers.IO) {
            val itens = getJson(baseUrl, "/api/patients/$pacienteId/alerts?limit=50", access)
                .optJSONArray("itens")
            lista(itens) {
                AlertaBackend(
                    id = it.getString("id"),
                    chave = it.optString("alertKey"),
                    nivel = it.optString("level"),
                    status = it.optString("status"),
                    detalhe = it.optString("detail").ifBlank { null },
                    primeiroEmMs = instante(it.optString("firstSeenAt")),
                    travado = it.optBoolean("isLatched"),
                    reconhecidoEmMs = it.optString("acknowledgedAt")
                        .ifBlank { null }?.let { s -> instante(s) },
                )
            }
        }

    suspend fun historico(baseUrl: String, access: String, pacienteId: String): List<EventoBackend> =
        withContext(Dispatchers.IO) {
            val itens = getJson(baseUrl, "/api/patients/$pacienteId/history?limit=50", access)
                .optJSONArray("itens")
            lista(itens) {
                EventoBackend(
                    emMs = instante(it.optString("at")),
                    tipo = it.optString("tipo"),
                    detalhe = it.optString("detalhe"),
                    por = it.optJSONObject("por")?.optString("nome"),
                )
            }
        }

    // --- Escrita ----------------------------------------------------------

    /**
     * Reconhece o alerta no servidor: registra QUEM atendeu e quando.
     *
     * Não substitui o `/api/alerts/ack` do gateway, soma a ele. O ack do
     * backend não chega à pulseira (não existe canal de descida), e o ack do
     * gateway não registra quem foi. São os dois, não um ou outro.
     */
    suspend fun reconhecer(baseUrl: String, access: String, alertaId: String) =
        withContext(Dispatchers.IO) {
            postJson(baseUrl, "/api/alerts/$alertaId/acknowledge", JSONObject(), access)
            Unit
        }

    /**
     * Repassa ao backend os frames recebidos do gateway.
     *
     * Manda o JSON **cru**, exatamente como chegou. Reinterpretar aqui perderia
     * os campos que este app não lê e que uma versão nova de firmware pode
     * acrescentar — e o servidor precisa do mesmo documento nos dois caminhos
     * de entrega. Ver docs/contrato-firmware.md no backend.
     */
    suspend fun enviarTelemetria(
        baseUrl: String,
        access: String,
        framesCrus: List<String>,
    ): ResultadoIngestao = withContext(Dispatchers.IO) {
        val lote = JSONArray()
        framesCrus.forEach { lote.put(JSONObject(it)) }
        val pedido = Request.Builder()
            .url(normalizar(baseUrl) + "/api/ingest/telemetry")
            .header("Authorization", "Bearer $access")
            .post(lote.toString().toRequestBody(JSON))
            .build()
        val j = executar(pedido)
        ResultadoIngestao(
            gravadas = j.optInt("gravadas"),
            duplicadas = j.optInt("duplicadas"),
            amostradas = j.optInt("amostradas"),
            alertasCriados = j.optJSONObject("alertas")?.optInt("criados") ?: 0,
        )
    }

    // --- Encanamento ------------------------------------------------------

    private fun credenciaisDe(j: JSONObject): Credenciais {
        val u = j.optJSONObject("usuario") ?: JSONObject()
        val papeis = u.optJSONArray("roles")
        return Credenciais(
            accessToken = j.getString("accessToken"),
            refreshToken = j.getString("refreshToken"),
            email = u.optString("email"),
            nome = u.optString("name"),
            papeis = (0 until (papeis?.length() ?: 0)).map { papeis!!.optString(it) },
        )
    }

    private fun <T> lista(array: JSONArray?, parse: (JSONObject) -> T): List<T> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { i ->
            array.optJSONObject(i)?.let { runCatching { parse(it) }.getOrNull() }
        }
    }

    private fun getJson(baseUrl: String, caminho: String, access: String): JSONObject {
        val pedido = Request.Builder()
            .url(normalizar(baseUrl) + caminho)
            .header("Authorization", "Bearer $access")
            .build()
        return executar(pedido)
    }

    private fun postJson(
        baseUrl: String,
        caminho: String,
        corpo: JSONObject,
        access: String?,
    ): JSONObject {
        val b = Request.Builder()
            .url(normalizar(baseUrl) + caminho)
            .post(corpo.toString().toRequestBody(JSON))
        if (access != null) b.header("Authorization", "Bearer $access")
        return executar(b.build())
    }

    private fun executar(pedido: Request): JSONObject {
        http.newCall(pedido).execute().use { r ->
            val texto = r.body?.string().orEmpty()
            // 204 do logout, e qualquer resposta vazia, viram objeto vazio.
            val j = if (texto.isBlank()) JSONObject() else runCatching { JSONObject(texto) }
                .getOrElse { JSONObject() }
            if (r.isSuccessful) return j
            val erro = j.optJSONObject("erro")
            throw ErroApi(
                http = r.code,
                codigo = erro?.optString("codigo")?.ifBlank { null },
                mensagem = erro?.optString("mensagem")?.ifBlank { null }
                    ?: "O servidor respondeu HTTP ${r.code}",
            )
        }
    }

    /**
     * ISO do servidor para millis locais.
     *
     * SimpleDateFormat e não java.time porque o minSdk é 24 e o projeto não tem
     * desugaring da biblioteca padrão — java.time só existe a partir da API 26.
     */
    private val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    private fun instante(texto: String): Long {
        if (texto.isBlank()) return 0L
        // Corta os milissegundos e o Z: "2026-11-18T16:09:58.248Z" -> 19 chars.
        val base = texto.take(19)
        return synchronized(iso) { runCatching { iso.parse(base)?.time ?: 0L }.getOrDefault(0L) }
    }

    fun descreverErro(e: Throwable): String = when (e) {
        is ErroApi -> e.message ?: "Erro ${e.http}"
        is UnknownHostException -> "Endereço do servidor não encontrado. Confira o endereço em Config."
        is ConnectException ->
            "O servidor recusou a conexão. Ele está rodando? No celular, use o IP da máquina, não localhost."
        is SocketTimeoutException -> "O servidor não respondeu a tempo."
        else -> e.message ?: e.javaClass.simpleName
    }
}
