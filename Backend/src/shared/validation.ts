import { Types } from 'mongoose';
import { z } from './zod.js';

/** Valida um ObjectId na URL antes de chegar ao banco. */
export const objectIdSchema = z.string().refine((v) => Types.ObjectId.isValid(v), 'Id invalido');

export const idParamSchema = z.object({ id: objectIdSchema });

/** Paginacao padrao de todas as listagens. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Telefone brasileiro, normalizado para a forma E.164 `+5585999990001`.
 *
 * O campo e funcional, nao decorativo: e o numero que o app disca quando um
 * alerta dispara. Lixo gravado aqui quebra o `tel:` do app, e o mesmo numero
 * escrito de tres formas diferentes impede reconhecer que e a mesma pessoa.
 *
 * So atendemos o Brasil, entao o `+55` e assumido quando falta. Isso permite a
 * enfermagem digitar `85999990001` com pressa e ainda assim guardar um numero
 * discavel de qualquer lugar.
 *
 * Regra, sobre os digitos (parenteses, espacos, hifens e o zero de operadora
 * saem antes):
 *   10 ou 11 digitos  -> DDD + numero, prefixa +55   (8599999... -> +558599999...)
 *   12 ou 13 com '55' -> ja tem o pais, so prefixa + (5585999... -> +5585999...)
 *   qualquer outra coisa -> erro
 *
 * O teste de tamanho vem antes do de prefixo de proposito: `5533334444` tem 10
 * digitos e e um fixo do DDD 55 (Rio Grande do Sul), nao um numero com pais.
 */
const PAIS = '55';

export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, '').replace(/^0+/, ''))
  .transform((d) => {
    if (d.length === 10 || d.length === 11) return `+${PAIS}${d}`;
    if ((d.length === 12 || d.length === 13) && d.startsWith(PAIS)) return `+${d}`;
    return d;
  })
  .refine(
    (v) => v.startsWith('+'),
    'Telefone brasileiro invalido: use DDD + numero (85999990001) ou +55 na frente',
  );

export function paginated<T>(items: T[], total: number, { page, limit }: Pagination) {
  return {
    itens: items,
    paginacao: {
      pagina: page,
      porPagina: limit,
      total,
      totalPaginas: Math.max(1, Math.ceil(total / limit)),
    },
  };
}
