import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('cloneGitHubRepository', () => {
  it('terminates the Git process when its caller aborts', async () => {
    const child = createChildProcess();
    const { cloneGitHubRepository } = await loadCloneHelper(child);
    const controller = new AbortController();
    const pending = cloneGitHubRepository('https://github.com/openbmb/PilotDeck.git', '/tmp/PilotDeck', null, {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });

    controller.abort();

    await rejected;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('terminates the Git process after the clone timeout', async () => {
    vi.useFakeTimers();
    const child = createChildProcess();
    const { cloneGitHubRepository } = await loadCloneHelper(child);
    const pending = cloneGitHubRepository('https://github.com/openbmb/PilotDeck.git', '/tmp/PilotDeck', null, { timeoutMs: 100 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'GIT_CLONE_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects unsupported repository protocols before starting Git', async () => {
    const child = createChildProcess();
    const { cloneGitHubRepository, spawn } = await loadCloneHelper(child);

    await expect(cloneGitHubRepository('file:///tmp/repository', '/tmp/PilotDeck')).rejects.toThrow('HTTP(S) or SSH');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps the token out of the clone URL and sanitizes streamed output', async () => {
    const child = createChildProcess();
    const { cloneGitHubRepository, spawn } = await loadCloneHelper(child);
    const progress = [];
    const pending = cloneGitHubRepository(
      'https://github.com/openbmb/PilotDeck.git',
      '/tmp/PilotDeck',
      'secret-token',
      { onProgress: (message) => progress.push(message) },
    );

    const [, args, options] = spawn.mock.calls[0];
    expect(args).toEqual(['clone', '--progress', '--', 'https://github.com/openbmb/PilotDeck.git', '/tmp/PilotDeck']);
    expect(args.join(' ')).not.toContain('secret-token');
    const configIndex = Number(options.env.GIT_CONFIG_COUNT) - 1;
    expect(options.env[`GIT_CONFIG_VALUE_${configIndex}`]).toBe(
      `Authorization: Basic ${Buffer.from('secret-token:').toString('base64')}`,
    );

    child.stderr.emit('data', Buffer.from('fatal: https://secret-token@github.com/openbmb/PilotDeck.git'));
    expect(progress).toEqual(['fatal: https://***@github.com/openbmb/PilotDeck.git']);
    child.emit('close', 0);
    await pending;
  });
});

function createChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal) => {
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  });
  return child;
}

async function loadCloneHelper(child) {
  const spawn = vi.fn(() => child);
  vi.doMock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, spawn, default: { ...(actual.default || actual), spawn } };
  });
  vi.doMock('../projects.js', () => ({ addProjectManually: vi.fn(), extractProjectDirectory: vi.fn() }));
  vi.doMock('../discovery-plans.js', () => ({
    getProjectDiscoveryContext: vi.fn(),
    getProjectDiscoveryPlansOverview: vi.fn(),
    getProjectDiscoveryPlanReport: vi.fn(),
    rerunDiscoveryPlan: vi.fn(),
    getProjectWorkCycles: vi.fn(),
    applyWorkCycle: vi.fn(),
    archiveWorkCycle: vi.fn(),
  }));
  return { cloneGitHubRepository: (await import('./projects.js')).cloneGitHubRepository, spawn };
}
