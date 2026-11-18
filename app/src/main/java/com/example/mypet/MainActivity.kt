package com.example.mypet

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.mypet.data.GatewayClient
import com.example.mypet.ui.AlertsScreen
import com.example.mypet.ui.BackendScreen
import com.example.mypet.ui.PanelScreen
import com.example.mypet.ui.SettingsScreen
import com.example.mypet.ui.SimulatorScreen
import com.example.mypet.ui.StatusScreen
import com.example.mypet.ui.theme.MyPETTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Notifications.criarCanal(this)
        setContent {
            MyPETTheme {
                VitalWatchApp()
            }
        }
    }
}

private enum class Aba(val titulo: String, val icone: ImageVector) {
    PULSEIRA("Pulseira", Icons.Default.Favorite),
    ALERTAS("Alertas", Icons.Default.Notifications),
    // O que só existe com servidor: histórico que não se perde, paciente do
    // cadastro, e quem atendeu cada alerta. Tempo real continua em PULSEIRA.
    SERVIDOR("Servidor", Icons.AutoMirrored.Filled.List),
    PAINEL("Painel", Icons.Default.Home),
    SIMULADOR("Simulador", Icons.Default.Build),
    CONFIG("Config.", Icons.Default.Settings),
}

// Na versão simulada não existe painel web do gateway: no lugar dele fica o simulador
private val abas = Aba.entries.filter { it != if (BuildConfig.SIMULADO) Aba.PAINEL else Aba.SIMULADOR }

@Composable
fun VitalWatchApp(vm: VitalWatchViewModel = viewModel()) {
    PedirPermissaoNotificacao()
    var aba by rememberSaveable { mutableStateOf(Aba.PULSEIRA) }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        bottomBar = {
            NavigationBar {
                abas.forEach { a ->
                    NavigationBarItem(
                        selected = aba == a,
                        onClick = { aba = a },
                        icon = {
                            val marca = when {
                                a == Aba.ALERTAS && vm.naoLidos > 0 -> "${vm.naoLidos}"
                                a == Aba.PULSEIRA && vm.telemetria?.alertas?.any { it.ativo && it.critico } == true -> "!"
                                else -> null
                            }
                            if (marca != null) {
                                BadgedBox(badge = { Badge { Text(marca) } }) {
                                    Icon(a.icone, contentDescription = a.titulo)
                                }
                            } else {
                                Icon(a.icone, contentDescription = a.titulo)
                            }
                        },
                        label = { Text(a.titulo) },
                    )
                }
            }
        },
    ) { innerPadding ->
        Box(
            Modifier
                .padding(innerPadding)
                .fillMaxSize()
        ) {
            when (aba) {
                Aba.PULSEIRA -> StatusScreen(
                    vm,
                    abrirPainel = { aba = if (BuildConfig.SIMULADO) Aba.SIMULADOR else Aba.PAINEL },
                    abrirConfig = { aba = Aba.CONFIG },
                )
                Aba.ALERTAS -> AlertsScreen(vm)
                Aba.SERVIDOR -> BackendScreen(vm, abrirConfig = { aba = Aba.CONFIG })
                Aba.PAINEL -> PanelScreen(GatewayClient.normalizar(vm.settings.gatewayUrl) + "/painel")
                Aba.SIMULADOR -> SimulatorScreen()
                Aba.CONFIG -> SettingsScreen(vm)
            }
        }
    }
}

@Composable
private fun PedirPermissaoNotificacao() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) { launcher.launch(Manifest.permission.POST_NOTIFICATIONS) }
}
