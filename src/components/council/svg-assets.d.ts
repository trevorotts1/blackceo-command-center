/**
 * svg-assets.d.ts (CWE-033, Skill 77)
 *
 * The Command Center codebase had no typed static-asset imports
 * before the council journey: this declaration covers the vendored
 * CWE-031 medallion SVGs under ./portraits, which Next serves as
 * static assets. An imported SVG resolves to a URL string or a
 * { src } object depending on the pipeline; medallions.ts normalizes
 * both shapes.
 */
declare module '*.svg' {
  const asset: string | { src: string };
  export default asset;
}
