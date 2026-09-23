import { z } from "zod";

export const availableSchema = z.object({
  id: z.string().min(1),
  owned_by: z.string().optional(),
});
export const availableListSchema = z.object({ data: z.array(availableSchema) });

export const aliasSchema = z.object({
  name: z.string().min(1),
  alias: z.string().min(1),
  "display-name": z.string().optional(),
});
export const aliasesSchema = z.object({
  "oauth-model-alias": z.record(z.string(), z.array(aliasSchema)).nullish(),
});

export const definitionSchema = z.object({
  id: z.string().min(1),
  owned_by: z.string().optional(),
  type: z.string().optional(),
  display_name: z.string().optional(),
  context_length: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  inputTokenLimit: z.number().optional(),
  outputTokenLimit: z.number().optional(),
  supportedInputModalities: z.array(z.string()).optional(),
  supportedOutputModalities: z.array(z.string()).optional(),
  thinking: z
    .object({
      levels: z.array(z.string()).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      dynamic_allowed: z.boolean().optional(),
    })
    .optional(),
});
export const definitionsSchema = z.object({ models: z.array(definitionSchema) });

export const compatibilityModelSchema = z.object({
  name: z.string().min(1),
  alias: z.string().min(1),
  "display-name": z.string().optional(),
  "max-context-length": z.number().optional(),
  image: z.boolean().optional(),
  "input-modalities": z.array(z.string()).optional(),
  "output-modalities": z.array(z.string()).optional(),
  thinking: definitionSchema.shape.thinking,
  "use-max-completion-tokens": z.boolean().optional(),
});
export const compatibilitySchema = z.object({
  "openai-compatibility": z
    .array(
      z.object({
        name: z.string().min(1),
        disabled: z.boolean().optional(),
        prefix: z.string().optional(),
        "base-url": z.url(),
        models: z.array(compatibilityModelSchema),
      }),
    )
    .nullish(),
});

export const clientAccessSchema = z.object({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
});
export const managementAccessSchema = z.object({
  managementUrl: z.url(),
  managementKey: z.string().min(1),
});

export type AvailableModel = z.infer<typeof availableSchema>;
export type Alias = z.infer<typeof aliasSchema>;
export type Definition = z.infer<typeof definitionSchema>;
export type Compatibility = NonNullable<
  z.infer<typeof compatibilitySchema>["openai-compatibility"]
>[number];
