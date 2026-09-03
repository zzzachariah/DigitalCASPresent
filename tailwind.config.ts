import type { Config } from "tailwindcss";

// System CJK stack — deliberately no web font for Chinese: the visitor pages
// load on exhibition Wi-Fi, and a CJK web font is several hundred KB.
const CJK = [
  "PingFang SC",
  "HarmonyOS Sans SC",
  "MiSans",
  "Hiragino Sans GB",
  "Microsoft YaHei",
  "Noto Sans CJK SC",
  "Noto Sans SC",
];

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      // Every color is a CSS variable (see globals.css) so light/dark swap
      // without a class toggle — the page follows the system setting.
      colors: {
        bg: "var(--bg)",
        surface: { DEFAULT: "var(--surface)", 2: "var(--surface-2)", 3: "var(--surface-3)" },
        line: { DEFAULT: "var(--line)", strong: "var(--line-strong)" },
        ink: { DEFAULT: "var(--ink)", 2: "var(--ink-2)", 3: "var(--ink-3)", 4: "var(--ink-4)" },
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          soft: "var(--accent-soft)",
          on: "var(--on-accent)",
        },
        success: { DEFAULT: "var(--success)", soft: "var(--success-soft)" },
        warning: { DEFAULT: "var(--warning)", soft: "var(--warning-soft)" },
        danger: { DEFAULT: "var(--danger)", soft: "var(--danger-soft)" },
      },
      fontFamily: {
        display: ["var(--font-display)", ...CJK, "sans-serif"],
        sans: ["var(--font-sans)", ...CJK, "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        DEFAULT: "8px",
        lg: "10px",
        xl: "12px",
        "2xl": "16px",
        "3xl": "20px",
      },
      boxShadow: {
        1: "var(--shadow-1)",
        2: "var(--shadow-2)",
        ring: "0 0 0 4px var(--accent-ring)",
      },
      transitionTimingFunction: {
        // Overrides Tailwind's `ease-out` so every transition shares one curve.
        out: "var(--ease)",
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        fade: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.45", transform: "scale(0.8)" },
        },
        "speaking-ring": {
          "0%, 100%": { boxShadow: "0 0 0 1px var(--accent-ring-strong), 0 0 0 6px var(--accent-ring)" },
          "50%": { boxShadow: "0 0 0 1px var(--accent-ring-strong), 0 0 0 12px transparent" },
        },
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
        indeterminate: {
          "0%": { left: "-45%", width: "45%" },
          "55%": { left: "60%", width: "55%" },
          "100%": { left: "100%", width: "45%" },
        },
        "dot-wave": {
          "0%, 60%, 100%": { transform: "translateY(0)", opacity: "0.35" },
          "30%": { transform: "translateY(-3px)", opacity: "1" },
        },
      },
      animation: {
        rise: "rise 0.55s var(--ease) both",
        fade: "fade 0.35s var(--ease) both",
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
        "speaking-ring": "speaking-ring 2.4s ease-in-out infinite",
        shimmer: "shimmer 1.8s linear infinite",
        indeterminate: "indeterminate 1.15s ease-in-out infinite",
        "dot-wave": "dot-wave 1.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
