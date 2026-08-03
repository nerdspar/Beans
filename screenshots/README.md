# Empower reference screenshots

Functional reference for Beans, captured from the Empower Personal Dashboard iOS app. These show **what the app should do**, not how it should look. Do not copy Empower's visual design or branding.

All amounts are real and partially redacted. Treat them as sample data only.

## Net worth (screens 01–06)

These six are the same screen at different scroll positions. **This is the single most important interaction in the app.** It is one continuous scrolling list, not tabs and not tap-to-filter. As the user scrolls into each category section, that section's header pins below the chart and highlights in its own color, and the chart, total, and delta above all re-scope to that category.

| File                                     | What it shows                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `01-net-worth-top.jpeg`                  | Top of scroll. Household total, 90-day range control, delta, chart, assets/liabilities proportional bars, start of the Cash section |
| `02-net-worth-cash-section.jpeg`         | Scrolled into Cash. Header pinned and highlighted, chart re-scoped to cash only, app bar collapsed to show household net worth      |
| `03-net-worth-investment-section.jpeg`   | Scrolled into Investment. Note per-account timestamps rather than dates on same-day synced accounts                                 |
| `04-net-worth-credit-card-section.jpeg`  | Scrolled into Credit card. Liability chart in red. Colored status dots on rows with stale or failed syncs                           |
| `05-net-worth-mortgage-section.jpeg`     | Scrolled into Mortgage, with the Other assets header coming up beneath it                                                           |
| `06-net-worth-other-assets-section.jpeg` | Scrolled into Other assets. Manual entry accounts and Zestimate-linked home values                                                  |

## Everything else

| File                       | What it shows                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `07-date-range-picker.png` | Range options: This month, Last month, 90 days, 1 year, YTD, Last year, Custom                                                                |
| `08-navigation-menu.png`   | Full navigation. Note several destinations are Empower upsells and are not in scope                                                           |
| `09-transactions.png`      | Search, range, All/Deposits/Expenses tabs, pinned Pending section, date grouping, persistent range total, Add transaction                     |
| `10-cash-flow.png`         | Cash flow / Income / Expenses tabs, paired monthly bars with net line and average marker, month detail list below                             |
| `11-account-details.png`   | Editable account name, current and available balance, per-account search and range, balance chart, transactions grouped by date with category |
| `12-portfolio.jpeg`        | Stacked area by account, sortable table of 1-day percent and dollar change, percent of total, balance. **Phase 1 target**                     |
| `13-holdings.png`          | Position-level holdings with share counts and prices, plus benchmark comparison. **Phase 2+**                                                 |
| `14-allocation.png`        | Asset class treemap. Note Unclassified at 27.79%, which is Empower failing to classify a large share. **Phase 2+**                            |
| `15-budgeting.png`         | Monthly spend against target, this month versus last. **Phase 4**                                                                             |

## Notes on behavior not visible in a still

- Tapping an account row with a red status dot opens a prompt offering to reconnect the connection or open the account anyway. A healthy row goes straight to account details.
- The download icon in the header exports the current view.
- The header title collapses from the screen name to the household net worth once scrolled.
