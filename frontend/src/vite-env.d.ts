/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ALCHEMY_API_KEY?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_KEEPER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface InjectedEthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  isBraveWallet?: boolean;
  isPhantom?: boolean;
  isRainbow?: boolean;
  isOkxWallet?: boolean;
  isTrust?: boolean;
  providers?: InjectedEthereumProvider[];
}

interface Window {
  ethereum?: InjectedEthereumProvider;
}
