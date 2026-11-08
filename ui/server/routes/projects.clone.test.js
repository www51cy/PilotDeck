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

  it('does not spawn Git when the caller is already aborted', async () => {
    const child = createChildProcess();
    const { cloneGitHubRepository, spawn } = await loadCloneHelper(child);
    const controller = new AbortController();
    controller.abort();

    await expect(cloneGitHubRepository(
      'https://github.com/openbmb/PilotDeck.git',
      '/tmp/PilotDeck',
      null,
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(spawn).not.toHaveBeenCalled();
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

  it('escalates to SIGKILL and settles when SIGTERM is ignored', async () => {
    vi.useFakeTimers();
    const child = createChildProcess(false);
    const { cloneGitHubRepository } = await loadCloneHelper(child);
    const pending = cloneGitHubRepository('https://github.com/openbmb/PilotDeck.git', '/tmp/PilotDeck', null, { timeoutMs: 100 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'GIT_CLONE_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);

    await rejected;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('keeps the token out of the clone URL and sanitizes streamed output', async () => {
    const child = createChildProcess();
    const { cloneGitHubRepository } = await loadCloneHelper(child);
    const pending = cloneGitHubRepository('https://github.com/openbmb/PilotDeck.git', '/tmp/PilotDeck', 'secret-token');
    const [, args, options] = child.spawn.mock.calls[0];
    const messages = [];

    child.stderr.emit('data', 'remote: secret-token should not leak');
    child.stderr.emit('data', `remote: ${Buffer.from('secret-token:').toString('base64')} should not leak`);
    child.emit('close', 0);

    await expect(pending).resolves.toEqual({ stdout: '', stderr: expect.any(String) });
    expect(args.join(' ')).not.toContain('secret-token');
    const configCount = Number(options.env.GIT_CONFIG_COUNT);
    const authorizationIndex = configCount - 2;
    const redirectIndex = configCount - 1;
    expect(options.env[`GIT_CONFIG_KEY_${authorizationIndex}`]).toBe('http.https://github.com/.extraHeader');
    expect(options.env[`GIT_CONFIG_VALUE_${authorizationIndex}`]).toBe(
      `Authorization: Basic ${Buffer.from('secret-token:').toString('base64')}`,
    );
    expect(options.env[`GIT_CONFIG_KEY_${redirectIndex}`]).toBe('http.followRedirects');
    expect(options.env[`GIT_CONFIG_VALUE_${redirectIndex}`]).toBe('false');
    messages.push(...child.progress.mock.calls.map((call) => call[0]));
    expect(messages.join('\n')).not.toContain('secret-token');
    expect(messages.join('\n')).not.toContain(Buffer.from('secret-token:').toString('base64'));
  });

  it('rejects non-GitHub hosts before spawning or attaching credentials', async () => {
    const child = createChildProcess();
    const { cloneGitHubRepository, spawn } = await loadCloneHelper(child);

    await expect(cloneGitHubRepository(
      'https://evil.example/openbmb/PilotDeck.git',
      '/tmp/PilotDeck',
      'secret-token',
    )).rejects.toMatchObject({ code: 'INVALID_REPOSITORY_URL' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a terminal error when Git cannot be started', async () => {
    const child = createChildProcess();
    const { cloneGitHubRepository } = await loadCloneHelper(child);
    const pending = cloneGitHubRepository('https://github.com/openbmb/PilotDeck.git', '/tmp/PilotDeck');
    const error = new Error('spawn git ENOENT');
    error.code = 'ENOENT';
    queueMicrotask(() => child.emit('error', error));

    await expect(pending).rejects.toThrow('Git is not installed or not in PATH');
  });
  it('clears the timeout when a fast close wins and settles only once', async () => {
    vi.useFakeTimers();
    const child = createChildProcess();
    const { cloneGitHubRepository } = await loadCloneHelper(child);
    const pending = cloneGitHubRepository('https://github.com/openbmb/PilotDeck.git', '/tmp/PilotDeck', null, { timeoutMs: 100 });
    let settlements = 0;
    pending.then(() => { settlements += 1; }, () => { settlements += 1; });

    expect(vi.getTimerCount()).toBe(1);
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ stdout: '', stderr: '' });
    await vi.advanceTimersByTimeAsync(5_100);

    expect(settlements).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('does not leave a force-kill timer when close is synchronous with SIGTERM', async () => {
    vi.useFakeTimers();
    const child = createChildProcess();
    child.kill = vi.fn(() => {
      child.emit('close', null);
      return true;
    });
    const { cloneGitHubRepository } = await loadCloneHelper(child);
    const controller = new AbortController();
    const pending = cloneGitHubRepository('https://github.com/openbmb/PilotDeck.git', '/tmp/PilotDeck', null, {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });

    controller.abort();
    await rejected;

    expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('settles once and clears timers when close races an active timeout', async () => {
    vi.useFakeTimers();
    const child = createChildProcess(false);
    const { cloneGitHubRepository } = await loadCloneHelper(child);
    const pending = cloneGitHubRepository('https://github.com/openbmb/PilotDeck.git', '/tmp/PilotDeck', null, { timeoutMs: 100 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'GIT_CLONE_TIMEOUT' });
    let settlements = 0;
    pending.then(() => { settlements += 1; }, () => { settlements += 1; });

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 0);
    await rejected;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(settlements).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
  });
});

function createChildProcess(closeOnKill = true) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.progress = vi.fn();
  child.kill = vi.fn(() => {
    if (closeOnKill) queueMicrotask(() => child.emit('close', null));
    return true;
  });
  child.spawn = vi.fn(() => child);
  return child;
}

async function loadCloneHelper(child) {
  const spawn = vi.fn((...args) => {
    child.spawn(...args);
    args[2].onProgress = child.progress;
    return child;
  });
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
