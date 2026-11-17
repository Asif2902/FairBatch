/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_FAIRBATCH_ADDRESS?: string;
  readonly VITE_BASE_TOKEN_ADDRESS?: string;
  readonly VITE_QUOTE_TOKEN_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
