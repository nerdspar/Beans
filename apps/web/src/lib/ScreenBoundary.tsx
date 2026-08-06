import { SHELL_COPY } from '@beans/shared'
import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Keeps one broken screen from taking the whole app with it.
 *
 * React unmounts the entire tree when a render throws and nothing catches it. Placed around the
 * routed screen — inside the shell, not outside — a failure costs the reader that screen and leaves
 * navigation working, so they can go somewhere else and come back.
 *
 * **What it is really for is saying what happened.** Beans is self-hosted: the person looking at
 * the failure is the person who can fix it, and a black page tells them nothing they can act on or
 * report. The message and stack are shown rather than swallowed for the same reason the sync
 * errors are.
 *
 * A class, because error boundaries have no hook equivalent — `componentDidCatch` is the only API
 * React offers for this.
 */

type Props = {
  children: ReactNode
  /** Changes when the route does, so leaving a broken screen clears the error. */
  resetKey: string
}

type State = { error: Error | null }

export class ScreenBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console as well as on screen: the component stack says which screen failed, and
    // that is the half worth pasting into a bug report.
    console.error('Screen failed to render', error, info.componentStack)
  }

  override componentDidUpdate(previous: Props): void {
    /*
     * Navigating away clears it.
     *
     * Without this the boundary stays in its failed state for the rest of the session — every other
     * screen would render blank too, which is the failure it exists to prevent, arrived at by a
     * different route.
     */
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children

    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="text-lg font-semibold">{SHELL_COPY.screenFailed}</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {SHELL_COPY.screenFailedDetail}
        </p>

        <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-100 p-3 text-left font-mono text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-300">
          {error.message}
        </pre>
      </div>
    )
  }
}
