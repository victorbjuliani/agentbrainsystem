/**
 * Unified-diff helpers — PURE, dependency-free (issue #18).
 *
 * The optimize engine proposes mostly *append-only* edits: it adds a new block at the end
 * (under a managed section header), which keeps the diff trivially safe to read and the apply
 * safe to perform. `renderAppendDiff` covers that case with a single trailing hunk. The one
 * exception is an auto-memory entry that needs YAML frontmatter at the FRONT (#140) — a new
 * file or the heal of a legacy frontmatter-less dead-drop — which an append-only diff cannot
 * express; `renderFullDiff` renders that as a full-file `current → next` replace. Both are
 * dependency-free (no Myers diff), keeping the module $0/offline like the rest.
 *
 * `splitLines` is the shared, newline-normalising splitter.
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

/**
 * Render a full-file unified diff for `original → next` (#140). Unlike
 * `renderAppendDiff`, this expresses edits anywhere in the file — needed when optimize
 * PREPENDS YAML frontmatter to an auto-memory entry (a new file or the heal of a legacy
 * frontmatter-less dead-drop), which an append-only diff cannot show. A no-op (identical
 * content) returns ''. An empty original degrades to the append form (all additions).
 * It renders the whole old side as removals and the whole new side as additions — a
 * verbose-but-unambiguous full replace, kept dependency-free (no Myers diff); the files
 * involved are small consolidated-memory entries, so the noise is acceptable for review.
 */
export function renderFullDiff(label: string, original: string, next: string): string {
  if (original === next) return '';
  const oldLines = splitLines(original);
  if (oldLines.length === 0) return renderAppendDiff(label, '', next);
  const newLines = splitLines(next);
  const out: string[] = [
    `--- a/${label}`,
    `+++ b/${label}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  for (const line of oldLines) out.push(`-${line}`);
  for (const line of newLines) out.push(`+${line}`);
  return `${out.join('\n')}\n`;
}
