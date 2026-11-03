package com.example.mypet.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.example.mypet.simulacao.Simulador

/** Painel de controle da versão simulada: provoca situações na pulseira e no gateway de mentira. */
@Composable
fun SimulatorScreen() {
    val sim = Simulador
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
                Column(Modifier.padding(16.dp)) {
                    Text("Modo simulado", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "Nenhuma conexão real é feita. A pulseira e o gateway daqui geram o mesmo JSON do " +
                            "firmware, que passa pelo mesmo código do app real.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }

        item {
            Secao("Roteiro de demonstração") {
                val passo = sim.passoRoteiro
                if (passo == null) {
                    Text(
                        "Passa sozinho por andar, tremor, movimento atípico, pedido de ajuda, queda, " +
                            "pulseira fora do alcance e gateway desligado (cerca de 2 min).",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Button(onClick = sim::iniciarRoteiro, modifier = Modifier.fillMaxWidth()) { Text("Iniciar roteiro") }
                } else {
                    Text("Agora: $passo", style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = sim::pararRoteiro, modifier = Modifier.fillMaxWidth()) { Text("Parar roteiro") }
                }
            }
        }

        item {
            Secao("Pulseira") {
                Text("Situação: ${sim.situacao}", style = MaterialTheme.typography.bodySmall)
                Text("Postura", style = MaterialTheme.typography.labelMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("standing" to "Em pé", "sitting" to "Sentado", "lying" to "Deitado").forEach { (id, nome) ->
                        FilterChip(selected = sim.postura == id, onClick = { sim.definirPostura(id) }, label = { Text(nome) })
                    }
                }
                Text("Atividade", style = MaterialTheme.typography.labelMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("rest" to "Parado", "light" to "Leve", "walking" to "Andando").forEach { (id, nome) ->
                        FilterChip(selected = sim.atividade == id, onClick = { sim.definirAtividade(id) }, label = { Text(nome) })
                    }
                }
                DoisBotoes("3 toques no botão", sim::apertarBotao, "Queda", sim::cair)
                DoisBotoes("Tremor 15 s", { sim.tremer() }, "Mov. atípico 10 s", { sim.agitar() })
                OutlinedButton(onClick = sim::reiniciarPulseira, modifier = Modifier.fillMaxWidth()) {
                    Text("Reiniciar pulseira")
                }
            }
        }

        item {
            Secao("Conexões") {
                Chave("Gateway ligado na tomada", sim.gatewayLigado, sim::ligarGateway)
                Chave("Pulseira no alcance do gateway", sim.pulseiraNoAr, sim::colocarPulseiraNoAr)
                Chave("Sinal fraco (perde envios)", sim.sinalFraco, sim::usarSinalFraco)
                Chave("Gateway com internet (ntfy)", sim.ntfyComInternet, sim::darInternetAoNtfy)
                Chave("Segunda pulseira no gateway", sim.segundaPulseira, sim::mostrarSegundaPulseira)
                Text(
                    "WebSocket aberto: ${sim.conexoesAbertas} · quadros enviados: ${sim.quadrosEnviados} · " +
                        "envios perdidos: ${sim.quadrosPerdidos}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Registro", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = sim::limparRegistro) { Text("Limpar") }
            }
        }
        items(sim.registro) { linha ->
            Text(linha, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
        }
    }
}

@Composable
private fun Secao(titulo: String, conteudo: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(titulo, style = MaterialTheme.typography.titleMedium)
            conteudo()
        }
    }
}

@Composable
private fun DoisBotoes(texto1: String, acao1: () -> Unit, texto2: String, acao2: () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = acao1, modifier = Modifier.weight(1f)) { Text(texto1) }
        OutlinedButton(onClick = acao2, modifier = Modifier.weight(1f)) { Text(texto2) }
    }
}

@Composable
private fun Chave(texto: String, ligado: Boolean, aoMudar: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(texto, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Switch(checked = ligado, onCheckedChange = aoMudar)
    }
}
