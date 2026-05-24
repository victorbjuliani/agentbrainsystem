/**
 * One-file tree-sitter parsing → symbol definitions. WASM (web-tree-sitter, PINNED 0.22.6):
 * offline, cross-OS, no native build. Grammars load on demand. Never throws: an unsupported
 * extension → null; a parse/grammar failure → null/[] (caller degrades conservatively).
 */
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'web-tree-sitter'; // 0.22.6: default export; Parser.Language/Parser.Query namespaced

export interface Definition {
  name: string;
  kind: string;
  /** 1-based line of the definition's name. */
  line: number;
}

/**
 * Dir holding the bundled core + grammar wasm. In PRODUCTION the compiled parser is
 * dist/index/parser.js so `import.meta.url` → dist/index/wasm (correct, no env needed).
 * Under vitest the tests run from src/, so they set ABS_WASM_DIR=<repo>/dist/index/wasm —
 * mirrors the UI server's STATIC_DIR override for the identical src-vs-dist asset problem
 * (src/ui/server.ts). Lazy (a function) so a test can set the env in beforeAll after import.
 */
function wasmDir(): string {
  return process.env.ABS_WASM_DIR
    ? resolve(process.env.ABS_WASM_DIR)
    : join(dirname(fileURLToPath(import.meta.url)), 'wasm');
}

type Lang = 'typescript' | 'tsx' | 'javascript' | 'python';
function langForExt(ext: string): Lang | undefined {
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.jsx':
      return 'javascript';
    case '.py':
      return 'python';
    default:
      return undefined;
  }
}

const TS_QUERY = `
  (function_declaration name: (identifier) @name)
  (class_declaration name: (type_identifier) @name)
  (method_definition name: (property_identifier) @name)
  (interface_declaration name: (type_identifier) @name)
  (type_alias_declaration name: (type_identifier) @name)
  (enum_declaration name: (identifier) @name)
  (variable_declarator name: (identifier) @name value: (arrow_function))
  (variable_declarator name: (identifier) @name value: (function_expression))
`;
const JS_QUERY = `
  (function_declaration name: (identifier) @name)
  (class_declaration name: (identifier) @name)
  (method_definition name: (property_identifier) @name)
  (variable_declarator name: (identifier) @name value: (arrow_function))
  (variable_declarator name: (identifier) @name value: (function_expression))
`;
const PY_QUERY = `
  (function_definition name: (identifier) @name)
  (class_definition name: (identifier) @name)
`;
const QUERIES: Record<Lang, string> = {
  typescript: TS_QUERY,
  tsx: TS_QUERY,
  javascript: JS_QUERY,
  python: PY_QUERY,
};

let ready = false;
let parser: Parser | null = null;
const langs = new Map<Lang, Parser.Language>();
const queries = new Map<Lang, Parser.Query>();

/** Initialize the wasm runtime once. Idempotent. Safe to call before every parse. */
export async function initParser(): Promise<void> {
  if (ready) return;
  // 0.22.6: Emscripten loads the core via locateFile; basename is `tree-sitter.wasm`.
  await Parser.init({ locateFile: () => join(wasmDir(), 'tree-sitter.wasm') });
  parser = new Parser();
  ready = true;
}

async function loadLang(
  lang: Lang,
): Promise<{ language: Parser.Language; query: Parser.Query } | null> {
  try {
    let language = langs.get(lang);
    if (!language) {
      language = await Parser.Language.load(join(wasmDir(), `tree-sitter-${lang}.wasm`));
      langs.set(lang, language);
    }
    let query = queries.get(lang);
    if (!query) {
      query = language.query(QUERIES[lang]); // 0.22 API: Language.query(src), not `new Query`
      queries.set(lang, query);
    }
    return { language, query };
  } catch {
    return null; // missing/incompatible grammar → unsupported (degrade)
  }
}

/**
 * Parse `src` (the contents of `filePath`) and return its definitions, or null when the
 * extension is unsupported (so the caller can keep an anchor `verified` conservatively).
 */
export async function parseDefinitions(
  filePath: string,
  src: string,
): Promise<Definition[] | null> {
  const lang = langForExt(extname(filePath));
  if (!lang) return null;
  await initParser();
  const loaded = await loadLang(lang);
  if (!loaded || !parser) return null;
  try {
    parser.setLanguage(loaded.language);
    const tree = parser.parse(src);
    if (!tree) return [];
    const defs: Definition[] = [];
    for (const m of loaded.query.matches(tree.rootNode)) {
      for (const c of m.captures) {
        if (c.name === 'name') {
          defs.push({
            name: c.node.text,
            kind: c.node.parent?.type ?? 'symbol',
            line: c.node.startPosition.row + 1,
          });
        }
      }
    }
    tree.delete();
    return defs;
  } catch {
    return []; // tolerant: a parse hiccup is "no defs found", never a throw
  }
}
