/**
 * Lets TypeScript type-check `require('*.png')` image asset imports.
 * Metro (the RN/Expo bundler) already resolves these at build time — this
 * declaration only satisfies the compiler, which has no built-in knowledge
 * of image modules the way web bundlers' asset loaders do. Needed for the
 * role-icon PNGs in CricketPitch.tsx (app/assets/role-icons/*.png), ported
 * from web's embedded base64 role icons.
 */
declare module '*.png' {
  const value: number;
  export default value;
}
