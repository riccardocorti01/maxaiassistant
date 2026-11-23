// Ambient global so the renderer is fully typed against window.opendex.
import type { OpenDexApi } from "./api-types";

declare global {
  interface Window {
    opendex: OpenDexApi;
  }
}

export {};
