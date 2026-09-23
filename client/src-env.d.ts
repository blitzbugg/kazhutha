/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute game-server URL for split deployments; same origin by default (D43). */
  readonly VITE_SERVER_URL?: string;
}

declare module '*.css';
