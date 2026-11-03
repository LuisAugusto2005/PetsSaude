package com.example.mypet.data

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.net.Inet4Address
import java.net.InetAddress
import java.util.Collections
import kotlin.coroutines.resume

/** Procura o gateway na rede local: pelo nome vitalwatchgateway.local e pelo serviço mDNS _http._tcp que ele anuncia. */
object GatewayDiscovery {

    data class Encontrado(val nome: String, val url: String)

    private const val HOST_PADRAO = "vitalwatchgateway.local"

    suspend fun procurar(context: Context, duracaoMs: Long = 6000): List<Encontrado> {
        val encontrados = mutableListOf<Encontrado>()

        withContext(Dispatchers.IO) {
            runCatching { InetAddress.getByName(HOST_PADRAO) }.getOrNull()
                ?.takeIf { it is Inet4Address }
                ?.let { encontrados += Encontrado(HOST_PADRAO, "http://${it.hostAddress}") }
        }

        val nsd = context.getSystemService(NsdManager::class.java) ?: return encontrados
        val servicos = Collections.synchronizedList(mutableListOf<NsdServiceInfo>())
        val listener = object : NsdManager.DiscoveryListener {
            override fun onServiceFound(info: NsdServiceInfo) {
                servicos.add(info)
            }
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onDiscoveryStarted(tipo: String) {}
            override fun onDiscoveryStopped(tipo: String) {}
            override fun onStartDiscoveryFailed(tipo: String, erro: Int) {}
            override fun onStopDiscoveryFailed(tipo: String, erro: Int) {}
        }
        nsd.discoverServices("_http._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
        try {
            delay(duracaoMs)
        } finally {
            runCatching { nsd.stopServiceDiscovery(listener) }
        }

        // Um resolve por vez: versões antigas do Android recusam resolves simultâneos
        val lista = synchronized(servicos) { servicos.distinctBy { it.serviceName }.take(15) }
        for (info in lista) {
            val r = resolver(nsd, info) ?: continue
            @Suppress("DEPRECATION")
            val host = r.host as? Inet4Address ?: continue
            val porta = if (r.port == 80) "" else ":${r.port}"
            val url = "http://${host.hostAddress}$porta"
            if (encontrados.none { it.url == url }) encontrados += Encontrado(r.serviceName, url)
        }
        return encontrados.sortedByDescending { it.nome.contains("vital", ignoreCase = true) }
    }

    @Suppress("DEPRECATION")
    private suspend fun resolver(nsd: NsdManager, info: NsdServiceInfo): NsdServiceInfo? =
        withTimeoutOrNull(3000) {
            suspendCancellableCoroutine { cont ->
                nsd.resolveService(info, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(s: NsdServiceInfo, erro: Int) = cont.resume(null)
                    override fun onServiceResolved(s: NsdServiceInfo) = cont.resume(s)
                })
            }
        }
}
