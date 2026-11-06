// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it } from 'vitest';
import { createTestI18n } from '../../../i18n/testInstance';
import { ToolRenderer } from './ToolRenderer';

afterEach(cleanup);

it('mounts a controlled text result only when expanded and still renders streaming updates', async () => {
  const i18n = await createTestI18n();
  const tool = (expanded: boolean, content: string) => (
    <I18nextProvider i18n={i18n}>
      <ToolRenderer
        toolName="Bash"
        toolId="tool-large-output"
        toolInput={{ command: 'pwd' }}
        toolResult={{ content, isError: false }}
        mode="result"
        expansionKey="tool-large-output:result"
        isToolSectionExpanded={() => expanded}
        onToolSectionExpandedChange={() => {}}
      />
    </I18nextProvider>
  );

  const view = render(tool(false, 'LARGE_OUTPUT_SENTINEL'));
  expect(view.container.textContent).not.toContain('LARGE_OUTPUT_SENTINEL');

  view.rerender(tool(true, 'LARGE_OUTPUT_SENTINEL'));
  expect(view.container.textContent).toContain('LARGE_OUTPUT_SENTINEL');

  view.rerender(tool(true, 'LARGE_OUTPUT_SENTINEL streaming update'));
  expect(view.container.textContent).toContain('LARGE_OUTPUT_SENTINEL streaming update');
});

it('defers a collapsed Grep file list until expansion', async () => {
  const i18n = await createTestI18n();
  const tool = (expanded: boolean) => (
    <I18nextProvider i18n={i18n}>
      <ToolRenderer
        toolName="Grep"
        toolId="tool-large-file-list"
        toolInput={{ pattern: 'sentinel' }}
        toolResult={{
          content: '', isError: false,
          toolUseResult: { filenames: ['/root/LARGE_FILE_SENTINEL.ts'], numFiles: 1 },
        }}
        mode="result"
        expansionKey="tool-large-file-list:result"
        isToolSectionExpanded={() => expanded}
        onToolSectionExpandedChange={() => {}}
      />
    </I18nextProvider>
  );

  const view = render(tool(false));
  expect(view.container.textContent).not.toContain('LARGE_FILE_SENTINEL');
  view.rerender(tool(true));
  expect(view.container.textContent).toContain('LARGE_FILE_SENTINEL');
});
