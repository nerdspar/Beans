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

/**
 * A component workbench, development only.
 *
 * **Dynamically imported inside a statically false branch**, which is what actually keeps it out of
 * a production build. A top-level import guarded by `import.meta.env.DEV` does not: the branch is
 * removed but the module stays in the bundle, fixtures and all — verified by grepping `dist`, after
 * a comment claiming otherwise turned out to be wrong.
 *
 * It exists because everything that renders a dropdown or a chart sits behind sign-in, which made
 * layout and gesture unverifiable — exactly the things typechecking has no opinion about.
 */
if (import.meta.env.DEV && window.location.pathname === '/preview') {
  void import('./screens/DevPreview.js').then(({ DevPreview }) => {
    createRoot(container).render(
      <StrictMode>
        <DevPreview />
      </StrictMode>,
    )
  })
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
