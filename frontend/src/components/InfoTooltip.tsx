import React, { useEffect, useId, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';

interface InfoTooltipProps {
  label: string;
  text: string;
  glossaryAnchor?: string;
}

function inferGlossaryAnchor(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes('p*') || lower.includes('clearing price') || lower.includes('fair')) {
    return 'glossary-fair-price';
  }
  if (lower.includes('bond') || lower.includes('deposit') || lower.includes('slash')) {
    return 'glossary-deposit';
  }
  if (lower.includes('pull') || lower.includes('claim') || lower.includes('collect')) {
    return 'glossary-collect';
  }
  if (lower.includes('cow')) return 'glossary-cow';
  if (lower.includes('fm-amm') || lower.includes('saving') || lower.includes('spot')) {
    return 'glossary-fm-amm';
  }
  if (lower.includes('lnd') || lower.includes('invariant') || lower.includes('reserve')) {
    return 'glossary-lnd';
  }
  if (lower.includes('pro-rata') || lower.includes('slippage')) return 'glossary-slippage';
  if (lower.includes('nonce') || lower.includes('712')) return 'glossary-nonce';
  return 'glossary-round';
}

export const InfoTooltip: React.FC<InfoTooltipProps> = ({
  label,
  text,
  glossaryAnchor,
}) => {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const anchorId = glossaryAnchor ?? inferGlossaryAnchor(label);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  return (
    <span
      ref={containerRef}
      className="relative inline-flex items-center align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`Explain ${label}`}
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-muted transition hover:text-ink"
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          className="absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 border border-ink bg-paper-bright px-3 py-2 text-left font-sans text-xs font-normal normal-case leading-relaxed tracking-normal text-ink shadow-lg"
        >
          <span className="block">{text}</span>
          <a
            href={`#/docs#${anchorId}`}
            onClick={() => setOpen(false)}
            className="mt-1.5 inline-block font-mono text-[10px] font-bold text-cobalt-700 underline decoration-dotted hover:text-ink"
          >
            Glossary: #{anchorId.replace('glossary-', '')} →
          </a>
        </span>
      )}
    </span>
  );
};
