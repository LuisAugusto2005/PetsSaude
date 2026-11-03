package com.example.mypet.data

import android.content.Context
import com.example.mypet.BuildConfig

data class AppSettings(
    // Nome mDNS do gateway (ou o IP dado pelo roteador, ou vitalwatch<N>.local com a pulseira em modo wifi)
    val gatewayUrl: String = "http://vitalwatchgateway.local",
    val ntfyServer: String = "https://ntfy.sh",
    // Mesmo tópico configurado no portal do gateway (na versão simulada, o ntfy também é simulado)
    val ntfyTopic: String = if (BuildConfig.SIMULADO) "vitalwatch-simulado" else "",
)

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("vitalwatch", Context.MODE_PRIVATE)

    fun load(): AppSettings {
        val padrao = AppSettings()
        return AppSettings(
            gatewayUrl = prefs.getString(KEY_URL, null) ?: padrao.gatewayUrl,
            ntfyServer = prefs.getString(KEY_NTFY_SERVER, null) ?: padrao.ntfyServer,
            ntfyTopic = prefs.getString(KEY_NTFY_TOPIC, null) ?: padrao.ntfyTopic,
        )
    }

    fun save(settings: AppSettings) {
        prefs.edit()
            .putString(KEY_URL, settings.gatewayUrl)
            .putString(KEY_NTFY_SERVER, settings.ntfyServer)
            .putString(KEY_NTFY_TOPIC, settings.ntfyTopic)
            .apply()
    }

    private companion object {
        const val KEY_URL = "gateway_url"
        const val KEY_NTFY_SERVER = "ntfy_server"
        const val KEY_NTFY_TOPIC = "ntfy_topic"
    }
}
