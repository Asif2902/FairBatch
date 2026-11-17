import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../App';
import { fallbackStore } from '../lib/fallbackEngine';

describe('FairBatch Institutional Exchange UI & End-to-End Flows', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fallbackStore.reset(100, 300_000);
  });

  it('renders initial Batch #1 KPIs, SVG depth chart, and flagship 5-sellers p* = $2,727.27', async () => {
    render(<App />);

    expect(screen.getByTestId('batch-id-badge')).toHaveTextContent('BATCH #1');
    expect(screen.getByTestId('reserve-rx')).toHaveTextContent('100.00 WETH');
    expect(screen.getByTestId('reserve-ry')).toHaveTextContent('300,000 USDC');
    expect(screen.getByTestId('pool-spot-price')).toHaveTextContent('$3,000.00');

    // Accessibility landmarks & SVG visualizer
    expect(
      screen.getByRole('navigation', { name: /Batch Lifecycle Stepper/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Batch Supply and Demand Depth Chart/i }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.getByTestId('uniform-clearing-price-readout'),
      ).toHaveTextContent('$2,727.27 USDC/WETH');
    });
    expect(screen.getByTestId('fairbatch-mev-profit')).toHaveTextContent('$0.00');
  });

  it('switches presets (Balanced CoW & Marginal Pro-Rata) and toggles MEV Sandwich Bot', async () => {
    render(<App />);

    // Switch to Balanced CoW Crossing
    const cowBtn = screen.getByRole('button', {
      name: /Balanced CoW Crossing/i,
    });
    fireEvent.click(cowBtn);

    await waitFor(() => {
      expect(
        screen.getByTestId('uniform-clearing-price-readout'),
      ).toHaveTextContent('$3,000.00 USDC/WETH');
      expect(screen.getByTestId('cow-ratio-kpi')).toHaveTextContent('100.0%');
    });

    // Switch to Marginal Limit Tier (Pro-Rata Partial Fill)
    const margBtn = screen.getByRole('button', {
      name: /Marginal Limit Tier/i,
    });
    fireEvent.click(margBtn);

    await waitFor(() => {
      expect(
        screen.getByTestId('uniform-clearing-price-readout'),
      ).toHaveTextContent('$2,800.00 USDC/WETH');
    });
    expect(screen.getAllByText('Pro-Rata Partial').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Refunded (OTM)').length).toBeGreaterThan(0);

    // Switch back to 5 Sellers and wait for async load before toggling MEV Sandwich Bot
    fireEvent.click(
      screen.getByRole('button', { name: /5 Users Swap ETH/i }),
    );
    const mevSwitch = screen.getByRole('switch', {
      name: /Inject MEV Sandwich Bot/i,
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('uniform-clearing-price-readout'),
      ).toHaveTextContent('$2,727.27 USDC/WETH');
      expect(mevSwitch).not.toBeDisabled();
    });
    expect(mevSwitch).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(mevSwitch);

    await waitFor(() => {
      expect(mevSwitch).toHaveAttribute('aria-checked', 'true');
      const ammProfitText = screen.getByTestId('amm-mev-profit').textContent ?? '';
      expect(ammProfitText).not.toBe('$0.00');
      expect(screen.getByTestId('fairbatch-mev-profit')).toHaveTextContent(
        '$0.00',
      );
    });
  });

  it('completes full Commit -> Advance Phase -> Reveal -> Settle -> Multicall Claim user journey', async () => {
    render(<App />);

    // Select Commit-Reveal tab
    const commitTab = screen.getByRole('tab', { name: /Commit-Reveal/i });
    fireEvent.click(commitTab);

    expect(screen.getByTestId('commitment-hash-preview').textContent).toMatch(
      /^0x[0-9a-f]{64}$/,
    );

    // Seal & Lock Commitment
    const sealBtn = screen.getByRole('button', {
      name: /Seal & Lock Commitment/i,
    });
    fireEvent.click(sealBtn);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Reveal Secret/i }),
      ).toBeDisabled();
    });

    // Advance Batch Phase from Open -> Reveal
    const advanceBtn = screen.getByRole('button', {
      name: /Advance to Reveal/i,
    });
    fireEvent.click(advanceBtn);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Reveal Secret/i }),
      ).not.toBeDisabled();
    });

    // Reveal the secret commitment
    fireEvent.click(screen.getByRole('button', { name: /Reveal Secret/i }));

    await waitFor(() => {
      expect(screen.getByText('Revealed')).toBeInTheDocument();
    });

    // Settle Batch Now
    const settleBtn = screen.getByRole('button', {
      name: /Settle Batch Now/i,
    });
    fireEvent.click(settleBtn);

    await waitFor(() => {
      expect(screen.getByTestId('batch-id-badge')).toHaveTextContent('BATCH #2');
    });

    // Execute Multicall Batch Claim across Alice's settled orders
    const multicallBtn = screen.getByRole('button', {
      name: /Multicall Batch Claim/i,
    });
    expect(multicallBtn).not.toBeDisabled();
    fireEvent.click(multicallBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/Executed Multicall claim/i),
      ).toBeInTheDocument();
    });
  });

  it('signs and submits an EIP-712 Signed Intent and updates Contract & Network Config', async () => {
    render(<App />);

    // Switch to EIP-712 Intent tab
    fireEvent.click(screen.getByRole('tab', { name: /EIP-712 Intent/i }));

    const signBtn = screen.getByRole('button', {
      name: /1\. Sign EIP-712 Intent/i,
    });
    fireEvent.click(signBtn);

    await waitFor(() => {
      expect(screen.getByTestId('eip712-signature-box')).toBeInTheDocument();
    });

    const submitIntentBtn = screen.getByRole('button', {
      name: /2\. Submit Signed Intent/i,
    });
    expect(submitIntentBtn).not.toBeDisabled();
    fireEvent.click(submitIntentBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/Verified secp256k1 signer & queued EIP-712 intent/i),
      ).toBeInTheDocument();
    });

    // Open Why Fe 26.5? Architecture Inspector
    fireEvent.click(screen.getByRole('button', { name: /Why Fe 26\.5\?/i }));
    expect(
      screen.getByRole('dialog', { name: /Why Fe 26\.5\.0\?/i }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /Close Fe Architecture Inspector/i }),
    );

    // Open Contract & Network Config Modal and save Sepolia deployment address
    fireEvent.click(
      screen.getByRole('button', { name: /Contract & Network Config/i }),
    );
    const addrInput = screen.getByLabelText(/FairBatch Contract Address/i);
    fireEvent.change(addrInput, {
      target: { value: '0x1234567890123456789012345678901234567890' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Save Contract Config/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Runtime contract & RPC bridge configuration updated/i),
      ).toBeInTheDocument();
    });
  });

  it('displays Connected: Rust Solver + Fe Artifacts badge when /api/health & /api/state respond HTTP 200', async () => {
    const liveState = fallbackStore.getState();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/health')) {
          return new Response(
            JSON.stringify({
              status: 'ok',
              execution_mode: 'local_engine',
              rpc_url: null,
              chain_id: 31337,
              contracts: {
                fair_batch: '0x0000000000000000000000000000000000000000',
                base_token: '0x0000000000000000000000000000000000000000',
                quote_token: '0x0000000000000000000000000000000000000000',
                deployed: false,
              },
              fe_artifacts_present: true,
              fe_artifacts: ['out/FairBatch.bin', 'out/FairBatch.abi.json'],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/api/state')) {
          return new Response(JSON.stringify(liveState), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/api/compare')) {
          const { settlement } = fallbackStore.settleBatch();
          fallbackStore.reset(100, 300_000);
          return new Response(JSON.stringify({ settlement }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(liveState), { status: 200 });
      },
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('connection-status-badge')).toHaveTextContent(
        'Connected: Rust Solver + Fe Artifacts',
      );
    });

    // Verify ContractConfigModal syncs live /api/health chain_id (31337) when opened
    fireEvent.click(
      screen.getByRole('button', { name: /Contract & Network Config/i }),
    );
    expect(screen.getByLabelText(/Chain ID/i)).toHaveValue(31337);
    fireEvent.click(
      screen.getByRole('button', {
        name: /Close Contract Configuration Modal/i,
      }),
    );

    expect(fetchSpy).toHaveBeenCalled();
  });
});
