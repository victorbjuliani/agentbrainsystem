/**
 * Package version, surfaced by the CLI (`abs --version`) and MCP server info.
 *
 * Read from package.json at load so it can NEVER drift from the published version
 * (a hardcoded constant silently lagged behind `npm version` bumps). The path is
 * relative to the compiled module: `dist/version.js` → `../package.json`, which is
 * the package root both in the repo and in an installed package (where `files`
 * publishes `dist/` alongside `package.json`).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION: string = pkg.version;
