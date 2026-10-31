/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Full WebSocket URL of the backend, e.g. wss://tank-clash-server.example.com/ws */
  readonly VITE_WS_URL?: string;
  /** Public origin used to build invite links (defaults to window.location.origin). */
  readonly VITE_PUBLIC_ORIGIN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
