import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  CANONICAL_DOC_BUTTON_LABELS,
  FORBIDDEN_STALE_LABELS,
  UI_LABELS,
} from '../lib/uiLabels';
import { DEFAULT_RUNTIME_CONFIG } from '../onchain/config';
import { DocsPage } from '../components/docs/DocsPage';

const FRONTEND_SRC = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '../../..');

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

describe('UI button label parity across /docs, tooltips, and README.md', () => {
  it('renders only canonical uiLabels.ts button labels across every /docs tab', () => {
    const { container } = render(
      <DocsPage
        config={DEFAULT_RUNTIME_CONFIG}
        rx={100}
        ry={300_000}
        onBackToExchange={() => undefined}
      />,
    );

    const observedLabels = new Set<string>();
    const tabIds = ['user', 'developer', 'visuals', 'security', 'glossary'] as const;

    for (const tabId of tabIds) {
      fireEvent.click(screen.getByTestId(`docs-tab-${tabId}`));
      const nodes = container.querySelectorAll('[data-ui-label]');
      nodes.forEach((node) => {
        const label = node.getAttribute('data-ui-label') ?? node.textContent ?? '';
        observedLabels.add(label.trim());
        expect(
          CANONICAL_DOC_BUTTON_LABELS.has(label.trim()),
          `Unknown button label "${label}" rendered in /docs tab "${tabId}" — add or align in src/lib/uiLabels.ts`,
        ).toBe(true);
      });
    }

    // Required canonical labels must all be actively documented in /docs
    expect(observedLabels.has(UI_LABELS.startNextRound)).toBe(true);
    expect(observedLabels.has(UI_LABELS.startNextRoundAndSwap)).toBe(true);
    expect(observedLabels.has(UI_LABELS.collectAllOrdersPattern)).toBe(true);
    expect(observedLabels.has(UI_LABELS.settleBatchAndOpenNextPattern)).toBe(true);
    expect(observedLabels.has(UI_LABELS.collectTokens)).toBe(true);
    expect(observedLabels.has(UI_LABELS.submitItMyself)).toBe(true);
    expect(observedLabels.has(UI_LABELS.revealNow)).toBe(true);
  });

  it('forbids stale or drifted button labels across /docs, tooltips, modals, and README.md', () => {
    const docFiles = [
      path.join(FRONTEND_SRC, 'components/docs/DocsPage.tsx'),
      path.join(FRONTEND_SRC, 'components/docs/DocsAnimations.tsx'),
      path.join(FRONTEND_SRC, 'lib/glossary.ts'),
      path.join(FRONTEND_SRC, 'components/HowItWorksModal.tsx'),
      path.join(REPO_ROOT, 'README.md'),
    ];

    // Check both the forbidden list AND any "click **X**" / "press **X**" / "click <strong>X</strong>" pattern
    const clickBoldRe =
      /(?:click|press)\s+(?:\*\*([^*]+)\*\*|<strong>([^<]+)<\/strong>)/gi;

    for (const filePath of docFiles) {
      const content = readText(filePath);
      const rel = path.relative(REPO_ROOT, filePath);

      for (const stale of FORBIDDEN_STALE_LABELS) {
        expect(
          content.includes(stale),
          `Stale button label "${stale}" found in ${rel} — replace with canonical label from src/lib/uiLabels.ts`,
        ).toBe(false);
      }

      let match: RegExpExecArray | null;
      while ((match = clickBoldRe.exec(content)) !== null) {
        const label = (match[1] ?? match[2] ?? '').trim();
        // Skip quick-percentage chip group or top-nav tab descriptions like "Docs"
        if (label === '25% / 50% / 75% / 100% / Max' || label === 'Docs') continue;
        expect(
          CANONICAL_DOC_BUTTON_LABELS.has(label),
          `Non-canonical button label "${label}" after click/press in ${rel} — must exist in src/lib/uiLabels.ts`,
        ).toBe(true);
      }
    }
  });

  it('verifies README.md uses exact flagship button labels from uiLabels.ts', () => {
    const readme = readText(path.join(REPO_ROOT, 'README.md'));
    expect(readme).toContain(`**${UI_LABELS.startNextRound}**`);
    expect(readme).toContain(`**${UI_LABELS.startNextRoundAndSwap}**`);
    expect(readme).toContain(`**${UI_LABELS.collectAllOrdersPattern}**`);
    expect(readme).toContain(`**${UI_LABELS.settleBatchAndOpenNextPattern}**`);
    expect(readme).toContain(`**${UI_LABELS.getFreeTestTokens}**`);
    expect(readme).toContain(`**${UI_LABELS.submitItMyself}**`);
    expect(readme).toContain(`**${UI_LABELS.slashAndClaimBounty}**`);
  });
});
