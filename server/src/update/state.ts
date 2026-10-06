// data/run/update.json: what is staged, failed, pending or deferred. Written
// whole, atomically (tmp + rename), by the updater inside `run` and by the
// `service run` loop that counts failed starts; read by both and by doctor.
import { dirname, join } from 'node:path';
import type { Paths } from '../paths.ts';
import type { UpdateFs, UpdateState } from './types.ts';

export const statePath = (paths: Pick<Paths, 'run'>): string => join(paths.run, 'update.json');

/** {} when the file is missing or unreadable: a corrupt state file must never stop the service. */
export async function readState(fs: UpdateFs, path: string): Promise<UpdateState> {
  let text: string | null;
  try {
    text = await fs.readText(path);
  } catch {
    return {};
  }
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as UpdateState) : {};
  } catch {
    return {};
  }
}

export async function writeState(fs: UpdateFs, path: string, state: UpdateState): Promise<void> {
  // Drop undefined keys so a cleared field disappears instead of lingering as null.
  const clean = Object.fromEntries(Object.entries(state).filter(([, v]) => v !== undefined));
  await fs.mkdir(dirname(path));
  const tmp = `${path}.tmp`;
  await fs.writeText(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  await fs.rename(tmp, path);
}
