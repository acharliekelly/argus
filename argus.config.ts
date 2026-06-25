import { defineConfig } from './src/config.js';

export default defineConfig({
  baseUrl: 'http://localhost:8093',
  artifactDir: '.argus',
  compose: {
    file: 'docker-compose.yml',
    wordpressService: 'wordpress',
    wpCliService: 'wpcli',
    profiles: ['tools']
  },
  visualThreshold: 0.01,
  viewports: [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'mobile', width: 390, height: 844 }
  ],
  scenarios: [
    {
      name: 'home',
      path: '/',
      mask: ['#wpadminbar', '.argus-dynamic'],
      run: async (page) => {
        await page.locator('body').waitFor({ state: 'visible' });
      }
    }
  ]
});
