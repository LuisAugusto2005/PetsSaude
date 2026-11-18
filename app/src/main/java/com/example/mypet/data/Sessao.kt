package com.example.mypet.data

import android.content.Context

/**
 * Estado da sessão no backend.
 *
 * `Desligada` não é erro: é o app funcionando como sempre funcionou, só com o
 * gateway na rede local. O backend é opcional de propósito — pôr login na
 * frente de tudo faria o app parar de funcionar dentro de casa sem internet,
 * que é justamente o cenário que ele já atende bem.
 */
sealed interface Sessao {
    /** Sem endereço de backend configurado. */
    data object Desligada : Sessao
    data object Deslogado : Sessao
    data object Entrando : Sessao
    data class Ativa(val email: String, val nome: String, val papeis: List<String>) : Sessao
    data class Erro(val mensagem: String) : Sessao
}

/**
 * Guarda os tokens.
 *
 * Em arquivo PRÓPRIO de SharedPreferences, separado das preferências do app,
 * por dois motivos: fica fora dos backups (ver res/xml/backup_rules.xml e
 * data_extraction_rules.xml, que excluem só este arquivo), e sair da sessão é
 * apagar um arquivo em vez de limpar chaves no meio da configuração.
 *
 * LIMITE CONHECIDO: não é criptografado. O armazenamento privado do app já é
 * isolado dos outros apps pelo Android, e em aparelho sem root isso basta; num
 * aparelho com root, não. Endurecer isso é `EncryptedSharedPreferences` (lib
 * androidx.security), que é uma dependência nova — fica como decisão para
 * quando o app sair de desenvolvimento.
 */
class SessaoStore(context: Context) {
    private val prefs = context.getSharedPreferences("vitalwatch-sessao", Context.MODE_PRIVATE)

    data class Guardado(
        val accessToken: String,
        val refreshToken: String,
        val email: String,
        val nome: String,
        val papeis: List<String>,
    )

    fun carregar(): Guardado? {
        val access = prefs.getString(KEY_ACCESS, null) ?: return null
        val refresh = prefs.getString(KEY_REFRESH, null) ?: return null
        return Guardado(
            accessToken = access,
            refreshToken = refresh,
            email = prefs.getString(KEY_EMAIL, null).orEmpty(),
            nome = prefs.getString(KEY_NOME, null).orEmpty(),
            papeis = prefs.getString(KEY_PAPEIS, null).orEmpty()
                .split(',').filter { it.isNotBlank() },
        )
    }

    fun salvar(g: Guardado) {
        prefs.edit()
            .putString(KEY_ACCESS, g.accessToken)
            .putString(KEY_REFRESH, g.refreshToken)
            .putString(KEY_EMAIL, g.email)
            .putString(KEY_NOME, g.nome)
            .putString(KEY_PAPEIS, g.papeis.joinToString(","))
            .apply()
    }

    /** Só os tokens mudam na rotação; quem é o usuário continua o mesmo. */
    fun atualizarTokens(access: String, refresh: String) {
        prefs.edit().putString(KEY_ACCESS, access).putString(KEY_REFRESH, refresh).apply()
    }

    fun limpar() = prefs.edit().clear().apply()

    private companion object {
        const val KEY_ACCESS = "access_token"
        const val KEY_REFRESH = "refresh_token"
        const val KEY_EMAIL = "email"
        const val KEY_NOME = "nome"
        const val KEY_PAPEIS = "papeis"
    }
}
