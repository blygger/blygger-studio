/**
 * Build-time switch for maintainer-only Studio tooling. Production builds
 * replace this with `false`; set BLYG_COMPONENT_GALLERY=1 before `npm run dev`
 * when working on the component library locally.
 */
export const componentGalleryEnabled = process.env.BLYG_COMPONENT_GALLERY === '1';
