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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.example.mypet.Conexao
import com.example.mypet.VitalWatchViewModel
import com.example.mypet.data.NtfyMessage
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun AlertsScreen(vm: VitalWatchViewModel) {
    // Com a aba aberta, todo aviso que chega já conta como lido
    LaunchedEffect(vm.alertas.size) { vm.marcarAlertasLidos() }

    val situacao = when (val c = vm.ntfy) {
        Conexao.Parado -> "ntfy não configurado"
        Conexao.Conectando -> "Conectando ao ntfy…"
        Conexao.Ok -> "Recebendo avisos do tópico \"${vm.settings.ntfyTopic}\""
        is Conexao.Erro -> "Erro no ntfy: ${c.mensagem} (tentando de novo)"
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Avisos (ntfy)", style = MaterialTheme.typography.titleLarge)
                Text(situacao, style = MaterialTheme.typography.bodySmall)
            }
            if (vm.alertas.isNotEmpty()) {
                TextButton(onClick = vm::limparAlertas) { Text("Limpar") }
            }
        }
        when {
            vm.settings.ntfyTopic.isBlank() -> Text(
                "Configure na aba Config. o tópico do ntfy usado pelo gateway. Enquanto isso, o app avisa " +
                    "pelos dados ao vivo do gateway, com o app aberto e na mesma rede.",
                modifier = Modifier.padding(horizontal = 16.dp),
                style = MaterialTheme.typography.bodyMedium,
            )
            vm.alertas.isEmpty() -> Text(
                "Nenhum aviso nas últimas 12 horas.",
                modifier = Modifier.padding(horizontal = 16.dp),
                style = MaterialTheme.typography.bodyMedium,
            )
            else -> LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(vm.alertas, key = { it.id }) { CartaoAviso(it) }
            }
        }
    }
}

private val formatoHora = SimpleDateFormat("dd/MM HH:mm:ss", Locale.getDefault())

@Composable
private fun CartaoAviso(msg: NtfyMessage) {
    // O gateway usa prioridade 5 para alerta crítico e 3 para os demais
    val cores = if (msg.priority >= 5) {
        CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    } else {
        CardDefaults.cardColors()
    }
    Card(Modifier.fillMaxWidth(), colors = cores) {
        Column(Modifier.padding(16.dp)) {
            Text(formatoHora.format(Date(msg.time * 1000)), style = MaterialTheme.typography.labelSmall)
            msg.title?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
            Text(msg.message, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
