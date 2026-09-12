import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { documentSchema, idSchema, rectSchema, candidateSchema, assetSchema } from './domain.js';

// Fastify uses draft-7. Removing the dialect marker prevents an AJV startup mismatch.
export const schema = (s: z.ZodType) => {
  const { $schema, ...result } = z.toJSONSchema(s, { unrepresentable: 'any', target: 'draft-7' });
  return result as any;
};

/** OpenAPI and response serialization share a whitelist; private secrets/receipts never leave it. */
export function registerResponseContracts(app: FastifyInstance) {
  const projectResponse = schema(
    z.object({
      ...documentSchema.shape,
      id: idSchema,
      revision: z.number().int(),
      updatedAt: z.string(),
    }),
  );
  const jobResponse = schema(
    z.object({
      id: idSchema,
      status: z.enum(['running', 'ready', 'failed', 'cancelled', 'applied']),
      message: z.string(),
      region: rectSchema,
      candidates: z.array(candidateSchema),
    }),
  );
  const publicModel = schema(
    z.object({
      config: z
        .object({
          baseUrl: z.string(),
          model: z.string(),
          timeoutSeconds: z.number(),
          hasApiKey: z.boolean(),
        })
        .nullable(),
    }),
  );
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/v1')) return;
    const method = String(route.method);
    let response: any;
    if (route.url === '/api/v1/projects' && method === 'GET')
      response = schema(
        z.object({
          projects: z.array(
            z.object({
              id: idSchema,
              name: z.string(),
              revision: z.number().int(),
              updatedAt: z.string(),
            }),
          ),
        }),
      );
    else if (route.url.startsWith('/api/v1/projects')) response = projectResponse;
    else if (route.url === '/api/v1/assets' || route.url === '/api/v1/assets/:id')
      response = schema(assetSchema);
    else if (route.url === '/api/v1/model-configs') response = publicModel;
    else if (route.url.endsWith('/models'))
      response = schema(z.object({ models: z.array(z.string()) }));
    else if (route.url.endsWith('/test') || method === 'DELETE')
      response = schema(z.object({ status: z.string() }));
    else if (route.url.endsWith('/apply')) response = projectResponse;
    else if (route.url === '/api/v1/split-jobs')
      response = schema(z.object({ id: idSchema, status: z.string() }));
    else if (route.url.startsWith('/api/v1/split-jobs')) response = jobResponse;
    if (response)
      route.schema = {
        ...route.schema,
        tags: [route.url.split('/')[3]],
        response: {
          [route.url === '/api/v1/split-jobs' ? 202 : 200]: response,
          400: { type: 'object', properties: { error: { type: 'string' } } },
          409: { type: 'object', properties: { error: { type: 'string' } } },
        },
      };
  });
}
