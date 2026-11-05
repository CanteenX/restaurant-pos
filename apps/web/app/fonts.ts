// Self-hosted web fonts (#187). The Google next/font loader fetches from
// fonts.googleapis.com at build time, which fails offline and in cloud VMs,
// so every face is loaded from an npm package with next/font/local instead.
// Both fonts are SIL OFL 1.1. The built image ships only .next/ and public/,
// so the licence texts are committed (and served) from public/licenses/:
//   geist                                     -> public/licenses/geist-OFL.txt
//   @fontsource-variable/noto-sans-devanagari -> public/licenses/noto-sans-devanagari-OFL.txt
// They are listed in NOTICE; the test below keeps them in sync with the packages.
// lib/self-hosted-fonts.test.ts fails if the Google font loader comes back or a
// src path below stops resolving.
import localFont from "next/font/local";

export const geistSans = localFont({
  src: "../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

export const geistMono = localFont({
  src: "../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});

// Geist has no Devanagari glyphs; the browser falls through to this face
// per character, so Hindi text renders consistently on every device.
// Devanagari subset only (same as the previous Google config); variable
// weight axis covers the 400-700 range the UI uses.
export const devanagari = localFont({
  src: "../node_modules/@fontsource-variable/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-wght-normal.woff2",
  variable: "--font-devanagari",
  weight: "100 900",
  display: "swap",
});
