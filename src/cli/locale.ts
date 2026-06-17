/**
 * Tiny PT/EN locale layer for the `abs setup` LLM step (no full i18n).
 *
 * `detectLocale` reads the POSIX locale env (`LC_ALL` > `LC_MESSAGES` > `LANG`, the
 * gettext precedence) and resolves a Portuguese locale (`pt`, `pt_BR`, `pt_PT`, …) to
 * `'pt'`, everything else to `'en'`. A small typed string table backs the guided
 * setup copy. The env is injectable so tests never depend on the host locale.
 *
 * Deliberately small: a 2-language table, not an i18n framework (ADR-0018). The
 * SessionStart in-session nudge is agent-localized and needs no table here.
 */

export type Locale = 'pt' | 'en';

/** `getEnv`-shaped reader (matches the `SetupIo.getEnv` seam). */
export type EnvReader = (key: string) => string | undefined;

/**
 * Resolve the effective UI locale from the POSIX locale env. Precedence follows
 * gettext: `LC_ALL` overrides everything, then `LC_MESSAGES`, then `LANG`. A value
 * whose language prefix is `pt` (case-insensitive) → `'pt'`; anything else, including
 * unset/empty/`C`/`POSIX`/`fr_FR`, falls back to `'en'`.
 */
export function detectLocale(getEnv: EnvReader = (k) => process.env[k]): Locale {
  const raw = getEnv('LC_ALL') || getEnv('LC_MESSAGES') || getEnv('LANG') || '';
  // The language is the segment before any `_`/`.`/`@` modifier: `pt_BR.UTF-8` → `pt`.
  const lang = raw.toLowerCase().split(/[_.@]/, 1)[0] ?? '';
  return lang === 'pt' ? 'pt' : 'en';
}

/** Message ids the setup step renders — kept exhaustive so the table can be guarded. */
export const LOCALE_MESSAGE_IDS = [
  'explainTitle',
  'explainBody',
  'optOutCost',
  'choicePrompt',
  'askBaseUrl',
  'askModel',
  'askApiKey',
  'probeOk',
  'probeFail',
  'snippetHeader',
  'snippetKeyReminder',
  'declined',
  'alreadyConfigured',
] as const;

export type LocaleMessageId = (typeof LOCALE_MESSAGE_IDS)[number];

type MessageTable = Record<LocaleMessageId, string>;

/**
 * The PT/EN copy. Both maps MUST carry every {@link LOCALE_MESSAGE_IDS} key — the
 * `Record<LocaleMessageId, string>` type plus the completeness test enforce it, so a
 * forgotten translation fails the build / the test, never ships a blank line.
 *
 * `optOutCost` quotes abs's own measured numbers (ADR-0017: ~98% of the store stays raw,
 * ~0.5% durable) so the warned opt-out is grounded, not hand-wavy.
 */
const TABLE: Record<Locale, MessageTable> = {
  en: {
    explainTitle: 'Optional: connect an LLM so abs distils your sessions (recommended).',
    explainBody:
      'abs captures every session, but an LLM is what turns raw turns into durable, ' +
      'high-signal lessons — so recall returns the point, not the noise. Local Ollama is ' +
      '$0 and offline; a hosted OpenAI-compatible endpoint also works. This is optional and ' +
      'skippable — your API key is NEVER stored (abs only prints the export lines for you).',
    optOutCost:
      'If you skip: recall keeps working but stays raw. On a real install ~98% of the ' +
      'store never gets distilled and only ~0.5% becomes durable lessons (ADR-0017), so ' +
      'recall is noisier. You can run this step again anytime with `abs setup`.',
    choicePrompt:
      'Connect an LLM?  [1] local / Ollama ($0, offline, no key)  [2] hosted ' +
      '(OpenAI-compatible, needs a key)  [3] skip  > ',
    askBaseUrl: 'Base URL (with the /v1 suffix) > ',
    askModel: 'Model name > ',
    askApiKey: 'API key (printed back to you, NEVER stored) > ',
    probeOk: '✓ Reachable — the LLM answered the test call.',
    probeFail:
      '! Could not reach the LLM (advisory only — setup continues). Double-check the ' +
      'base URL / model / key, or configure it later. This never blocks setup.',
    snippetHeader:
      'Add these to your shell profile (e.g. ~/.zshrc) — the API key is yours and is ' +
      'never written by abs:',
    snippetKeyReminder:
      '# Keep ABS_LLM_API_KEY secret — it lives only in your shell, never in the abs store.',
    declined:
      'Skipped the LLM step — recall runs on raw turns. Re-run `abs setup` anytime to enable it.',
    alreadyConfigured:
      '✓ LLM step already done — reconfigure anytime by re-running `abs setup` after editing ' +
      'your ABS_LLM_* env vars.',
  },
  pt: {
    explainTitle: 'Opcional: conecte um LLM para o abs destilar suas sessões (recomendado).',
    explainBody:
      'O abs captura toda sessão, mas é o LLM que transforma os turnos brutos em lições ' +
      'duráveis e de alto sinal — assim a recall traz o que importa, não o ruído. O Ollama ' +
      'local é $0 e offline; um endpoint hospedado compatível com OpenAI também funciona. ' +
      'É opcional e pode ser pulado — sua chave de API NUNCA é armazenada (o abs só imprime ' +
      'as linhas de export para você).',
    optOutCost:
      'Se você pular: a recall continua funcionando, mas fica crua. Numa instalação real, ' +
      '~98% do acervo nunca é destilado e só ~0,5% vira lição durável (ADR-0017), então a ' +
      'recall fica mais ruidosa. Você pode rodar esta etapa de novo quando quiser com `abs setup`.',
    choicePrompt:
      'Conectar um LLM?  [1] local / Ollama ($0, offline, sem chave)  [2] hospedado ' +
      '(compatível com OpenAI, exige chave)  [3] pular  > ',
    askBaseUrl: 'Base URL (com o sufixo /v1) > ',
    askModel: 'Nome do modelo > ',
    askApiKey: 'Chave de API (mostrada de volta para você, NUNCA armazenada) > ',
    probeOk: '✓ Acessível — o LLM respondeu à chamada de teste.',
    probeFail:
      '! Não foi possível alcançar o LLM (apenas aviso — o setup continua). Confira a base ' +
      'URL / modelo / chave, ou configure depois. Isto nunca bloqueia o setup.',
    snippetHeader:
      'Adicione isto ao seu perfil de shell (ex. ~/.zshrc) — a chave de API é sua e nunca ' +
      'é escrita pelo abs:',
    snippetKeyReminder:
      '# Mantenha ABS_LLM_API_KEY em segredo — ela vive só no seu shell, nunca no acervo do abs.',
    declined:
      'Etapa do LLM pulada — a recall roda sobre turnos brutos. Rode `abs setup` de novo ' +
      'quando quiser para habilitar.',
    alreadyConfigured:
      '✓ Etapa do LLM já concluída — reconfigure quando quiser rodando `abs setup` de novo ' +
      'após editar suas variáveis de ambiente ABS_LLM_*.',
  },
};

/** Resolve a single message id for a locale. */
export function t(locale: Locale, id: LocaleMessageId): string {
  return TABLE[locale][id];
}
