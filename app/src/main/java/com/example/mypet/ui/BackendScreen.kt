package com.example.mypet.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.example.mypet.VitalWatchViewModel
import com.example.mypet.data.BackendClient
import com.example.mypet.data.Sessao
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * A aba do servidor: o que o gateway não dá.
 *
 * O que entra aqui é o que só existe com backend — histórico que sobrevive a
 * fechar o app, o paciente vindo do cadastro em vez do frame da pulseira, e o
 * registro de quem atendeu cada alerta. O tempo real continua na aba Pulseira,
 * pelo gateway, porque ali ele é melhor: 250 ms contra 30 s de polling.
 */
@Composable
fun BackendScreen(vm: VitalWatchViewModel, abrirConfig: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        when (val s = vm.sessao) {
            Sessao.Desligada -> Desligada(abrirConfig)
            Sessao.Deslogado, is Sessao.Erro, Sessao.Entrando -> Login(vm, s)
            is Sessao.Ativa -> Conectado(vm, s)
        }

        vm.mensagemBackend?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }
    }
}

@Composable
private fun Desligada(abrirConfig: () -> Unit) {
    Text("Servidor desligado", style = MaterialTheme.typography.titleLarge)
    Text(
        "O app está funcionando só com o gateway na rede local — que é o suficiente para " +
            "acompanhar a pulseira ao vivo dentro de casa.\n\n" +
            "Com um servidor configurado entram três coisas que o gateway não dá: histórico que " +
            "não se perde ao fechar o app, o nome do paciente vindo do cadastro, e o registro de " +
            "quem atendeu cada alerta.",
        style = MaterialTheme.typography.bodyMedium,
    )
    Button(onClick = abrirConfig) { Text("Configurar o endereço") }
}

@Composable
private fun Login(vm: VitalWatchViewModel, sessao: Sessao) {
    var email by rememberSaveable { mutableStateOf("") }
    var senha by rememberSaveable { mutableStateOf("") }

    Text("Entrar no servidor", style = MaterialTheme.typography.titleLarge)
    Text(
        "A conta é a mesma do cadastro feito pela enfermagem. Enquanto você não entrar, " +
            "a aba Pulseira continua funcionando normalmente.",
        style = MaterialTheme.typography.bodySmall,
    )
    OutlinedTextField(
        value = email,
        onValueChange = { email = it },
        label = { Text("E-mail") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = senha,
        onValueChange = { senha = it },
        label = { Text("Senha") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        modifier = Modifier.fillMaxWidth(),
    )
    Button(
        onClick = { vm.entrar(email, senha) },
        enabled = sessao !is Sessao.Entrando && email.isNotBlank() && senha.isNotBlank(),
        modifier = Modifier.fillMaxWidth(),
    ) { Text(if (sessao is Sessao.Entrando) "Entrando…" else "Entrar") }

    if (sessao is Sessao.Entrando) LinearProgressIndicator(Modifier.fillMaxWidth())

    // A mensagem vem do servidor, que distingue "aguarde aprovação" de
    // "conta desativada" de "senha incorreta". Reescrever aqui perderia isso.
    if (sessao is Sessao.Erro) {
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
            Text(sessao.mensagem, Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun Conectado(vm: VitalWatchViewModel, sessao: Sessao.Ativa) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column {
            Text(sessao.nome.ifBlank { sessao.email }, style = MaterialTheme.typography.titleMedium)
            Text(
                sessao.papeis.joinToString(", ").ifBlank { sessao.email },
                style = MaterialTheme.typography.bodySmall,
            )
        }
        TextButton(onClick = vm::sair) { Text("Sair") }
    }

    if (vm.carregandoBackend) LinearProgressIndicator(Modifier.fillMaxWidth())

    if (vm.pacientes.isEmpty()) {
        Card {
            Text(
                "Nenhum paciente vinculado a esta conta. Quem dá acesso a um paciente é quem o " +
                    "cadastrou, pela enfermagem — o papel sozinho não dá acesso a ninguém.",
                Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        return
    }

    // Com um paciente só, não há o que escolher.
    if (vm.pacientes.size > 1) {
        Text("Paciente", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            vm.pacientes.forEach { p ->
                FilterChip(
                    selected = vm.pacienteDoBackend?.id == p.id,
                    onClick = { vm.selecionarPaciente(p.id) },
                    label = { Text(p.nome) },
                )
            }
        }
    }

    vm.pacienteDoBackend?.let { p ->
        Text(p.nome, style = MaterialTheme.typography.titleLarge)
    }

    OutlinedButton(onClick = vm::atualizarDoBackend, enabled = !vm.carregandoBackend) {
        Text("Atualizar")
    }

    vm.ultimoRepasse?.let {
        Text(
            "Repasse ao servidor: $it",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.outline,
        )
    }

    HorizontalDivider()

    Text("Alertas registrados", style = MaterialTheme.typography.titleLarge)
    if (vm.alertasDoBackend.isEmpty()) {
        Text("Nenhum alerta registrado para este paciente.", style = MaterialTheme.typography.bodySmall)
    }
    vm.alertasDoBackend.forEach { a ->
        ListItem(
            headlineContent = { Text(tituloDoAlerta(a)) },
            supportingContent = {
                Column {
                    Text(hora(a.primeiroEmMs) + situacao(a))
                    a.detalhe?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                }
            },
            trailingContent = {
                // Reconhecer aqui registra QUEM atendeu. Não apaga a luz da
                // pulseira: isso é o ack do gateway, na aba Pulseira.
                if (!a.reconhecido) {
                    TextButton(onClick = { vm.reconhecerNoBackend(a.id) }) { Text("Atendi") }
                }
            },
        )
    }

    HorizontalDivider()

    Text("Histórico", style = MaterialTheme.typography.titleLarge)
    Text(
        "O que foi feito com este paciente: quem foi vinculado, quando a pulseira foi colocada " +
            "e retirada, quem reconheceu cada alerta. Fica no servidor e não se perde ao fechar o app.",
        style = MaterialTheme.typography.bodySmall,
    )
    if (vm.historicoDoBackend.isEmpty()) {
        Text("Sem eventos registrados.", style = MaterialTheme.typography.bodySmall)
    }
    vm.historicoDoBackend.forEach { e ->
        ListItem(
            headlineContent = { Text(tituloDoEvento(e.tipo)) },
            supportingContent = {
                Text(hora(e.emMs) + " · " + e.detalhe + (e.por?.let { " · por $it" } ?: ""))
            },
        )
    }
}

private fun tituloDoAlerta(a: BackendClient.AlertaBackend) = when (a.chave) {
    "panic" -> "Pedido de ajuda (botão)"
    "fall" -> "Queda detectada"
    "tremor" -> "Tremor"
    "odd_motion" -> "Movimento atípico"
    else -> a.chave
}

private fun situacao(a: BackendClient.AlertaBackend) = when {
    a.reconhecido -> " · atendido"
    a.status == "normalized" -> " · normalizou"
    a.travado -> " · ativo, aguardando atendimento"
    else -> " · ativo"
}

/** Os mesmos tipos de evento que o backend produz em history.service.ts. */
private fun tituloDoEvento(tipo: String) = when (tipo) {
    "paciente_cadastrado" -> "Paciente cadastrado"
    "cuidador_vinculado" -> "Cuidador vinculado"
    "cuidador_revogado" -> "Cuidador removido"
    "pulseira_atribuida" -> "Pulseira colocada"
    "pulseira_liberada" -> "Pulseira retirada"
    "alerta_reconhecido" -> "Alerta atendido"
    else -> tipo
}

private val formato = SimpleDateFormat("dd/MM HH:mm", Locale.getDefault())

private fun hora(ms: Long) = if (ms <= 0) "—" else formato.format(Date(ms))
