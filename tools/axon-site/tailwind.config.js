module.exports = {
  content: [__dirname + '/page.html', __dirname + '/privacy.html', __dirname + '/app.js'],
  theme: {
    extend: {
      colors: {
        navy: { 950: '#0B1423', 900: '#101C30', 800: '#17243A', 700: '#22324D', 600: '#2E4062' },
        silver: '#C3C9D2', gold: { DEFAULT: '#D5BD8A', soft: '#E6D5AE', deep: '#B89C62' },
        ink: '#F4F6F9', mist: '#AAB6C8'
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['Sora', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif']
      }
    }
  }
};
