import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { initAuth } from '@/stores/auth'
import './index.css'

initAuth()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
