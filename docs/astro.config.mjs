import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';

export default defineConfig({
  site: 'https://sombrasoft.github.io',
  base: '/telinha',
  // No astro:assets images, so sharp is never needed (it is the shakiest part under Bun).
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'Telinha',
      description: 'Self-hosted screen share for a Discord group.',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        'pt-br': { label: 'Português (Brasil)', lang: 'pt-BR' },
        // A new language: add its folder under src/content/docs/ and one line here.
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/sombraSoft/telinha' }],
      editLink: { baseUrl: 'https://github.com/sombraSoft/telinha/edit/main/docs/' },
      customCss: ['./src/styles/custom.css'],
      // Each group lists its own locale's folder; page order comes from `sidebar.order`.
      sidebar: [
        {
          label: 'Start here',
          translations: { 'pt-BR': 'Comece aqui' },
          items: [{ autogenerate: { directory: 'start' } }],
        },
        { label: 'Guides', translations: { 'pt-BR': 'Guias' }, items: [{ autogenerate: { directory: 'guides' } }] },
        {
          label: 'Routers',
          translations: { 'pt-BR': 'Roteadores' },
          items: [{ autogenerate: { directory: 'routers' } }],
        },
        {
          label: 'Reference',
          translations: { 'pt-BR': 'Referência' },
          items: [{ autogenerate: { directory: 'reference' } }],
        },
        { label: 'FAQ', translations: { 'pt-BR': 'Perguntas frequentes' }, slug: 'faq' },
        { label: 'Development', translations: { 'pt-BR': 'Desenvolvimento' }, slug: 'development' },
      ],
      // A pt-BR page linking to an EN page (or the reverse) fails the build.
      plugins: [starlightLinksValidator({ errorOnInconsistentLocale: true })],
    }),
  ],
});
