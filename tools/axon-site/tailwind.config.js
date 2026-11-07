module.exports = {
  content: [__dirname + '/page.html', __dirname + '/privacy.html', __dirname + '/app.js', __dirname + '/systems.js', __dirname + '/personal.js'],
  theme: {
    extend: {
      colors: {
        navy: { 950: 'rgb(var(--c-navy-950) / <alpha-value>)', 900: 'rgb(var(--c-navy-900) / <alpha-value>)', 800: 'rgb(var(--c-navy-800) / <alpha-value>)', 700: 'rgb(var(--c-navy-700) / <alpha-value>)', 600: 'rgb(var(--c-navy-600) / <alpha-value>)' },
        silver: 'rgb(var(--c-silver) / <alpha-value>)',
        gold: { DEFAULT: 'rgb(var(--c-gold) / <alpha-value>)', soft: 'rgb(var(--c-gold-soft) / <alpha-value>)', deep: 'rgb(var(--c-gold-deep) / <alpha-value>)', light: 'rgb(var(--c-gold-light) / <alpha-value>)' },
        ink: 'rgb(var(--c-ink) / <alpha-value>)', mist: 'rgb(var(--c-mist) / <alpha-value>)',
        white: 'rgb(var(--c-white) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['Sora', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif']
      }
    }
  }
};
