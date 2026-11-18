import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

/**
 * Ponto unico de entrada do Zod no projeto. Todo *.schemas.ts importa z DAQUI,
 * nao de 'zod' direto.
 *
 * Motivo: o Zod 4 copia os metodos para a instancia no momento em que o schema
 * e construido, em vez de resolve-los pela cadeia de prototipos. Logo o
 * .openapi() que o extendZodWithOpenApi acrescenta so existe nos schemas
 * criados DEPOIS da chamada. Importando z deste modulo, a ordem fica garantida
 * pela propria resolucao de modulos, e nao pela ordem em que alguem escreveu
 * os imports.
 */
extendZodWithOpenApi(z);

export { z };
