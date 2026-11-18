package com.example.mypet.data

import android.content.Context
import com.example.mypet.BuildConfig

data class AppSettings(
    // Nome mDNS do gateway (ou o IP dado pelo roteador, ou vitalwatch<N>.local com a pulseira em modo wifi)
    val gatewayUrl: String = "http://vitalwatchgateway.local",
    val ntfyServer: String = "https://ntfy.sh",
    // Mesmo tópico configurado no portal do gateway (na versão simulada, o ntfy também é simulado)
    val ntfyTopic: String = if (BuildConfig.SIMULADO) "vitalwatch-simulado" else "",
    /**
     * Endereço do backend. VAZIO = desligado, e é o padrão.
     *
     * Vazio não é "não configurado ainda": é o app funcionando como sempre,
     * só com o gateway na rede local. Quem não tem servidor continua usando
     * tudo o que já usava.
     *
     * Para desenvolvimento: "http://10.0.2.2:3000" no emulador (10.0.2.2 é o
     * atalho do emulador para o localhost da máquina) e o IP da máquina na
     * rede, tipo "http://192.168.68.75:3000", no celular de verdade.
     */
    /**
     * Servidor em produção no Render. Vazio desliga o backend: o app continua
     * funcionando só com o gateway na rede local, que é o uso offline.
     *
     * Só vale para instalação nova — quem já salvou um endereço mantém o dele.
     */
    val backendUrl: String = "https://vitalwatchserver.onrender.com",
)

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("vitalwatch", Context.MODE_PRIVATE)

    fun load(): AppSettings {
        val padrao = AppSettings()
        return AppSettings(
            gatewayUrl = prefs.getString(KEY_URL, null) ?: padrao.gatewayUrl,
            ntfyServer = prefs.getString(KEY_NTFY_SERVER, null) ?: padrao.ntfyServer,
            ntfyTopic = prefs.getString(KEY_NTFY_TOPIC, null) ?: padrao.ntfyTopic,
            backendUrl = prefs.getString(KEY_BACKEND_URL, null) ?: padrao.backendUrl,
        )
    }

    fun save(settings: AppSettings) {
        prefs.edit()
            .putString(KEY_URL, settings.gatewayUrl)
            .putString(KEY_NTFY_SERVER, settings.ntfyServer)
            .putString(KEY_NTFY_TOPIC, settings.ntfyTopic)
            .putString(KEY_BACKEND_URL, settings.backendUrl)
            .apply()
    }

    private companion object {
        const val KEY_URL = "gateway_url"
        const val KEY_NTFY_SERVER = "ntfy_server"
        const val KEY_NTFY_TOPIC = "ntfy_topic"
        const val KEY_BACKEND_URL = "backend_url"
    }
}
