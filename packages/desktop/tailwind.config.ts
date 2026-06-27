import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{vue,ts}"],
  theme: {
    extend: {
      borderRadius: {
        bmo: "12px",
        "bmo-lg": "16px",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "PingFang SC",
          "Noto Sans SC",
          "system-ui",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        lift: "0 18px 48px rgba(15, 92, 85, 0.15), 0 2px 8px rgba(15, 92, 85, 0.10)",
        soft: "0 1px 3px rgba(15, 92, 85, 0.12)",
      },
    },
  },
  plugins: [],
} satisfies Config;
