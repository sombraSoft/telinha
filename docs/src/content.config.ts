import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// No i18n collection: Starlight's built-in Portuguese UI strings cover pt-BR.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
