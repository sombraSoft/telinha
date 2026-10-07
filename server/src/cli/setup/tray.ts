// The tray icon after the service, native Windows only. Not installing it
// (setup's question, or `--no-tray`) removes the icon (its file in bin\ is the
// "installed" state, so the opt-out survives updates; the file is kept
// uninstalled as telinha-tray.dist.exe), otherwise the file is put in bin\ and
// the icon started. autostart sets the sign-in Run value: on, off, or null to
// keep what it is (a plain re-run without --tray-autostart).
import { win32 } from 'node:path';
import { TRAY_EXE } from '../../release.ts';
import {
  defaultTrayLauncher,
  readTrayState,
  removeTray,
  setAutostart,
  stopTray,
  trayDistPath,
  trayEnv,
  trayExePath,
  trayRunning,
} from '../../service/tray.ts';
import { isSplitElevated } from '../../service/windows.ts';
import { defaultProcessInfo } from '../../supervisor.ts';
import { defineStrings } from '../strings.ts';
import type { Wizard } from './steps.ts';

const t = defineStrings(
  {
    started: 'Tray icon started (next to the clock).',
    running: 'Tray icon running.',
    optedOut: 'Tray icon not installed.',
    notFound:
      'telinha-tray.exe is neither in {bin} nor next to this telinha.exe; the tray is not installed. Run telinha.exe setup from the unpacked release zip to install it.',
    elevated: 'Running as administrator: the tray icon was not started; run telinha tray start from a normal terminal.',
    failed: 'Tray icon: {error}',
  },
  {
    started: 'Ícone na bandeja iniciado (ao lado do relógio).',
    running: 'Ícone na bandeja rodando.',
    optedOut: 'Ícone na bandeja não instalado.',
    notFound:
      'o telinha-tray.exe não está em {bin} nem ao lado deste telinha.exe; o ícone na bandeja não foi instalado. Rode telinha.exe setup da pasta do zip da versão descompactado para instalar.',
    elevated:
      'Rodando como administrador: o ícone na bandeja não foi iniciado; rode telinha tray start num terminal normal.',
    failed: 'Ícone na bandeja: {error}',
  },
);

export { t as trayStrings };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface TrayChoice {
  install: boolean;
  autostart: boolean | null;
}

export async function trayStep(w: Wizard, o: TrayChoice): Promise<void> {
  const { deps, out, locale } = w;
  if (deps.platform !== 'win32' || !w.ctx.compiled || w.docker) return;
  const { paths } = w.ctx;
  const exe = trayExePath(paths);
  const processInfo = deps.processInfo ?? defaultProcessInfo('win32');
  try {
    if (!o.install) {
      await setAutostart(deps.spawn, exe, false);
      await stopTray({ spawn: deps.spawn, fs: deps.fs, paths, processInfo, sleep: deps.sleep, now: deps.now });
      await removeTray({ fs: deps.fs, paths, log: () => {} });
      out.info(t(locale, 'optedOut'));
      return;
    }
    // An installed tray stays as it is (the updater keeps it in step with
    // bin\telinha.exe). Otherwise a downloaded one next to this exe is copied
    // in, else the copy that --no-tray or an update kept in bin\ is put back.
    if (!(await deps.fs.exists(exe))) {
      const beside = win32.join(win32.dirname(deps.execPath), TRAY_EXE);
      const dist = trayDistPath(paths);
      if (beside.toLowerCase() !== exe.toLowerCase() && (await deps.fs.exists(beside))) {
        await deps.fs.mkdir(paths.bin);
        await deps.fs.copyFile(beside, exe);
        // One tray file in bin\: a kept copy left next to it would go stale.
        if (await deps.fs.exists(dist)) await deps.fs.rm(dist);
      } else if (await deps.fs.exists(dist)) {
        await deps.fs.rename(dist, exe);
      } else {
        out.info(t(locale, 'notFound', { bin: paths.bin }));
        return;
      }
    }
    if (o.autostart !== null) await setAutostart(deps.spawn, exe, o.autostart);
    if (trayRunning(await readTrayState(deps.fs, paths), processInfo)) {
      out.ok(t(locale, 'running'));
      return;
    }
    // The file and the Run value are in place: the next sign-in or `telinha tray start` shows it.
    if (await isSplitElevated(deps.spawn)) {
      out.info(t(locale, 'elevated'));
      return;
    }
    (deps.tray ?? defaultTrayLauncher).launch(exe, trayEnv(w.ctx.env, paths));
    out.ok(t(locale, 'started'));
  } catch (e) {
    out.warn(t(locale, 'failed', { error: errMsg(e) }));
  }
}
