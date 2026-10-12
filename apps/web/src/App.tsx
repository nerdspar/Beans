import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode } from 'react'
import { Route, Switch, useLocation } from 'wouter'
import { DesktopShell } from './shells/desktop/DesktopShell.js'
import { MobileShell } from './shells/mobile/MobileShell.js'
import { useIsDesktop } from './shells/use-shell.js'
import { useRouteFocus } from './lib/main-region.js'
import { useWorkingSet } from './working-set/use-working-set.js'
import { readPendingInvite } from './auth/pending-invite.js'
import { useSession } from './auth/use-session.js'
import { AccountDetail } from './screens/AccountDetail.js'
import { HoldingDetail } from './screens/HoldingDetail.js'
import { TransactionDetail } from './screens/TransactionDetail.js'
import { CATEGORY_COPY, HOUSEHOLD_COPY, IMPORT_COPY, SHELL_COPY } from '@beans/shared'
import { CategoriesPanel } from './categories/CategoryTree.js'
import { RulesPanel } from './categories/RulesPanel.js'
import { Household } from './screens/Household.js'
import { Import } from './screens/Import.js'
import { ManagementPage } from './navigation/ManagementPage.js'
import { ScreenBoundary } from './lib/ScreenBoundary.js'
import { Accounts } from './screens/Accounts.js'
import { Portfolio } from './screens/Portfolio.js'
import { CashFlow } from './screens/CashFlow.js'
import { Subscriptions } from './screens/Subscriptions.js'
import { Transactions } from './screens/Transactions.js'
import { CreateHousehold } from './screens/CreateHousehold.js'
import { JoinHousehold } from './screens/JoinHousehold.js'
import { SignIn } from './screens/SignIn.js'
import { NetWorth } from './screens/NetWorth.js'
import { Retirement } from './screens/Retirement.js'
import { RetirementSetup } from './screens/RetirementSetup.js'
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
  const [location] = useLocation()

  // Nothing at all while the session is unknown. A flash of the sign-in screen for an already
  // signed-in user is worse than a blank moment, and this resolves in one request.
  if (session.isLoading) return null

  if (session.user === null) return <SignIn />

  /*
   * Before the household gate, never after.
   *
   * A household is created automatically for anyone without one, and v1 allows a user exactly one.
   * Letting that run first would hand an invited person their own empty household and leave them
   * unable to accept the invite they arrived holding.
   */
  if (readPendingInvite() !== null) return <JoinHousehold />

  if (workingSet.needsHousehold) return <CreateHousehold />

  return (
    <Shell>
      {/*
        Inside the shell, deliberately.
        
        A screen that throws should cost the reader that screen, not the navigation they need to
        leave it — an unguarded throw unmounts the whole tree, which is a black page with no tabs
        and no way back.
      */}
      <ScreenBoundary resetKey={location}>
        <Routes />
      </ScreenBoundary>
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

  /*
   * Here rather than in either shell, so the behaviour cannot differ between them — and so it
   * survives the breakpoint swap, which unmounts one whole tree and mounts the other.
   */
  useRouteFocus()

  return isDesktop ? <DesktopShell>{children}</DesktopShell> : <MobileShell>{children}</MobileShell>
}

function Routes(): ReactNode {
  return (
    <Switch>
      <Route path="/" component={NetWorth} />
      <Route path="/accounts/:id" component={AccountDetail} />
      <Route path="/holdings/:key" component={HoldingDetail} />
      <Route path="/transactions/:id" component={TransactionDetail} />
      <Route path="/accounts" component={Accounts} />
      <Route path="/transactions" component={Transactions} />
      <Route path="/cash-flow" component={CashFlow} />
      <Route path="/portfolio" component={Portfolio} />
      <Route path="/subscriptions" component={Subscriptions} />
      <Route path="/retirement/setup" component={RetirementSetup} />
      <Route path="/retirement" component={Retirement} />
      <Route path="/settings" component={TabSettings} />

      {/*
        Destinations in their own right, not sections of settings. See destinations.ts for why.
        
        Rendered inline with their page chrome rather than as four near-identical screen files —
        each is one existing panel plus a title.
      */}
      <Route path="/categories">
        <ManagementPage title={CATEGORY_COPY.categoriesHeading}>
          <CategoriesPanel />
        </ManagementPage>
      </Route>
      <Route path="/rules">
        <ManagementPage title={CATEGORY_COPY.rulesHeading}>
          <RulesPanel />
        </ManagementPage>
      </Route>
      <Route path="/import">
        <ManagementPage title={IMPORT_COPY.title}>
          <Import />
        </ManagementPage>
      </Route>
      <Route path="/household">
        <ManagementPage title={HOUSEHOLD_COPY.title}>
          <Household />
        </ManagementPage>
      </Route>
      {/*
        A workbench for judging the transition, not a screen — so it is not in the destination
        registry, and now not in production either.

        It was routed unconditionally, which shipped it: reachable by anyone who typed the path, and
        carried in the main bundle because the import at the top of this file is static. `DEV` is
        the same guard `main.tsx` puts on the component preview, and it lets Rollup drop both the
        route and the module from the build.
      */}
      {import.meta.env.DEV && (
        <Route path="/prototype/transition" component={TransitionPrototype} />
      )}

      {/*
        No placeholder fallback: every destination in the registry has a real route now. It existed
        while screens were still being built, and kept a tab from leading nowhere.
      */}

      <Route>
        <div className="p-6">
          <h1 className="text-lg font-semibold">{SHELL_COPY.notFound}</h1>
          <p className="mt-1 text-sm text-slate-500">{SHELL_COPY.notFoundDetail}</p>
        </div>
      </Route>
    </Switch>
  )
}
