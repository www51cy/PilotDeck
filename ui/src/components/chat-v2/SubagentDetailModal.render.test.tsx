// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import SubagentDetailModal from './SubagentDetailModal';

const flowRender = vi.hoisted(() => vi.fn(() => null));
vi.mock('./SubagentDetailMessageFlow', () => ({ default: flowRender }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
  flowRender.mockClear();
});

it('skips unchanged detail renders while preserving streaming message updates', () => {
  const messages: ChatMessage[] = [{
    id: 'child-1', type: 'assistant', content: 'First chunk', timestamp: '2026-11-06T03:58:39.000Z',
  }];
  const props = {
    subagentId: 'subagent-1',
    messages,
    isLoading: false,
    error: null,
    provider: 'pilotdeck' as const,
    selectedProject: null,
    createDiff: () => [],
    onClose: () => {},
  };
  const view = render(<SubagentDetailModal {...props} />);
  expect(flowRender).toHaveBeenCalledTimes(1);

  view.rerender(<SubagentDetailModal {...props} />);
  expect(flowRender).toHaveBeenCalledTimes(1);

  view.rerender(<SubagentDetailModal {...props} messages={[
    ...messages,
    { ...messages[0], id: 'child-2', content: 'First chunk, continued' },
  ]} />);
  expect(flowRender).toHaveBeenCalledTimes(2);
});
