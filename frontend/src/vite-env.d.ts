/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_EXPLORER_URL?: string;
  readonly VITE_FAIRBATCH_ADDRESS?: string;
  readonly VITE_BASE_TOKEN_ADDRESS?: string;
  readonly VITE_QUOTE_TOKEN_ADDRESS?: string;
  readonly VITE_DEPLOYMENT_BLOCK?: string;
  readonly VITE_COMMIT_WINDOW_SECS?: string;
  readonly VITE_REVEAL_WINDOW_SECS?: string;
  readonly VITE_MIN_BOND_WEI?: string;
  readonly VITE_INITIAL_RESERVE_BASE?: string;
  readonly VITE_INITIAL_RESERVE_QUOTE?: string;
}

interface Window {
  ethereum?: {
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  };
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
