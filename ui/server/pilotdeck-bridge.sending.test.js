import { afterAll, expect, it, vi } from 'vitest';
const mock = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const previousHome = process.env.PILOT_HOME;
    const home = mkdtempSync(join(tmpdir(), 'pilotdeck-sending-'));
    process.env.PILOT_HOME = home;
    return { gateway: null, home, previousHome };
});
vi.mock('./services/gatewayConnectionCache.js', () => ({ createGatewayConnectionCache: () => ({ get: async () => mock.gateway, invalidate: () => {} }) }));
import { enqueueInputViaGateway, getInputQueueStateViaGateway, serializeQueuedInputForStorage, runChatViaGateway } from './pilotdeck-bridge.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createRequestContextMiddleware, withAuthenticatedRequest } from './middleware/requestContext.js';
import { anonymousRequestId, withRequestContext } from '../../src/network/requestContext.js';
import { requestLimiters } from './middleware/rateLimits.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const item = id => ({ id, runId: id, command: 'fixture', displayText: id, options: { projectPath: '/tmp/sending-project' } });

it('serializes authenticated HTTP attribution before crossing the gateway boundary', async () => {
    const calls = [];
    const gateway = {
        async *submitTurn(input) {
            // JSON serialization models the separate gateway process: only explicit
            // wire fields survive, regardless of the caller's AsyncLocalStorage.
            calls.push(JSON.parse(JSON.stringify(input)));
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
            yield { type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: 'completed', usage: {} };
        },
    };
    const app = express();
    app.use(requestLimiters.ingress);
    app.use(express.json());
    app.use(createRequestContextMiddleware());
    app.use((req, res, next) => {
        req.user = { id: req.headers['test-auth-user'] };
        return withAuthenticatedRequest(req, res, next);
    });
    app.post('/generate', async (req, res) => {
        await runChatViaGateway('Generate a commit message', { projectPath: '/tmp/http-project', runId: req.body.runId },
            { send() {} }, 'pilotdeck', { getGateway: async () => { await new Promise(r => setTimeout(r, 5)); return gateway; } });
        res.end();
    });
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    const requests = ['alice', 'bob'].map(user => ({ user, runId: randomUUID(), requestId: randomUUID(), deviceId: randomUUID() }));
    try {
        await Promise.all(requests.map(async request => {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/generate`, { method: 'POST', headers: {
                'content-type': 'application/json', 'test-auth-user': request.user,
                'x-pilotdeck-user-id': 'f'.repeat(32), 'x-pilotdeck-request-id': request.requestId,
                'x-pilotdeck-device-id': request.deviceId, 'x-pilotdeck-version': '2026.10.29',
            }, body: JSON.stringify({ runId: request.runId, requestContext: { userId: 'attacker' } }) });
            expect(response.status).toBe(200);
        }));
        for (const request of requests) expect(calls.find(call => call.runId === request.runId)?.requestContext).toEqual({
            userId: anonymousRequestId('user', request.user), deviceId: request.deviceId,
            clientVersion: '2026.10.29', parentRequestId: request.requestId,
        });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

it('preserves per-message attribution through delayed queue dispatch', async () => {
    const calls = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input.requestContext);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
            yield { type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: 'completed', usage: {} };
        },
    };
    const requestContext = { userId: 'a'.repeat(32), deviceId: 'device-a', parentRequestId: 'request-a' };
    const queued = item('context');
    queued.options.requestContext = requestContext;
    await withRequestContext({ userId: 'b'.repeat(32), parentRequestId: 'unrelated-request', clientVersion: 'unrelated-version' },
        () => enqueueInputViaGateway('web:context-queue', queued, { send() {} }));
    await vi.waitFor(() => expect(calls).toEqual([requestContext]));
});
afterAll(async () => {
    if (mock.previousHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = mock.previousHome;
    await rm(mock.home, { recursive: true, force: true });
});
it('shows idle input as sending, preserves concurrent input order, and removes each send only on acceptance', async () => {
    const acceptance = deferred(), completion = deferred(); const calls = [], frames = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input.runId);
            if (calls.length === 1) await acceptance.promise;
            yield { type: 'input_accepted', runId: input.runId };
            if (calls.length === 1) await completion.promise;
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
            yield { type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: 'completed', usage: {} };
        },
    };
    const sid = 'web:s_sending', writer = { send: frame => frames.push(structuredClone(frame)) };
    const first = await enqueueInputViaGateway(sid, item('first'), writer);
    expect(first.state.items[0].status).toBe('submitting');
    await vi.waitFor(() => expect(calls).toEqual(['first']));
    expect((await getInputQueueStateViaGateway(sid)).items[0].status).toBe('dispatching');
    const second = await enqueueInputViaGateway(sid, item('second'), writer);
    expect(second.state.items[1].status).toBe('queued');
    acceptance.resolve();
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items.map(x => x.id)).toEqual(['second']));
    expect(calls).toEqual(['first']);
    completion.resolve();
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items).toEqual([]));
    expect(calls).toEqual(['first', 'second']);
    expect(frames.filter(x => x.type === 'session-input-accepted').map(x => x.runId)).toEqual(['first', 'second']);
    expect(frames.filter(x => x.role === 'user').map(x => x.queueItemId)).toEqual(['first', 'second']);
});
it('converts a provisional send to a real queue item if the gateway discovers another active client', async () => {
    const snapshot = deferred();
    mock.gateway = { getActiveTurnSnapshot: () => snapshot.promise, submitTurn: vi.fn() };
    const sid = 'web:s_remote_busy';
    expect((await enqueueInputViaGateway(sid, item('remote'), { send() {} })).state.items[0].status).toBe('submitting');
    snapshot.resolve({ active: true, runId: 'other-client', events: [] });
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items[0].status).toBe('queued'));
    expect(mock.gateway.submitTurn).not.toHaveBeenCalled();
});
it('retains failed sends for recovery and treats only actually dispatched inputs as uncertain on restart', async () => {
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn() { yield { type: 'error', message: 'Rejected before acceptance' }; },
    };
    const sid = 'web:s_rejected';
    await enqueueInputViaGateway(sid, item('rejected'), { send() {} });
    await vi.waitFor(async () => expect(await getInputQueueStateViaGateway(sid)).toMatchObject({ paused: true, items: [{ id: 'rejected', status: 'failed' }] }));
    expect(serializeQueuedInputForStorage({ ...item('checking'), status: 'submitting' }).status).toBe('queued');
    expect(serializeQueuedInputForStorage({ ...item('sent'), status: 'dispatching' }).status).toBe('delivery_uncertain');
});

it.each([false, true])('acknowledges a retry after execution without dispatching again (restart=%s)', async restart => {
    const calls = [], frames = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input.runId);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
            yield { type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: 'completed', usage: {} };
        },
    };
    const sid = `web:s_retry_${restart}`, writer = {send: frame => frames.push(frame)};
    const first = item(`accepted-${restart}`);
    await enqueueInputViaGateway(sid, first, writer);
    await vi.waitFor(() => expect(frames.some(frame => frame.kind === 'complete')).toBe(true));
    let enqueue = enqueueInputViaGateway;
    if (restart) {
        vi.resetModules();
        enqueue = (await import('./pilotdeck-bridge.js')).enqueueInputViaGateway;
    }
    const retry = await enqueue(sid, first, writer);
    expect(retry).toMatchObject({ok: true, state: {items: []}});
    expect(calls).toEqual([first.id]);
    await enqueue(sid, {...first, id: first.id + '-new', runId: first.id + '-new'}, writer);
    await vi.waitFor(() => expect(calls).toEqual([first.id, first.id + '-new']));
});


it('assigns a real ID before startup failure without acknowledging the input', async () => {
    const frames = [];
    const result = await runChatViaGateway('fixture', { projectPath: '/tmp/sending-project', runId: 'failed-start' },
        { send: frame => frames.push(frame) }, 'pilotdeck', {
            getGateway: async () => { throw new Error('Gateway unavailable'); },
        });
    expect(frames.find(frame => frame.kind === 'session_created')?.newSessionId).toBe(result.sessionKey);
    expect(frames.some(frame => frame.kind === 'error' && frame.terminal === true && frame.sessionId === result.sessionKey)).toBe(true);
    expect(frames.some(frame => frame.type === 'session-input-accepted')).toBe(false);
});

it('ends a General send when workspace preflight fails before input acceptance', async () => {
    const previousRoot = process.env.WORKSPACES_ROOT;
    process.env.WORKSPACES_ROOT = mock.home;
    const frames = [];
    const gateway = { submitTurn: vi.fn() };
    try {
        const result = await runChatViaGateway('fixture', { projectPath: mock.home, runId: 'workspace-failed-start' },
            { send: frame => frames.push(frame) }, 'pilotdeck', { getGateway: async () => gateway });
        expect(frames.find(frame => frame.kind === 'session_created')?.newSessionId).toBe(result.sessionKey);
        expect(frames.find(frame => frame.kind === 'error')).toMatchObject({
            terminal: true, sessionId: result.sessionKey, runId: 'workspace-failed-start',
            content: 'General workspace must be separate from PILOT_HOME.',
        });
        expect(frames.some(frame => frame.type === 'session-input-accepted')).toBe(false);
        expect(gateway.submitTurn).not.toHaveBeenCalled();
    } finally {
        if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT;
        else process.env.WORKSPACES_ROOT = previousRoot;
    }
});

it.each(['general', 'PilotDeck'])('uses the new cwd for existing and new General conversations after migrating %s', async legacyName => {
    const previousRoot = process.env.WORKSPACES_ROOT;
    const root = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-general-turn-'));
    const legacy = path.join(root, legacyName);
    const current = path.join(root, 'PilotDeckGeneral');
    const sessionId = `web:general-migration-${randomUUID()}`;
    const reads = [], frames = [];
    await mkdir(legacy);
    if (legacyName === 'PilotDeck') await writeFile(path.join(legacy, '.pilotdeck-workspace'), JSON.stringify({ product: 'PilotDeck', version: 1, id: 'old-workspace' }));
    await writeFile(path.join(legacy, 'report.md'), 'report from an earlier conversation');
    process.env.WORKSPACES_ROOT = root;
    const gateway = {
        async *submitTurn(input) {
            reads.push({ cwd: input.workspaceCwd, report: await readFile(path.join(input.workspaceCwd, 'report.md'), 'utf8') });
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
            yield { type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: 'completed', usage: {} };
        },
    };
    try {
        const result = await runChatViaGateway('Read report.md', {
            projectPath: mock.home, sessionId, workspaceCwd: legacy,
        }, { send: frame => frames.push(frame) }, 'pilotdeck', { getGateway: async () => gateway });
        expect(result).toMatchObject({ sessionKey: sessionId, inputAccepted: true, sawTurnCompleted: true });
        expect(reads).toEqual([{ cwd: current, report: 'report from an earlier conversation' }]);
        const newConversation = await runChatViaGateway('Read report.md again', {
            projectPath: mock.home, workspaceCwd: legacy,
        }, { send: frame => frames.push(frame) }, 'pilotdeck', { getGateway: async () => gateway });
        expect(newConversation).toMatchObject({ inputAccepted: true, sawTurnCompleted: true });
        expect(reads).toHaveLength(2);
        expect(reads[1]).toEqual({ cwd: current, report: 'report from an earlier conversation' });
        expect(frames.some(frame => frame.kind === 'error')).toBe(false);
        expect(await readFile(path.join(legacy, 'report.md'), 'utf8')).toBe('report from an earlier conversation');
    } finally {
        if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT;
        else process.env.WORKSPACES_ROOT = previousRoot;
        expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
        await rm(root, { recursive: true, force: true });
    }
});

async function runResultScenario(buildEvents, streamError) {
    const frames = [];
    const sessionId = `web:s_task_result_${randomUUID()}`;
    const gateway = {
        async *submitTurn(input) {
            yield { type: 'input_accepted', runId: input.runId };
            for (const event of buildEvents(input)) yield event;
            if (streamError) throw streamError;
        },
    };
    const result = await runChatViaGateway('fixture', {
        projectPath: '/tmp/sending-project', sessionId, runId: 'result-run',
    }, { send: frame => frames.push(frame) }, 'pilotdeck', { getGateway: async () => gateway });
    return { frames, result };
}

it('does not treat turn_completed as success when task_result is missing', async () => {
    const { frames, result } = await runResultScenario(input => [
        { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} },
    ]);
    expect(result.sawTurnCompleted).toBe(true);
    expect(frames.filter(frame => frame.kind === 'complete')).toEqual([
        expect.objectContaining({ taskStatus: 'unknown', success: false, exitCode: 1, finishReason: 'task_result_unavailable' }),
    ]);
    expect(frames.find(frame => frame.kind === 'error')).toMatchObject({
        code: 'task_result_unavailable', terminal: true,
    });
});

it('rejects duplicate task_result events instead of accepting the first success', async () => {
    const { frames } = await runResultScenario(input => [
        { type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: 'completed', usage: {} },
        { type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: 'completed', usage: {} },
    ]);
    expect(frames.filter(frame => frame.kind === 'complete')).toEqual([
        expect.objectContaining({ taskStatus: 'unknown', success: false, exitCode: 1 }),
    ]);
    expect(frames.some(frame => frame.kind === 'complete' && frame.success === true)).toBe(false);
});

it('uses max_turns from task_result as a non-success outcome', async () => {
    const { frames } = await runResultScenario(input => [
        { type: 'turn_completed', runId: input.runId, finishReason: 'max_turns', usage: {} },
        { type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'max_turns', finishReason: 'max_turns', usage: {} },
    ]);
    expect(frames.filter(frame => frame.kind === 'complete')).toEqual([
        expect.objectContaining({ taskStatus: 'max_turns', success: false, exitCode: 1, finishReason: 'max_turns' }),
    ]);
});

it('preserves an authoritative result when transport fails afterwards', async () => {
    const { frames } = await runResultScenario(input => [
        { type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: 'completed', usage: {} },
    ], new Error('connection closed after result'));
    expect(frames.filter(frame => frame.kind === 'complete')).toEqual([
        expect.objectContaining({ taskStatus: 'success', success: true, exitCode: 0 }),
    ]);
    expect(frames.some(frame => frame.kind === 'error')).toBe(false);
});

it('reports unknown rather than failure when transport fails before task_result', async () => {
    const { frames } = await runResultScenario(() => [], new Error('connection closed before result'));
    expect(frames.filter(frame => frame.kind === 'complete')).toEqual([
        expect.objectContaining({ taskStatus: 'unknown', success: false, exitCode: 1 }),
    ]);
    expect(frames.find(frame => frame.kind === 'error')?.userHint).toContain('do not retry blindly');
});

it('accepts a valid task_result without requiring turn_completed', async () => {
    const { frames, result } = await runResultScenario(input => [
        { type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: 'completed', usage: {} },
    ]);
    expect(result.sawTurnCompleted).toBe(false);
    expect(frames.filter(frame => frame.kind === 'complete')).toEqual([
        expect.objectContaining({ taskStatus: 'success', success: true, exitCode: 0 }),
    ]);
});

it('rejects mismatched and malformed task_result events', async () => {
    const invalidResults = [
        input => ({ type: 'task_result', sessionKey: 'web:s_other', runId: input.runId, status: 'success', finishReason: 'completed', usage: {} }),
        input => ({ type: 'task_result', sessionKey: input.sessionKey, runId: 'other-run', status: 'success', finishReason: 'completed', usage: {} }),
        input => ({ type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'done', finishReason: 'completed', usage: {} }),
        input => ({ type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: '', usage: {} }),
        input => ({ type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: 'completed', usage: [] }),
    ];
    for (const invalidResult of invalidResults) {
        const { frames } = await runResultScenario(input => [invalidResult(input)]);
        expect(frames.filter(frame => frame.kind === 'complete')).toEqual([
            expect.objectContaining({ taskStatus: 'unknown', success: false, exitCode: 1 }),
        ]);
        expect(frames.some(frame => frame.kind === 'complete' && frame.success === true)).toBe(false);
    }
});

it('does not emit the final result twice when the writer fails after delivery', async () => {
    const frames = [];
    let writerFailed = false;
    const gateway = {
        async *submitTurn(input) {
            yield { type: 'task_result', sessionKey: input.sessionKey, runId: input.runId, status: 'success', finishReason: 'completed', usage: {} };
        },
    };
    await runChatViaGateway('fixture', {
        projectPath: '/tmp/sending-project', sessionId: `web:s_writer_${randomUUID()}`, runId: 'result-run',
    }, {
        send(frame) {
            frames.push(frame);
            if (frame.kind === 'complete' && !writerFailed) {
                writerFailed = true;
                throw new Error('writer closed after complete');
            }
        },
    }, 'pilotdeck', { getGateway: async () => gateway });
    expect(writerFailed).toBe(true);
    expect(frames.filter(frame => frame.kind === 'complete')).toHaveLength(1);
});
