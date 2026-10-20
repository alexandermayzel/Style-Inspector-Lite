import { clamp, isRGBA, linearToSrgb, luminance, srgbToLinear } from './colors';
import type { RGBA, SimulationMode } from './types';

// Machado, Oliveira & Fernandes (2009), severity 1.0. Numerical tables verified
// against colorspacious/cvd.py; the bundled third-party notice preserves its MIT license.
// Row-major matrices operate on linear sRGB. Out-of-gamut results are clipped per
// linear channel before sRGB encoding. This is a preview, never an audit result.
export const MACHADO = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
} as const;
export function simulateColor(color: RGBA, mode: SimulationMode): RGBA | null {
  if (!isRGBA(color) || color.a !== 1) return null;
  if (mode === 'original') return { ...color };
  if (mode === 'grayscale') {
    const v = linearToSrgb(luminance(color));
    return { r: v, g: v, b: v, a: 1 };
  }
  const m = MACHADO[mode];
  if (!m) return null;
  const rgb = [color.r, color.g, color.b].map(srgbToLinear);
  const result = m.map(row => linearToSrgb(clamp(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])));
  return { r: result[0], g: result[1], b: result[2], a: 1 };
}
