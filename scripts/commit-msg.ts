// lefthook's commit-msg hook: rejects a commit whose subject is not a
// Conventional Commit, with the types the pr-title check accepts (read from
// .github/workflows/pr-title.yml, so the list lives in one place). The PR title
// is what lands on main; this catches a bad subject before it is pushed.
//
//   bun scripts/commit-msg.ts <message file>
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

/** The `types` input of the pr-title workflow's semantic-pull-request step. */
export function prTitleTypes(workflow: string): string[] {
  const doc = Bun.YAML.parse(workflow) as {
    jobs: Record<string, { steps: { with?: { types?: string } }[] }>;
  };
  const types = Object.values(doc.jobs)
    .flatMap((job) => job.steps)
    .find((step) => step.with?.types)?.with?.types;
  if (!types) throw new Error('pr-title.yml has no step with a types input');
  return types.split('\n').filter(Boolean);
}

/** null when the message is fine, else why it is not. */
export function checkMessage(message: string, types: string[]): string | null {
  // Git strips the # lines after the hook runs, and with `commit -v` everything
  // below the scissors line, so skip them here too.
  const lines = message.split(/\r?\n/);
  const scissors = lines.findIndex((line) => /^# -+ >8 -+$/.test(line));
  const subject = lines
    .slice(0, scissors < 0 ? undefined : scissors)
    .find((line) => line.trim() && !line.startsWith('#'));
  if (!subject) return null; // git aborts an empty message itself
  // Messages git writes: merges, reverts and the fixup!/squash!/amend! commits
  // that `rebase --autosquash` folds away.
  if (/^(Merge |Revert "|(fixup|squash|amend)! )/.test(subject)) return null;
  const re = new RegExp(`^(${types.join('|')})(\\([^()]+\\))?!?: \\S`);
  if (re.test(subject)) return null;
  return `"${subject}" is not a Conventional Commit: <type>[(scope)][!]: <subject>, type one of ${types.join(', ')}`;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) throw new Error('usage: bun scripts/commit-msg.ts <message file>');
  const types = prTitleTypes(readFileSync(join(ROOT, '.github/workflows/pr-title.yml'), 'utf8'));
  const problem = checkMessage(readFileSync(file, 'utf8'), types);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
