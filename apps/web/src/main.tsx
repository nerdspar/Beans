import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { capturePendingInvite } from './auth/pending-invite.js'
import './styles/index.css'

/*
 * Before anything renders or routes.
 *
 * An invite link is `/join/<token>` and signing in reloads the page to `/`, so the token has to be
 * lifted out of the URL and stored before any of that can discard it.
 */
capturePendingInvite()

const container = document.getElementById('root')
if (container === null) {
  throw new Error('No #root element')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
