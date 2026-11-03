package com.example.mypet.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardColors
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.mypet.BuildConfig
import com.example.mypet.Conexao
import com.example.mypet.RegistroEvento
import com.example.mypet.VitalWatchViewModel
import com.example.mypet.data.GatewayClient
import com.example.mypet.data.Pulseira
import com.example.mypet.data.Telemetria
import com.example.mypet.data.Textos
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// Regras do PDF: sem quadro há mais de ~3 s (WebSocket) ou gateway com dado de mais de 6 s = "sem dados"
private const val SEM_QUADRO_MS = 3000L
private const val PULSEIRA_OFFLINE_MS = 6000L

@Composable
fun StatusScreen(vm: VitalWatchViewModel, abrirPainel: () -> Unit, abrirConfig: () -> Unit) {
    var agora by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(500)
            agora = System.currentTimeMillis()
        }
    }
    val t = vm.telemetria
    val ultimo = vm.ultimoQuadro
    val semDados = t == null || ultimo == null || agora - ultimo > SEM_QUADRO_MS ||
        (t.gateway?.ageMs ?: 0) > PULSEIRA_OFFLINE_MS

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { CartaoConexao(vm.gateway, vm.settings.gatewayUrl, t, ultimo, agora, semDados, abrirConfig, abrirPainel) }

        if (t != null) {
            // Os valores só aparecem enquanto são atuais; nunca mostramos o último valor como se fosse de agora
            if (!semDados) {
                items(t.alertas) { CartaoAlerta(it, t.timestampMs) }
                if (t.alertas.isNotEmpty() || t.panico.ativo || t.queda.detectada) {
                    item {
                        Button(onClick = vm::reconhecerAlertas, enabled = !vm.enviando, modifier = Modifier.fillMaxWidth()) {
                            Text("Reconhecer alertas")
                        }
                    }
                }
            }
            vm.mensagemComando?.let { item { Text(it, style = MaterialTheme.typography.bodySmall) } }
            item { CartaoPaciente(t.paciente, t.deviceName) }
            if (!semDados) item { GradeEstado(t) }
        }

        if (vm.pulseiras.size > 1) item { CartaoPulseiras(vm.pulseiras) }

        if (vm.historico.isNotEmpty()) {
            item { Text("Histórico", style = MaterialTheme.typography.titleMedium) }
            items(vm.historico, key = { it.uid }) { LinhaEvento(it) }
        }
        if (t != null) item { DetalhesTecnicos(t) }
        item {
            Text(
                "A pulseira sinaliza eventos para observação. Ela não faz diagnóstico.",
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}

@Composable
private fun CartaoConexao(
    conexao: Conexao,
    url: String,
    t: Telemetria?,
    ultimo: Long?,
    agora: Long,
    semDados: Boolean,
    abrirConfig: () -> Unit,
    abrirPainel: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    val (titulo, cor) = when {
        conexao is Conexao.Erro -> "Sem conexão com o gateway" to cs.errorContainer
        !semDados && t != null -> "Ao vivo · ${t.deviceName.ifBlank { "pulseira ${t.deviceId}" }}" to cs.primaryContainer
        conexao is Conexao.Ok -> "Gateway conectado · sem dados da pulseira" to cs.surfaceVariant
        else -> "Conectando ao gateway…" to cs.surfaceVariant
    }
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = cor)) {
        Column(Modifier.padding(16.dp)) {
            Text(titulo, style = MaterialTheme.typography.titleMedium)
            Text(GatewayClient.normalizar(url), style = MaterialTheme.typography.bodySmall)
            when {
                conexao is Conexao.Erro -> {
                    Text(conexao.mensagem, style = MaterialTheme.typography.bodySmall)
                    Row {
                        TextButton(onClick = abrirConfig) { Text("Configurar") }
                        TextButton(onClick = abrirPainel) { Text(if (BuildConfig.SIMULADO) "Abrir simulador" else "Abrir painel") }
                    }
                }
                !semDados && t != null -> t.gateway?.let {
                    Text("Sinal da pulseira ${it.rssi} dBm · canal ${it.canal}", style = MaterialTheme.typography.bodySmall)
                }
                conexao is Conexao.Ok -> {
                    if (ultimo != null) {
                        Text("Último dado há ${(agora - ultimo) / 1000} s", style = MaterialTheme.typography.bodySmall)
                    }
                    Text(
                        "A pulseira pode estar desligada, fora de alcance ou procurando o gateway.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

@Composable
private fun coresAlerta(a: Telemetria.Alerta): CardColors {
    val cs = MaterialTheme.colorScheme
    return when {
        !a.ativo -> CardDefaults.cardColors(containerColor = cs.surfaceVariant)
        a.critico -> CardDefaults.cardColors(containerColor = cs.error, contentColor = cs.onError)
        a.nivel == "warn" -> if (isSystemInDarkTheme()) {
            CardDefaults.cardColors(containerColor = Color(0xFF5D4200), contentColor = Color(0xFFFFDEA6))
        } else {
            CardDefaults.cardColors(containerColor = Color(0xFFFFDEA6), contentColor = Color(0xFF3E2D00))
        }
        else -> CardDefaults.cardColors(containerColor = cs.secondaryContainer)
    }
}

@Composable
private fun CartaoAlerta(a: Telemetria.Alerta, timestampMs: Long) {
    // active:false = a condição já normalizou; o alerta fica só como lembrete, esmaecido
    Card(
        Modifier
            .fillMaxWidth()
            .alpha(if (a.ativo) 1f else 0.6f),
        colors = coresAlerta(a),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Warning, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(
                    Textos.tituloAlerta(a),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
            }
            Text(Textos.detalheAlerta(a), style = MaterialTheme.typography.bodyMedium)
            val segundos = ((timestampMs - a.sinceMs) / 1000).coerceAtLeast(0)
            Text(
                if (a.ativo) "Começou há ${duracao(segundos)}" else "Já normalizou",
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}

@Composable
private fun CartaoPaciente(p: Telemetria.Paciente, aparelho: String) {
    val uri = LocalUriHandler.current
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(p.nome.ifBlank { "Paciente sem cadastro" }, style = MaterialTheme.typography.titleLarge)
            val linha = listOfNotNull(
                p.idade?.let { "$it anos" },
                p.quarto.ifBlank { null }?.let { "Quarto $it" },
                aparelho.ifBlank { null },
            ).joinToString(" · ")
            if (linha.isNotEmpty()) Text(linha, style = MaterialTheme.typography.bodyMedium)
            if (p.contato.isNotBlank()) {
                TextButton(onClick = { runCatching { uri.openUri("tel:" + p.contato.filter { it.isDigit() || it == '+' }) } }) {
                    Text("Ligar para o contato: ${p.contato}")
                }
            }
        }
    }
}

@Composable
private fun GradeEstado(t: Telemetria) {
    val m = t.movimento
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        LinhaDeDois(
            { Indicador("Postura", Textos.postura(t.postura), "Inclinação ${t.postura.inclinacao}°", it) },
            { Indicador("Movimento", Textos.movimento(m), "Energia ${numero(m.energia, 3)} g", it, destaque = m.atipico) },
        )
        LinhaDeDois(
            {
                Indicador(
                    "Tremor",
                    if (m.tremor) "Sim" else "Não",
                    if (m.tremor) "${numero(m.tremorFreq, 1)} Hz · ${duracao(m.tremorS.toLong())}" else " ",
                    it,
                    destaque = m.tremor,
                )
            },
            {
                Indicador(
                    "Queda",
                    if (t.queda.detectada) "Detectada" else Textos.faseQueda(t.queda.fase),
                    if (t.queda.simulada) "Simulada (teste)" else "${t.queda.contagem} no total",
                    it,
                    destaque = t.queda.detectada,
                )
            },
        )
        LinhaDeDois(
            {
                Indicador(
                    "Botão de ajuda",
                    if (t.panico.ativo) "Acionado" else "Normal",
                    "${t.panico.contagem} vez(es)",
                    it,
                    destaque = t.panico.ativo,
                )
            },
            {
                Indicador(
                    "Sensor",
                    when (t.sensor) {
                        "ok" -> "Funcionando"
                        "error" -> "Com erro"
                        "absent" -> "Ausente"
                        else -> t.sensor.ifBlank { "?" }
                    },
                    "Acelerômetro",
                    it,
                    destaque = t.sensor != "ok",
                )
            },
        )
    }
}

@Composable
private fun LinhaDeDois(esquerda: @Composable (Modifier) -> Unit, direita: @Composable (Modifier) -> Unit) {
    Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        esquerda(Modifier.weight(1f).fillMaxHeight())
        direita(Modifier.weight(1f).fillMaxHeight())
    }
}

@Composable
private fun Indicador(titulo: String, valor: String, detalhe: String, modifier: Modifier, destaque: Boolean = false) {
    val cores = if (destaque) {
        CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    } else {
        CardDefaults.cardColors()
    }
    Card(modifier, colors = cores) {
        Column(Modifier.padding(12.dp)) {
            Text(titulo, style = MaterialTheme.typography.labelMedium)
            Text(valor, style = MaterialTheme.typography.titleLarge)
            Text(detalhe, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun CartaoPulseiras(lista: List<Pulseira>) {
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Pulseiras neste gateway", style = MaterialTheme.typography.titleSmall)
            Text(
                "A tela mostra a pulseira em destaque: a de alerta mais grave.",
                style = MaterialTheme.typography.bodySmall,
            )
            lista.forEach { p ->
                val estado = if (p.online) "no ar" else "fora do ar"
                val alerta = if (p.panico) " · PEDIDO DE AJUDA" else if (p.alertas > 0) " · ${p.alertas} alerta(s)" else ""
                Text(
                    "VitalWatch${p.id} · ${p.paciente.ifBlank { "sem cadastro" }} · $estado$alerta",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

private val formatoHora = SimpleDateFormat("dd/MM HH:mm:ss", Locale.getDefault())

@Composable
private fun LinhaEvento(e: RegistroEvento) {
    Column {
        Text("${formatoHora.format(Date(e.horaMs))} · ${e.titulo}", style = MaterialTheme.typography.bodyMedium)
        if (e.texto.isNotBlank()) Text(e.texto, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun DetalhesTecnicos(t: Telemetria) {
    var aberto by rememberSaveable { mutableStateOf(false) }
    OutlinedCard(
        Modifier
            .fillMaxWidth()
            .clickable { aberto = !aberto },
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Detalhes técnicos ${if (aberto) "▲" else "▼"}", style = MaterialTheme.typography.titleSmall)
            if (aberto) {
                val linhas = buildList {
                    add("Pulseira" to "${t.deviceName} (nº ${t.deviceId})")
                    add("Firmware" to t.firmware)
                    add("Modo" to t.mode)
                    add("Envio" to t.link)
                    add("Ligada há" to duracao(t.uptimeS))
                    t.gateway?.let { g ->
                        add("Gateway" to "${g.nome} · firmware ${g.firmware}")
                        add("Canal Wi-Fi" to g.canal.toString())
                        add("Sinal" to "${g.rssi} dBm")
                        add("Quadros perdidos" to g.perdidos.toString())
                    }
                }
                linhas.forEach { (k, v) ->
                    Row {
                        Text(k, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        Text(v, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

private fun numero(valor: Double, casas: Int) = String.format(Locale.getDefault(), "%.${casas}f", valor)

private fun duracao(segundos: Long): String = when {
    segundos < 60 -> "$segundos s"
    segundos < 3600 -> "${segundos / 60} min ${segundos % 60} s"
    else -> "${segundos / 3600} h ${segundos % 3600 / 60} min"
}
