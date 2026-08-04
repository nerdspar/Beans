import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode } from 'react'
import { Route, Switch } from 'wouter'
import { DESTINATIONS } from './navigation/destinations.js'
import { DesktopShell } from './shells/desktop/DesktopShell.js'
import { MobileShell } from './shells/mobile/MobileShell.js'
import { useIsDesktop } from './shells/use-shell.js'
import { useWorkingSet } from './working-set/use-working-set.js'
import { useSession } from './auth/use-session.js'
import { AccountDetail } from './screens/AccountDetail.js'
import { Accounts } from './screens/Accounts.js'
import { Transactions } from './screens/Transactions.js'
import { CreateHousehold } from './screens/CreateHousehold.js'
import { SignIn } from './screens/SignIn.js'
import { NetWorth } from './screens/NetWorth.js'
import { Placeholder } from './screens/Placeholder.js'
import { TabSettings } from './screens/TabSettings.js'
import { TransitionPrototype } from './screens/TransitionPrototype.js'

/**
 * TanStack Query is the in-memory view over the client's working set.
 *
 * **It is not the persistent cache** — that is IndexedDB, and there is exactly one of it. Layering
 * a query persister on top would give two caches with independent lifetimes, which is where
 * staleness bugs live (ARCHITECTURE.md §7.2).
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The working set is local, so refetching on every window focus buys nothing and costs a
      // request per tab switch.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30 * 1000,
    },
  },
})

export function App(): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <Gate />
    </QueryClientProvider>
  )
}

/**
 * Decides whether the app is reachable at all.
 *
 * Sign-in and household creation render **outside the shell**: bottom tabs the user cannot use are
 * noise at best, and at worst suggest there is something behind them. Both are also full-height
 * centred layouts, which the shell's scroll container would fight.
 */
function Gate(): ReactNode {
  const session = useSession()
  const workingSet = useWorkingSet()

  // Nothing at all while the session is unknown. A flash of the sign-in screen for an already
  // signed-in user is worse than a blank moment, and this resolves in one request.
  if (session.isLoading) return null

  if (session.user === null) return <SignIn />
  if (workingSet.needsHousehold) return <CreateHousehold />

  return (
    <Shell>
      <Routes />
    </Shell>
  )
}

/**
 * Picks the shell once, at the breakpoint.
 *
 * Two distinct trees rather than one littered with breakpoint conditionals — that is how both
 * layouts end up mediocre. Everything below this point is shared.
 */
function Shell({ children }: { children: ReactNode }): ReactNode {
  const isDesktop = useIsDesktop()

  return isDesktop ? <DesktopShell>{children}</DesktopShell> : <MobileShell>{children}</MobileShell>
}

function Routes(): ReactNode {
  return (
    <Switch>
      <Route path="/" component={NetWorth} />
      <Route path="/accounts/:id" component={AccountDetail} />
      <Route path="/accounts" component={Accounts} />
      <Route path="/transactions" component={Transactions} />
      <Route path="/settings" component={TabSettings} />
      {/* Not in the destination registry: a workbench for judging the transition, not a screen. */}
      <Route path="/prototype/transition" component={TransitionPrototype} />

      {DESTINATIONS.filter(
        (destination) =>
          destination.key !== 'settings' &&
          destination.key !== 'net-worth' &&
          destination.key !== 'accounts' &&
          destination.key !== 'transactions',
      ).map((destination) => (
        <Route key={destination.key} path={destination.path}>
          <Placeholder destination={destination} />
        </Route>
      ))}

      <Route>
        <div className="p-6">
          <h1 className="text-lg font-semibold">Nothing here</h1>
          <p className="mt-1 text-sm text-slate-500">That page does not exist.</p>
        </div>
      </Route>
    </Switch>
  )
}
