import React from 'react';
import { Check } from 'lucide-react';
import type { SimpleStep } from '../../onchain/useFairBatch';

interface ProgressStripProps {
  currentStep: SimpleStep;
  hasTokens: boolean;
  hasActiveOrder: boolean;
  hasUnclaimed: boolean;
}

const STEPS: ReadonlyArray<{ id: SimpleStep; label: string; shortLabel: string }> = [
  { id: 1, label: 'Connect', shortLabel: 'Connect' },
  { id: 2, label: 'Get test tokens', shortLabel: 'Tokens' },
  { id: 3, label: 'Swap', shortLabel: 'Swap' },
  { id: 4, label: 'Collect', shortLabel: 'Collect' },
];

export const ProgressStrip: React.FC<ProgressStripProps> = ({
  currentStep,
  hasTokens,
  hasActiveOrder,
  hasUnclaimed,
}) => {
  const isStepComplete = (step: SimpleStep): boolean => {
    if (step === 1) return currentStep > 1;
    if (step === 2) return currentStep > 2 || hasTokens;
    if (step === 3) return currentStep === 4 || hasUnclaimed;
    return false;
  };

  return (
    <nav
      aria-label="Swap progress"
      data-testid="simple-progress-strip"
      className="border border-rule bg-paper-bright px-3 py-3 sm:px-4"
    >
      <ol className="grid grid-cols-4 gap-1.5 sm:gap-2">
        {STEPS.map((step) => {
          const active = currentStep === step.id;
          const done = !active && isStepComplete(step.id);
          const pendingRound = step.id === 3 && active && hasActiveOrder;

          return (
            <li
              key={step.id}
              aria-current={active ? 'step' : undefined}
              className={`flex min-w-0 items-center gap-1.5 border px-2 py-2 sm:gap-2 sm:px-3 ${
                active
                  ? 'border-vermilion-600 bg-vermilion-50 text-vermilion-800'
                  : done
                    ? 'border-pine-600/40 bg-pine-50 text-pine-800'
                    : 'border-rule bg-paper-soft text-ink-muted'
              }`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center font-mono text-xs font-bold ${
                  active
                    ? 'bg-vermilion-500 text-paper'
                    : done
                      ? 'bg-pine-600 text-paper'
                      : 'border border-rule-strong bg-paper-bright text-ink-muted'
                }`}
              >
                {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : step.id}
              </span>
              <div className="min-w-0">
                <span className="hidden truncate text-xs font-bold sm:block">
                  {step.label}
                </span>
                <span className="block truncate text-xs font-bold sm:hidden">
                  {step.shortLabel}
                </span>
                {pendingRound && (
                  <span className="hidden font-mono text-xs text-vermilion-700 md:block">
                    In round
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
