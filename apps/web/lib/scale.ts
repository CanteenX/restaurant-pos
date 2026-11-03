// Weighing-scale driver layer: frame parsers (CAS / Mettler-style ASCII),
// stable-weight detection, weight-priced line maths and a software simulator.
// Transports (serial / HID / network) are pluggable via ScaleAdapter.

export interface ScaleFrame {
  grams: number;
  stable: boolean;
}

export interface ScaleAdapter {
  /** Returns the next raw ASCII frame from the device. */
  readFrame(): string;
}

// "ST,GS,   1.250kg", "US,GS, 0.480kg", "S S      1.250 kg", "S D 0.5 kg", "ST,GS, 350g"
const FRAME = /^\s*(?:(ST|US)\s*,\s*[A-Z]{2}\s*,|S\s+([SD]))\s*(-?\d+(?:\.\d+)?)\s*(kg|g)\s*$/i;

export function parseScaleFrame(raw: string): ScaleFrame | null {
  const m = FRAME.exec(raw.replace(/[\r\n\0]+/g, "").trimEnd());
  if (!m) return null;
  const value = Number(m[3]);
  if (!Number.isFinite(value) || value < 0) return null;
  const grams = Math.round(m[4].toLowerCase() === "kg" ? value * 1000 : value);
  const stable = m[1] ? m[1].toUpperCase() === "ST" : m[2].toUpperCase() === "S";
  return { grams, stable };
}

export class StableWeightDetector {
  private readings: number[] = [];
  private opts: { readings: number; toleranceGrams: number };
  constructor(opts: { readings: number; toleranceGrams: number }) {
    this.opts = opts;
  }

  /** Feed a reading; returns the settled grams once stable, else null. */
  push(grams: number, deviceStable?: boolean): number | null {
    const last = this.readings[this.readings.length - 1];
    if (last !== undefined && Math.abs(grams - last) > this.opts.toleranceGrams) {
      this.readings = [];
    }
    this.readings.push(grams);
    if (this.readings.length > this.opts.readings) this.readings.shift();
    if (deviceStable === false) return null;
    return this.readings.length >= this.opts.readings ? grams : null;
  }

  reset() {
    this.readings = [];
  }
}

/** Price of the net weight, rounded to 2 dp (prices are tax-inclusive). */
export function linePriceForWeight(o: {
  pricePerKg: number;
  grossGrams: number;
  tareGrams: number;
}): number {
  const net = Math.max(0, o.grossGrams - o.tareGrams);
  return Math.round((o.pricePerKg * net) / 10) / 100;
}

/** Software scale for tests and demos. */
export class SimulatedScale implements ScaleAdapter {
  private grams = 0;
  private unstableLeft = 0;

  place(grams: number) {
    this.grams = grams;
  }
  /** Next n frames report unstable (US) after a weight change. */
  settling(n: number) {
    this.unstableLeft = n;
  }
  readFrame(): string {
    const stable = this.unstableLeft <= 0;
    if (!stable) this.unstableLeft -= 1;
    return `${stable ? "ST" : "US"},GS,${(this.grams / 1000).toFixed(3).padStart(8)}kg\r\n`;
  }
}

/** Cart label for a weighed line, e.g. "1.250 kg". */
export function formatNetWeight(grams: number): string {
  return `${(grams / 1000).toFixed(3)} kg`;
}
