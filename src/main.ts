import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Service worker is optional
  })
}

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
