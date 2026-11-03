package com.example.mypet.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.example.mypet.BuildConfig
import com.example.mypet.VitalWatchViewModel
import com.example.mypet.data.AppSettings
import com.example.mypet.data.GatewayClient

@Composable
fun SettingsScreen(vm: VitalWatchViewModel) {
    val s = vm.settings
    var url by rememberSaveable(s) { mutableStateOf(s.gatewayUrl) }
    var servidor by rememberSaveable(s) { mutableStateOf(s.ntfyServer) }
    var topico by rememberSaveable(s) { mutableStateOf(s.ntfyTopic) }
    var nivelBeep by rememberSaveable { mutableIntStateOf(2) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (BuildConfig.SIMULADO) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
                Text(
                    "Versão simulada: o endereço e o tópico abaixo não são usados de verdade. " +
                        "Deixe o tópico vazio para testar os avisos sem ntfy.",
                    modifier = Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        Text("Gateway", style = MaterialTheme.typography.titleLarge)
        Text(
            "A pulseira envia os dados por ESP-NOW para o gateway ligado na tomada. " +
                "O celular precisa estar no mesmo Wi-Fi que ele. Com a pulseira em modo wifi, " +
                "use o endereço dela (vitalwatch<N>.local).",
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Endereço do gateway") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedButton(onClick = vm::procurarGateway, enabled = !vm.procurando) {
            Icon(Icons.Default.Search, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("Procurar na rede")
        }
        vm.encontrados.forEach { item ->
            ListItem(
                headlineContent = { Text(item.nome) },
                supportingContent = { Text(item.url) },
                modifier = Modifier.clickable { url = item.url },
            )
        }
        if (vm.procurando) LinearProgressIndicator(Modifier.fillMaxWidth())

        HorizontalDivider()

        Text("Notificações (ntfy)", style = MaterialTheme.typography.titleLarge)
        Text(
            "Use o mesmo tópico configurado no portal do gateway. Deixe vazio para o app avisar " +
                "só pelos dados ao vivo do gateway. Tópico público do ntfy é aberto: quem souber o nome lê.",
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedTextField(
            value = servidor,
            onValueChange = { servidor = it },
            label = { Text("Servidor ntfy") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = topico,
            onValueChange = { topico = it },
            label = { Text("Tópico") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        Button(
            onClick = {
                val padrao = AppSettings()
                vm.salvar(
                    AppSettings(
                        gatewayUrl = url.trim().ifEmpty { padrao.gatewayUrl },
                        ntfyServer = servidor.trim().ifEmpty { padrao.ntfyServer },
                        ntfyTopic = topico.trim(),
                    )
                )
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Salvar") }
        vm.mensagemConfig?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }

        HorizontalDivider()

        Text("Testes", style = MaterialTheme.typography.titleLarge)
        Text(
            "Os testes geram alertas de verdade no painel e no ntfy. Depois, reconheça na aba Pulseira.",
            style = MaterialTheme.typography.bodySmall,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { vm.testar(GatewayClient.Comando.TESTE_PANICO) }, enabled = !vm.enviando) {
                Text("Simular pânico")
            }
            OutlinedButton(onClick = { vm.testar(GatewayClient.Comando.TESTE_QUEDA) }, enabled = !vm.enviando) {
                Text("Simular queda")
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Buzzer:", style = MaterialTheme.typography.bodyMedium)
            (1..4).forEach { n ->
                FilterChip(selected = nivelBeep == n, onClick = { nivelBeep = n }, label = { Text("$n") })
            }
        }
        OutlinedButton(onClick = { vm.testar(GatewayClient.Comando.TESTE_BEEP, nivelBeep) }, enabled = !vm.enviando) {
            Text("Tocar buzzer (nível $nivelBeep)")
        }
        vm.mensagemComando?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }

        Text(
            "Protótipo em desenvolvimento. Não substitui avaliação clínica.",
            style = MaterialTheme.typography.labelSmall,
        )
    }
}
