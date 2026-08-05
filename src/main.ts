import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { assetUrl } from './lib/utils/assets'

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(assetUrl('sw.js'), { type: 'module' }).catch(() => {
    // Service worker is optional
  })
}

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
