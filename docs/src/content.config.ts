import { defineCollection } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

// Starlight's built-in Portuguese UI strings cover pt-BR, so i18n/pt-BR.json
// overrides none of them. Starlight reads the collection on every build and
// warns when it is missing or empty.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
