export interface Screenshot {
  base64: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  signature: Uint8Array;
}

export async function captureScreen(_opts?: {
  displayId?: number;
  region?: { x: number; y: number; w: number; h: number };
  regionRef?: Screenshot;
}): Promise<Screenshot | { error: string }> {
  return {
    error: "Screen capture requires the OpenDex desktop application.",
  };
}

export async function captureStable(): Promise<Screenshot | { error: string }> {
  return captureScreen();
}

export function framesDiffer(_a: Uint8Array, _b: Uint8Array): boolean {
  return false;
}

export function toScreenPoint(
  x: number,
  y: number,
  shot: Screenshot,
): { x: number; y: number } {
  return {
    x: Math.round(shot.offsetX + x * shot.scaleX),
    y: Math.round(shot.offsetY + y * shot.scaleY),
  };
}
