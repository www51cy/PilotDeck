import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogProvider } from "../../../../../shared/catalogProviders";
import ProviderCard from "./ProviderCard";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  fetchProviderModels: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../../../../utils/api", () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock("../../../../../shared/modelListApi", () => ({
  fetchProviderModels: mocks.fetchProviderModels,
}));

const catalogEntry: CatalogProvider = {
  id: "openrouter",
  displayName: "OpenRouter",
  protocol: "openai",
  defaultUrl: "https://openrouter.ai/api/v1",
  models: [],
};

describe("ProviderCard custom model add", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    mocks.fetchProviderModels.mockResolvedValue([
      { id: "anthropic/claude-fable", displayName: "Claude Fable" },
      { id: "google/gemini-flash", displayName: "Gemini Flash" },
    ]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each(['anthropic/claude-fable', 'fable-alias'])('preserves catalog token limits when enabling %s', async (modelId) => {
    mocks.fetchProviderModels.mockResolvedValue([{ id: modelId }]);
    const onSave = vi.fn(async () => ({ ok: true }));
    const catalog = { ...catalogEntry, models: [{ id: 'anthropic/claude-fable', displayName: 'Fable',
      aliases: ['fable-alias'], maxContextTokens: 65536, maxOutputTokens: 8192 }] };
    render(<ProviderCard providerId="openrouter" provider={{ protocol: 'openai', url: catalog.defaultUrl,
      apiKey: 'key', models: {} }} catalogEntry={catalog} onSave={onSave} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
    fireEvent.click(await screen.findByRole('button', { name: modelId }));
    fireEvent.click(screen.getByRole('button', { name: 'Fable' }));
    expect((screen.getByLabelText('pilotDeckConfig.panels.models.maxContextTokens') as HTMLInputElement).value).toBe('65536');
    expect((screen.getByLabelText('pilotDeckConfig.panels.models.maxOutputTokens') as HTMLInputElement).value).toBe('8192');
    fireEvent.click(screen.getByRole('button', { name: 'confirmDialog.cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('openrouter', expect.objectContaining({
      models: { [modelId]: { capabilities: { maxContextTokens: 65536, maxOutputTokens: 8192 } } },
    })));
  });

  it.each(['gpt-4.1', 'vendor/claude-sonnet-4.5'])('uses engine catalog limits for custom proxy model %s', async modelId => {
    const limits = modelId === 'gpt-4.1'
      ? { maxContextTokens: 1047576, maxOutputTokens: 32768 }
      : { maxContextTokens: 200000, maxOutputTokens: 8192 };
    mocks.fetchProviderModels.mockResolvedValue([{ id: modelId }]);
    const onSave = vi.fn(async () => ({ ok: true }));
    render(<ProviderCard providerId="private-proxy" provider={{ protocol: 'openai', url: 'https://proxy.test/v1',
      apiKey: 'key', models: {} }} onSave={onSave} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
    fireEvent.click(await screen.findByRole('button', { name: modelId }));
    fireEvent.click(screen.getByRole('button', { name: modelId }));
    expect((screen.getByLabelText('pilotDeckConfig.panels.models.maxContextTokens') as HTMLInputElement).value).toBe(String(limits.maxContextTokens));
    expect((screen.getByLabelText('pilotDeckConfig.panels.models.maxOutputTokens') as HTMLInputElement).value).toBe(String(limits.maxOutputTokens));
    expect((screen.getByRole('checkbox', { name: 'pilotDeckConfig.panels.models.modelSettings.imageInput' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'confirmDialog.cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('private-proxy', expect.objectContaining({
      models: { [modelId]: { capabilities: limits } },
    })));
  });

  it('shows inherited proxy limits without replacing explicit model settings or saving on open', () => {
    const onSave = vi.fn();
    render(<ProviderCard providerId="proxy" provider={{ protocol: 'openai', url: 'https://proxy.test/v1', apiKey: 'key',
      models: { 'gpt-4.1': {}, 'claude-sonnet-4-5-20250929': { capabilities: { maxContextTokens: 180000, maxOutputTokens: 4096 } } },
    }} onSave={onSave} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'gpt-4.1' }));
    expect((screen.getByLabelText('pilotDeckConfig.panels.models.maxContextTokens') as HTMLInputElement).value).toBe('1047576');
    fireEvent.click(screen.getByRole('button', { name: 'confirmDialog.cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'claude-sonnet-4-5-20250929' }));
    expect((screen.getByLabelText('pilotDeckConfig.panels.models.maxContextTokens') as HTMLInputElement).value).toBe('180000');
    expect((screen.getByLabelText('pilotDeckConfig.panels.models.maxOutputTokens') as HTMLInputElement).value).toBe('4096');
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each(['aaa', 'file:///tmp/model'])('rejects malformed or unsupported provider URL %s before saving', (url) => {
    const onSave = vi.fn();
    render(<ProviderCard providerId="test" initialEditing provider={{ protocol: 'openai', url, apiKey: 'key', models: { model: {} } }} onSave={onSave} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
    expect(screen.getByText('pilotDeckConfig.panels.models.providerUrlInvalid')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each(['HX API', 'my.provider', '自定义模型', `provider-${'a'.repeat(64)}`])('saves edits while retaining legacy provider ID %s', async (providerId) => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const provider = { protocol: 'openai' as const, url: 'https://example.test/v1', apiKey: '********', models: { model: {} } };
    render(<ProviderCard providerId={providerId} initialEditing provider={provider} onSave={onSave} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.models.apiKey'), { target: { value: 'replacement-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(providerId, { ...provider, apiKey: 'replacement-key' }));
    expect(screen.queryByText('pilotDeckConfig.panels.models.providerIdInvalid')).toBeNull();
  });

  it.each([true, false])('rejects an invalid provider name when creating or renaming (new=%s)', (isNew) => {
    const onSave = vi.fn(async () => ({ ok: true }));
    render(<ProviderCard providerId={isNew ? 'HX API' : 'old-provider'} isNew={isNew} initialEditing
      provider={{ protocol: 'openai', url: 'https://example.test/v1', apiKey: 'key', models: { model: {} } }} onSave={onSave} onRemove={vi.fn()} />);
    if (!isNew) fireEvent.change(screen.getByDisplayValue('old-provider'), { target: { value: 'HX API' } });
    fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
    expect(screen.getByText('pilotDeckConfig.panels.models.providerIdInvalid')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([false, true])('removes a saved legacy provider through the server (in use=%s)', async (inUse) => {
    const changes = inUse ? [{ path: 'memory.model', value: 'HX API/model', kind: 'memory', action: 'inherit' }] : [];
    const plan = { target: { providerId: 'HX API' }, replacement: '', replacementOptions: [], requiresReplacement: false, changes, blocked: null, revision: 'rev-1' };
    const written = { exists: true, path: '/tmp/pilotdeck.yaml', raw: 'model: {}\n', revision: 'rev-2', validation: { valid: true, errors: [], warnings: [] } };
    mocks.authenticatedFetch.mockImplementation(async (url: string, init?: { body?: string }) => ({
      ok: true,
      json: async () => (url !== '/api/config/model-removal' ? {} : JSON.parse(init?.body ?? '{}').dryRun ? plan : written),
    }));
    const onRemove = vi.fn();
    const onRemoved = vi.fn();
    render(<ProviderCard providerId="HX API" provider={{ protocol: 'openai', url: 'https://example.test/v1', apiKey: '********', models: { model: {} } }}
      onSave={vi.fn()} onRemove={onRemove} onRemoved={onRemoved} />);
    fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.actions.remove' }));
    const confirm = await screen.findByRole('button', { name: 'pilotDeckConfig.panels.models.deleteDialog.delete' });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('pilotDeckConfig.panels.models.deleteDialog.groupInherit') !== null).toBe(inUse);
    fireEvent.click(confirm);
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(written));
    const removalCalls = mocks.authenticatedFetch.mock.calls.filter(([url]) => url === '/api/config/model-removal');
    const bodies = removalCalls.map(([, init]) => JSON.parse(init.body));
    expect(bodies).toEqual([
      { providerId: 'HX API', replacement: '', dryRun: true },
      { providerId: 'HX API', replacement: '', baseRevision: 'rev-1' },
    ]);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it.each([false, true])('removes a saved model through the server (in use=%s)', async (inUse) => {
    const changes = inUse ? [{ path: 'router.fallback.default.0', value: 'openrouter/auto', kind: 'router', action: 'remove' }] : [];
    const plan = { target: { providerId: 'openrouter', modelId: 'auto' }, replacement: '', replacementOptions: ['openrouter/other'], requiresReplacement: false, changes, blocked: null, revision: 'rev-1' };
    const written = { exists: true, path: '/tmp/pilotdeck.yaml', raw: 'model: {}\n', revision: 'rev-2', validation: { valid: true, errors: [], warnings: [] } };
    mocks.authenticatedFetch.mockImplementation(async (url: string, init?: { body?: string }) => ({
      ok: true,
      json: async () => (url !== '/api/config/model-removal' ? {} : JSON.parse(init?.body ?? '{}').dryRun ? plan : written),
    }));
    const onSave = vi.fn();
    const onRemoved = vi.fn();
    render(<ProviderCard providerId="openrouter" provider={{ protocol: 'openai', url: catalogEntry.defaultUrl, apiKey: 'key', models: { auto: {}, other: {} } }}
      catalogEntry={catalogEntry} onSave={onSave} onRemove={vi.fn()} onRemoved={onRemoved} />);
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'pilotDeckConfig.panels.models.removeModelAria' })[0]);
    const confirm = await screen.findByRole('button', { name: 'pilotDeckConfig.panels.models.deleteDialog.delete' });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('pilotDeckConfig.panels.models.deleteDialog.groupRemove') !== null).toBe(inUse);
    fireEvent.click(confirm);
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(written));
    const removalCalls = mocks.authenticatedFetch.mock.calls.filter(([url]) => url === '/api/config/model-removal');
    const bodies = removalCalls.map(([, init]) => JSON.parse(init.body));
    expect(bodies).toEqual([
      { providerId: 'openrouter', modelId: 'auto', replacement: '', dryRun: true },
      { providerId: 'openrouter', modelId: 'auto', replacement: '', baseRevision: 'rev-1' },
    ]);
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each(['openai', 'anthropic'] as const)('shows the fixed %s protocol for catalog providers in view and edit modes', async (protocol) => {
    render(<ProviderCard providerId="openrouter" provider={{ protocol, url: catalogEntry.defaultUrl, apiKey: 'key', models: { auto: {} } }}
      catalogEntry={catalogEntry} onSave={vi.fn()} onRemove={vi.fn()} />);
    const field = screen.getByLabelText('pilotDeckConfig.panels.models.protocol') as HTMLSelectElement;
    expect(field.value).toBe(protocol);
    expect(field.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
    expect(field.value).toBe(protocol);
    expect(field.disabled).toBe(true);
  });

  it('discards an unsaved provider locally without asking the server', async () => {
    const onRemove = vi.fn();
    render(<ProviderCard providerId="draft" isNew provider={{ protocol: 'openai', url: '', apiKey: '', models: {} }}
      onSave={vi.fn()} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.actions.remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'pilotDeckConfig.panels.models.deleteDialog.delete' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(mocks.authenticatedFetch.mock.calls.some(([url]) => url === '/api/config/model-removal')).toBe(false);
  });

  it("shows advanced provider JSON only in model settings and saves it with the model draft", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    render(
      <ProviderCard
        providerId="opencode"
        initialEditing
        provider={{
          protocol: "anthropic",
          url: "https://opencode.example/v1",
          apiKey: "sk-test",
          headers: { "x-opencode-session": "old-session" },
          timeoutMs: 30000,
          models: { "model-a": {} },
        }}
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByText("pilotDeckConfig.panels.models.providerAdvancedToggle")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "pilotDeckConfig.panels.models.providerAdvancedJson" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "model-a" }));
    const dialog = screen.getByRole("dialog");
    const editor = within(dialog).getByRole("textbox", { name: "pilotDeckConfig.panels.models.providerAdvancedJson" }) as HTMLTextAreaElement;
    expect(JSON.parse(editor.value)).toEqual({
      headers: { "x-opencode-session": "old-session" },
      timeoutMs: 30000,
    });
    expect(editor.value).not.toContain("sk-test");
    expect(editor.value).not.toContain("model-a");

    fireEvent.change(editor, {
      target: { value: JSON.stringify({ headers: { "x-opencode-session": "gateway-main" }, timeoutMs: 90000 }) },
    });
    fireEvent.change(within(dialog).getByLabelText("pilotDeckConfig.panels.models.maxOutputTokens"), { target: { value: "8192" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "pilotDeckConfig.panels.models.modelSettings.save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "actions.saveChanges" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("opencode", expect.objectContaining({
      protocol: "anthropic",
      url: "https://opencode.example/v1",
      apiKey: "sk-test",
      headers: { "x-opencode-session": "gateway-main" },
      timeoutMs: 90000,
      models: { "model-a": expect.objectContaining({
        capabilities: expect.objectContaining({ maxOutputTokens: 8192 }),
      }) },
    })));
  });

  it("nests provider JSON inside advanced settings below thinking format", () => {
    render(
      <ProviderCard
        providerId="opencode"
        provider={{
          protocol: "anthropic",
          url: "https://opencode.example/v1",
          apiKey: "sk-test",
          headers: { "x-opencode-session": "gateway-main" },
          models: { "model-a": {} },
        }}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "model-a" }));
    const dialog = screen.getByRole("dialog");
    const advanced = within(dialog).getByText("pilotDeckConfig.panels.models.modelSettings.thinkingAdvanced").closest("details");
    expect(advanced).not.toBeNull();
    const format = within(advanced as HTMLElement).getByLabelText("pilotDeckConfig.panels.models.modelSettings.thinkingFormat");
    const editor = within(advanced as HTMLElement).getByRole("textbox", { name: "pilotDeckConfig.panels.models.providerAdvancedJson" });
    expect(format.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editor.closest("details")).toBe(advanced);
    expect(within(dialog).queryByText("pilotDeckConfig.panels.models.providerAdvancedToggle")).toBeNull();
  });

  it("rejects malformed advanced JSON before saving or starting a connection test", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    render(
      <ProviderCard
        providerId="opencode"
        initialEditing
        provider={{ protocol: "anthropic", url: "https://opencode.example/v1", apiKey: "sk-test", models: { "model-a": {} } }}
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "model-a" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "pilotDeckConfig.panels.models.providerAdvancedJson" }), {
      target: { value: '{"headers":' },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "pilotDeckConfig.panels.models.modelSettings.saveAndTest" }));

    await screen.findByText("pilotDeckConfig.panels.models.providerAdvancedInvalid");
    expect(onSave).not.toHaveBeenCalled();
    expect(mocks.authenticatedFetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("disables modal save for malformed advanced JSON without duplicating the error", () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    render(
      <ProviderCard
        providerId="opencode"
        initialEditing
        provider={{ protocol: "anthropic", url: "https://opencode.example/v1", apiKey: "sk-test", models: { "model-a": {} } }}
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "model-a" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "pilotDeckConfig.panels.models.providerAdvancedJson" }), {
      target: { value: '{"headers":' },
    });
    const save = within(dialog).getByRole("button", { name: "pilotDeckConfig.panels.models.modelSettings.save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    expect(mocks.authenticatedFetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("preserves advanced provider fields through ordinary form saves", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const provider = {
      protocol: "openai" as const,
      url: "https://example.test/v1",
      apiKey: "old-key",
      headers: { "x-provider-session": "preserved" },
      timeoutMs: 45000,
      models: { "model-a": {} },
    };
    render(<ProviderCard providerId="custom" initialEditing provider={provider} onSave={onSave} onRemove={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("pilotDeckConfig.panels.models.apiKey"), { target: { value: "new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "actions.saveChanges" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("custom", { ...provider, apiKey: "new-key" }));
  });

  it("puts add-model first in candidates and enables a typed ID on enter", async () => {
    const onSave = vi.fn(async () => ({ok:true}));
    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: { "already-on": {} },
        }}
        catalogEntry={catalogEntry}
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "pilotDeckConfig.panels.models.addModelId" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.edit" }));

    const addButton = await screen.findByRole("button", { name: "pilotDeckConfig.panels.models.addModelId" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "anthropic/claude-fable" })).toBeTruthy();
    });

    expect(addButton.parentElement?.firstElementChild).toBe(addButton);
    expect(screen.queryByPlaceholderText("pilotDeckConfig.panels.models.customModelIdPlaceholder")).toBeNull();

    fireEvent.click(addButton);

    const input = screen.getByPlaceholderText("pilotDeckConfig.panels.models.customModelIdPlaceholder");
    expect(addButton.nextElementSibling).toBe(input);

    fireEvent.change(input, { target: { value: "my-custom-model" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByPlaceholderText("pilotDeckConfig.panels.models.customModelIdPlaceholder")).toBeNull();
    expect(screen.getByText("my-custom-model")).toBeTruthy();
    expect(screen.getByRole("button", { name: "my-custom-model" })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name:'my-custom-model'}));
    expect((screen.getByLabelText('pilotDeckConfig.panels.models.maxContextTokens') as HTMLInputElement).value).toBe('262144');
    expect((screen.getByLabelText('pilotDeckConfig.panels.models.maxOutputTokens') as HTMLInputElement).value).toBe('32768');
    fireEvent.click(screen.getByRole('button', {name:'confirmDialog.cancel'}));
    fireEvent.click(screen.getByRole('button', {name:'actions.saveChanges'}));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('openrouter', expect.objectContaining({models:expect.objectContaining({
      'my-custom-model':{capabilities:{maxContextTokens:262144,maxOutputTokens:32768}},
    })})));
  });
});

const passingTest = {
  status: "passed" as const,
  textInput: "supported" as const,
  imageInput: "supported" as const,
};

describe("ProviderCard connection badge", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    mocks.fetchProviderModels.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows configured when fields are complete without requiring a test", () => {
    const onPendingChange = vi.fn();
    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: { "model-a": {} },
        }}
        catalogEntry={catalogEntry}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onPendingChange={onPendingChange}
      />,
    );

    expect(screen.getByText("pilotDeckConfig.panels.models.configured")).toBeTruthy();
    expect(onPendingChange).toHaveBeenCalledWith(false);
  });

  it("shows connected when all enabled models passed, including manual image results", () => {
    const onPendingChange = vi.fn();
    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: {
            "model-a": { connectionTest: passingTest },
            "model-b": {
              connectionTest: {
                status: "passed",
                textInput: "supported",
                imageInput: "unsupported",
              },
            },
          },
        }}
        catalogEntry={catalogEntry}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onPendingChange={onPendingChange}
      />,
    );

    expect(screen.getByText("pilotDeckConfig.panels.models.configured")).toBeTruthy();
    expect(onPendingChange).toHaveBeenCalledWith(false);
  });


  it('saves a model without testing, preserving its other fields and sibling models', async () => {
    const onSave = vi.fn(async (_id: string, _provider: unknown) => ({ok:true}));
    const provider = { protocol:'openai' as const, url:'https://example.test/v1',apiKey:'key',models:{one:{capabilities:{maxOutputTokens:1024,supportsToolUse:true},multimodal:{input:['text','pdf'],maxPdfPages:5}},two:{capabilities:{maxOutputTokens:2048}}}};
    render(<ProviderCard providerId="HXAPI" provider={provider} onSave={onSave} onRemove={vi.fn()} />);
    expect(screen.queryByRole('button',{name:'pilotDeckConfig.panels.models.testConnection'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'one'}));
    fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.models.maxOutputTokens'),{target:{value:'8192'}});
    fireEvent.click(screen.getByRole('checkbox', {name:'pilotDeckConfig.panels.models.modelSettings.imageInput'}));
    fireEvent.click(screen.getByRole('button',{name:'pilotDeckConfig.panels.models.modelSettings.save'}));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][1]).toMatchObject({models:{one:{capabilities:{maxOutputTokens:8192,supportsToolUse:true},multimodal:{input:['text','pdf','image'],maxPdfPages:5}},two:provider.models.two}});
    expect(mocks.authenticatedFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('saves advanced provider JSON with model settings outside edit mode', async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const provider = {
      protocol: 'anthropic' as const,
      url: 'https://opencode.example/v1',
      apiKey: 'key',
      headers: { 'x-opencode-session': 'preserved' },
      timeoutMs: 45000,
      models: { one: { capabilities: { maxOutputTokens: 1024 } } },
    };
    render(<ProviderCard providerId="opencode" provider={provider} onSave={onSave} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'pilotDeckConfig.panels.models.providerAdvancedJson' }), {
      target: { value: JSON.stringify({ headers: { 'x-opencode-session': 'gateway-main' }, timeoutMs: 90000 }) },
    });
    fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.models.maxOutputTokens'), { target: { value: '8192' } });
    fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.panels.models.modelSettings.save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('opencode', expect.objectContaining({
      headers: { 'x-opencode-session': 'gateway-main' },
      timeoutMs: 90000,
      models: { one: expect.objectContaining({ capabilities: expect.objectContaining({ maxOutputTokens: 8192 }) }) },
    })));
  });

  it('saves changed advanced JSON before testing in view mode', async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const provider = {
      protocol: 'anthropic' as const,
      url: 'https://opencode.example/v1',
      apiKey: 'key',
      headers: { 'x-opencode-session': 'old-session' },
      models: { one: {} },
    };
    render(<ProviderCard providerId="opencode" provider={provider} onSave={onSave} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'pilotDeckConfig.panels.models.providerAdvancedJson' }), {
      target: { value: JSON.stringify({ headers: { 'x-opencode-session': 'gateway-main' } }) },
    });
    const button = screen.getByRole('button', { name: 'pilotDeckConfig.panels.models.modelSettings.saveAndTest' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('opencode', expect.objectContaining({
      headers: { 'x-opencode-session': 'gateway-main' },
    })));
    await waitFor(() => expect(mocks.authenticatedFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1));
  });

  it('tests only the selected model, restores progress after remount and never saves on completion', async () => {
    let tasks: any[] = [];
    mocks.authenticatedFetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') tasks = [{id:'single',providerId:'HXAPI',modelId:'one',status:'testing'}];
      return {ok:true,json:async()=>({tasks})};
    });
    const props = {providerId:'HXAPI',provider:{protocol:'openai' as const,url:'https://example.test/v1',apiKey:'key',models:{one:{},two:{}}},onSave:vi.fn(),onRemove:vi.fn()};
    const first = render(<ProviderCard {...props} />);
    fireEvent.click(screen.getByRole('button',{name:'one'}));
    const button = screen.getByRole('button',{name:'pilotDeckConfig.panels.models.testConnection'}) as HTMLButtonElement;
    await waitFor(()=>expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByRole('button',{name:'pilotDeckConfig.panels.models.modelSettings.testing'});
    expect(JSON.parse(mocks.authenticatedFetch.mock.calls.find(([,o])=>o?.method==='POST')![1].body)).toEqual({providerId:'HXAPI',modelId:'one'});
    first.unmount();
    render(<ProviderCard {...props} />);
    fireEvent.click(screen.getByRole('button',{name:'two'}));
    expect((screen.getByRole('button',{name:'pilotDeckConfig.panels.models.testConnection'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'confirmDialog.cancel'}));
    fireEvent.click(screen.getByRole('button',{name:'one'}));
    await screen.findByRole('button',{name:'pilotDeckConfig.panels.models.modelSettings.testing'});
    tasks = [{...tasks[0],status:'success',result:{models:[{modelId:'one',textInput:'supported',imageInput:'supported'}]}}];
    await waitFor(()=>expect((screen.getByRole('checkbox', {name:'pilotDeckConfig.panels.models.modelSettings.imageInput'}) as HTMLInputElement).checked).toBe(true),{timeout:3000});
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'confirmDialog.cancel'}));
    fireEvent.click(screen.getByRole('button',{name:'one'}));
    expect((screen.getByRole('checkbox', {name:'pilotDeckConfig.panels.models.modelSettings.imageInput'}) as HTMLInputElement).checked).toBe(false);
  });

  it.each(['existing', 'new', 'renamed'])('allows a complete %s provider to save its current settings before testing', async (mode) => {
    let finishSave!: (value: {ok:boolean}) => void;
    const onSave = vi.fn(() => new Promise<{ok:boolean}>(resolve => { finishSave = resolve; }));
    const provider = {protocol:'openai' as const,url:'https://example.test/v1',apiKey:'old-key',models:{one:{},two:{capabilities:{maxOutputTokens:2048}}}};
    render(<ProviderCard providerId="test-provider" provider={provider} initialEditing isNew={mode === 'new'} onSave={onSave} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.models.apiKey'), {target:{value:'updated-key'}});
    if (mode === 'renamed') fireEvent.change(screen.getByDisplayValue('test-provider'), {target:{value:'renamed-provider'}});
    fireEvent.click(screen.getByRole('button', {name:'one'}));
    fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.models.maxContextTokens'), {target:{value:'180000'}});
    const button = screen.getByRole('button', {name:'pilotDeckConfig.panels.models.modelSettings.saveAndTest'}) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(mode === 'renamed' ? 'renamed-provider' : 'test-provider', expect.objectContaining({
      apiKey:'updated-key',models:expect.objectContaining({one:expect.objectContaining({capabilities:expect.objectContaining({maxContextTokens:180000})}),two:provider.models.two}),
    }));
    expect(mocks.authenticatedFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    finishSave({ok:true});
    await waitFor(() => expect(mocks.authenticatedFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1));
    expect(JSON.parse(mocks.authenticatedFetch.mock.calls.find(([, options]) => options?.method === 'POST')![1].body)).toEqual({providerId:mode === 'renamed' ? 'renamed-provider' : 'test-provider',modelId:'one'});
  });

  it('does not test stale configuration after a failed save', async () => {
    const onSave = vi.fn(async () => ({ok:false,error:'Configuration conflict'}));
    render(<ProviderCard providerId="test-provider" provider={{protocol:'openai',url:'https://example.test/v1',apiKey:'key',models:{one:{}}}} initialEditing onSave={onSave} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', {name:'one'}));
    const button = screen.getByRole('button', {name:'pilotDeckConfig.panels.models.modelSettings.saveAndTest'}) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('Configuration conflict');
    expect(mocks.authenticatedFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('explains missing credentials instead of silently disabling a test', async () => {
    render(<ProviderCard providerId="test-provider" provider={{protocol:'openai',url:'https://example.test/v1',apiKey:'',models:{one:{}}}} onSave={vi.fn()} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', {name:'one'}));
    expect((screen.getByRole('button', {name:'pilotDeckConfig.panels.models.testConnection'}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('pilotDeckConfig.panels.models.providerApiKeyRequired')).toBeTruthy();
  });

  it('lets the user cancel an unfinished test from another provider and then test this model', async () => {
    let tasks = [{id:'previous',providerId:'previous-provider',status:'manual'}];
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/previous/cancel')) tasks = [{...tasks[0],status:'cancelled'}];
      return {ok:true,json:async()=>({tasks})};
    });
    render(<ProviderCard providerId="test-provider" provider={{protocol:'openai',url:'https://example.test/v1',apiKey:'key',models:{one:{}}}} onSave={vi.fn()} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', {name:'one'}));
    await screen.findByText('pilotDeckConfig.panels.models.modelSettings.otherTestRunning');
    const button = screen.getByRole('button', {name:'pilotDeckConfig.panels.models.testConnection'}) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', {name:'pilotDeckConfig.panels.models.modelSettings.cancelPreviousTest'}));
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(mocks.authenticatedFetch).toHaveBeenCalledWith('/api/config/connection-test-tasks/previous/cancel', expect.objectContaining({method:'POST'}));
  });

  it('recovers the test button after a temporary status request failure', async () => {
    mocks.authenticatedFetch.mockRejectedValueOnce(new Error('Offline'));
    render(<ProviderCard providerId="test-provider" provider={{protocol:'openai',url:'https://example.test/v1',apiKey:'key',models:{one:{}}}} onSave={vi.fn()} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', {name:'one'}));
    await screen.findByText('pilotDeckConfig.panels.models.testStatusUnavailable');
    const button = screen.getByRole('button', {name:'pilotDeckConfig.panels.models.testConnection'}) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(button.disabled).toBe(false), {timeout:3000});
  });
});
