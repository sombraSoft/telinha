// bun test preload: compiles *.svelte.ts modules (runes) the way the page
// build does, so tests run the real reactive code.
import { plugin } from 'bun';
import { compileModule } from 'svelte/compiler';

const ts = new Bun.Transpiler({ loader: 'ts' });

plugin({
  name: 'svelte-runes',
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const js = ts.transformSync(await Bun.file(path).text());
      return { contents: compileModule(js, { filename: path, generate: 'client' }).js.code, loader: 'js' };
    });
  },
});
