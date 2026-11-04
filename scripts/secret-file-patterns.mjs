// The one list of file-path patterns that could hold key material (T-001, G0-12).
//
// It lived inside check-no-secret-files.mjs, which scans `git ls-files` against it
// at import time. PM-013 needs the same list to check the file list of every built
// container image, and importing a script that scans and may exit is not a thing a
// test can do, so the list moved here. check-no-secret-files.mjs imports it and
// behaves exactly as before.
//
// Anything added here tightens both checks at once: tracked files and image layers.
export const FORBIDDEN = [
  /\.key$/,
  /\.key\.json$/,
  /(^|\/)\.env(?!\.example$)/,
  /(^|\/)keystore\//,
  /\.pem$/,
  /\.p12$/,
];
