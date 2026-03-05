/**
 * bildr hub meets – Design tokens matching bildr.hub website (dark/corporate theme).
 *
 * Fonts: Bungee (display, UPPERCASE), Plus Jakarta Sans (body), JetBrains Mono (labels)
 * Palette: Earth tones – warm browns, amber accents, cream text
 */

export const colors = {
  // Core
  primary: "#d97706",           // amber-600 – accent-dark
  primaryDark: "#b45309",       // amber-700
  accent: "#fbbf24",            // amber-400 – bright accent
  accentLight: "#3d3530",       // dark amber surface

  // Backgrounds
  background: "#1c1917",        // warm near-black (stone-900)
  surface: "#2c2218",           // warm dark brown (card)
  surfaceLight: "#3d3530",      // warm dark border

  // Text
  text: "#fef3c7",              // cream (amber-100)
  textSecondary: "#d4b896",     // tan/light brown
  textMuted: "#a8763e",         // muted earth

  // Status
  success: "#16a34a",           // green-600
  error: "#dc2626",             // red-600
  warning: "#ca8a04",           // amber-600
  recording: "#dc2626",         // red-600
  processing: "#2563eb",        // blue-600
  info: "#2563eb",              // blue-600

  // Borders
  border: "#3d3530",            // warm dark border
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
};

export const shadows = {
  sm: "0 1px 3px rgba(0, 0, 0, 0.3)",
  md: "0 4px 12px rgba(0, 0, 0, 0.4)",
  accentSm: "0 1px 2px rgba(217, 119, 6, 0.2)",
  accentMd: "0 4px 12px rgba(217, 119, 6, 0.3)",
};
