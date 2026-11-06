module.exports = {
  content: [__dirname + '/page.html', __dirname + '/privacy.html', __dirname + '/app.js', __dirname + '/systems.js'],
  theme: {
    extend: {
      colors: {
        navy: { 950: '#0B1423', 900: '#101C30', 800: '#17243A', 700: '#22324D', 600: '#2E4062' },
        silver: '#C3C9D2', gold: { DEFAULT: '#F2C14E', soft: '#FFE08A', deep: '#D9A033', light: '#FFF1C2' },
        ink: '#F4F6F9', mist: '#AAB6C8'
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['Sora', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif']
      }
    }
  }
};
