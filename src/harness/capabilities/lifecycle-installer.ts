// src/harness/capabilities/lifecycle-installer.ts
import { type InstallOptions, installHooks, uninstallHooks } from '../../hooks/installer.js';
import type { HookEvent } from '../../hooks/payload.js';
import type { InstallReport, LifecycleMoment, UninstallReport } from '../types.js';

/** Which canonical moment each Claude-style native event serves. */
export const CLAUDE_EVENT_MOMENT: Record<HookEvent, LifecycleMoment> = {
  SessionEnd: 'capture',
  SessionStart: 'recall',
  UserPromptSubmit: 'recall',
  PreToolUse: 'guard',
};

function momentsOf(events: readonly HookEvent[]): LifecycleMoment[] {
  return [...new Set(events.map((e) => CLAUDE_EVENT_MOMENT[e]))];
}

export interface SettingsInstallerOptions {
  events: readonly HookEvent[];
  settingsPath?: string;
  baseCommand?: string;
}

export interface LifecycleInstaller {
  install(): Promise<InstallReport>;
  uninstall(): Promise<UninstallReport>;
}

/**
 * Settings-file installer for Claude-style harnesses. Delegates to the existing,
 * battle-tested `installHooks`/`uninstallHooks` (idempotent, backup-first,
 * symlink-refusing). `install` reports the canonical moments wired (derived from
 * the requested events); `uninstall` reports the moments whose hook was removed.
 */
export function settingsFileInstaller(options: SettingsInstallerOptions): LifecycleInstaller {
  const buildOpts = (): InstallOptions => {
    const o: InstallOptions = { events: [...options.events] };
    if (options.settingsPath) o.settingsPath = options.settingsPath;
    if (options.baseCommand) o.baseCommand = options.baseCommand;
    return o;
  };
  return {
    install: async () => {
      installHooks(buildOpts());
      return { wired: momentsOf(options.events) };
    },
    uninstall: async () => {
      const result = uninstallHooks(buildOpts());
      return { removed: momentsOf(result.removed) };
    },
  };
}
