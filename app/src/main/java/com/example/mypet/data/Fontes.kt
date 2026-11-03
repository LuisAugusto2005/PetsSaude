package com.example.mypet.data

import kotlinx.coroutines.flow.Flow

/** De onde vêm os dados do gateway: o de verdade ([GatewayClient]) ou o simulador (versão "simulado"). */
interface FonteGateway {
    fun aoVivo(baseUrl: String): Flow<GatewayClient.Ao>
    suspend fun pulseiras(baseUrl: String): List<Pulseira>

    /** Devolve o código HTTP: 200 = ok, 409 = nenhuma pulseira no ar. */
    suspend fun enviar(baseUrl: String, comando: GatewayClient.Comando, nivelBeep: Int = 2): Int
}

/** De onde vêm os avisos push: o ntfy de verdade ([NtfyClient]) ou o simulador. */
interface FonteNtfy {
    fun assinar(servidor: String, topico: String, desde: String): Flow<NtfyClient.Evento>
    fun fechar()
}
