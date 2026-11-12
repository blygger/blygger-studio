import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const componentGallery = process.env.BLYG_COMPONENT_GALLERY === '1';
await build({
  entryPoints: ['src/ui/app.tsx'],
  outfile: 'build/studio-spa.js',
  bundle: true,
  jsx: 'automatic',
  tsconfig: 'tsconfig.ui.json',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.BLYG_COMPONENT_GALLERY': JSON.stringify(componentGallery ? '1' : ''),
  },
  // The gallery is a maintainer reference, never an operator-facing route.
  // Replace its module before bundling so neither its page nor its CSS can
  // enter an ordinary production build.
  plugins: componentGallery
    ? []
    : [{
        name: 'exclude-component-gallery',
        setup(build) {
          build.onResolve({ filter: /^\.\/component-library\.tsx$/ }, (args) => ({
            path: resolve(args.resolveDir, 'component-library.stub.tsx'),
          }));
        },
      }],
});
copyFileSync('build/studio-spa.js', 'build/studio-spa.txt');
copyFileSync('build/studio-spa.css', 'build/studio-spa-style.txt');
