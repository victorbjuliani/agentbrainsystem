/**
 * Unified-diff helpers — PURE, dependency-free (issue #18).
 *
 * The optimize engine proposes *append-only* edits: it never rewrites existing
 * lines of a target file, it only adds a new block at the end (under a managed
 * section header). That keeps the diff trivially safe to read and review and the
 * apply trivially safe to perform — there is no risk of clobbering hand-written
 * content. So we only need to render a unified diff for an append, not a general
 * Myers diff (no `diff` dependency, keeping the module $0/offline like the rest).
 *
 * `renderAppendDiff` produces standard `--- / +++` unified-diff text with a single
 * hunk whose context is the current tail of the file and whose `+` lines are the
 * appended block. `splitLines` is the shared, newline-normalising splitter.
 */

/** Lines of context shown before an appended block in the rendered hunk. */
const CONTEXT_LINES = 3;

/**
 * Split text into lines WITHOUT trailing empties from a final newline. An empty
 * string yields `[]` (no lines), matching how a unified diff counts content.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalised = text.replace(/\r\n/g, '\n');
  const lines = normalised.split('\n');
  // A trailing newline produces a final '' element we don't count as a line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Render a unified diff for appending `appended` to the end of `original`.
 * `label` names the file on both sides (a/<label> … b/<label>). The hunk shows up
 * to `CONTEXT_LINES` trailing lines of the original as context, then the appended
 * lines as additions. A no-op append (empty `appended`) returns an empty string.
 */
export function renderAppendDiff(label: string, original: string, appended: string): string {
  const addedLines = splitLines(appended);
  if (addedLines.length === 0) return '';

  const origLines = splitLines(original);
  const contextStart = Math.max(0, origLines.length - CONTEXT_LINES);
  const context = origLines.slice(contextStart);

  // 1-based start lines for the @@ header. When the original is empty the old
  // side spans zero lines starting at 0 (the conventional empty-file form).
  const oldStart = origLines.length === 0 ? 0 : contextStart + 1;
  const oldCount = context.length;
  const newStart = oldStart;
  const newCount = context.length + addedLines.length;

  const out: string[] = [
    `--- a/${label}`,
    `+++ b/${label}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
  ];
  for (const line of context) out.push(` ${line}`);
  for (const line of addedLines) out.push(`+${line}`);
  return `${out.join('\n')}\n`;
}
