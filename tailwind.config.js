import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Segoe UI", "Microsoft YaHei", "sans-serif"],
        mono: ["JetBrains Mono", "Cascadia Code", "Consolas", "monospace"],
      },
    },
  },
  plugins: [typography],
};
