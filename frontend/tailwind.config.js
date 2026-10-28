/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: "#111A38", hover: "#202B50", tint: "#FFF1DC" },
        saffron: "#F28A00",
        ink: "#151D35",
        body: "#293247",
        muted: "#69758B",
        border: "#E1E5ED",
        subtle: "#F5F6FA",
        success: "#0B6B3A",
        warning: "#8A5A00",
        danger: "#A31D1D",
        ai: "#4B3FA3",
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        serif: ["Source Serif 4", "serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      boxShadow: { card: "0 1px 2px rgba(15,26,43,0.05)", dialog: "0 8px 24px rgba(15,26,43,0.12)" },
      borderRadius: { card: "8px" },
    },
  },
  plugins: [],
};
