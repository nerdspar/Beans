/**
 * Copy for the retirement planner.
 *
 * **This is the screen where the no-jokes rule matters most.** A retirement projection is mostly
 * numbers moving the wrong way: a year the money runs out, a gap in today's dollars, a shortfall
 * that grows. Every one of those is stated flatly, with the assumption that produced it, and
 * nothing here reassures, encourages, or jokes. Somebody reading "your plan runs out at 84" does
 * not need a quip and does not need comfort — they need the number and what it rests on. The empty
 * and loading states are the only places with any voice at all, and even they stay dry.
 *
 * **Nothing here is phrased as a recommendation.** Not "you should save more", not "consider
 * retiring later". Beans describes mechanisms and shows the user's numbers against them. Friends
 * use this app, and a confidently wrong instruction about somebody's retirement is worse than
 * saying nothing.
 */

export const RETIREMENT_COPY = {
  title: 'Retirement',
  blurb: 'Your own numbers against the arithmetic, with every assumption shown.',

  /** Shown above every figure on the screen, not buried in a settings panel. */
  realDollarsNote:
    'All figures are in today’s dollars, after inflation. A projection in future dollars would look larger and mean the same thing.',

  loading: 'Working through the years',
  /** Before anyone has started. Dry, and it says what the thing is for. */
  empty: {
    title: 'No plan yet',
    body: 'Beans already knows what you own, how it’s taxed, and what you spend. The setup asks for the handful of things it can’t know — when you plan to stop working, and what Social Security says you’ll get.',
    action: 'Set up a plan',
  },

  error: {
    title: 'The projection didn’t run',
    body: 'Nothing was saved or changed. Trying again is safe.',
    action: 'Try again',
  },

  /** The headline. A range across scenarios, never a single number. */
  headline: {
    /** Both ends, because a point estimate implies a precision that does not exist. */
    range: (low: string, high: string): string => `${low} to ${high}`,
    label: 'Projected at the end of the plan',
    /**
     * The three scenarios produced three different answers, which is the point of the band. Stated
     * as a fact about the model, not as a hedge.
     */
    bandNote: 'The spread is the three return assumptions, run side by side.',
  },

  funded: {
    label: 'Funded',
    /** A plain percentage. No colour commentary either way. */
    value: (percent: string): string => `${percent} of planned spending`,
    fullyFunded: 'Covers the plan',
    /** Factual. Not "uh oh", not "you’re short" — the number and the year. */
    gap: (amount: string): string => `Short by ${amount} in today’s dollars`,
    depletes: (year: number): string => `Runs out in ${year}`,
    lasts: 'Lasts the whole plan',
    /** When there is nothing to be funded yet. Not the same as fully funded. */
    noHorizon: 'No retirement years in the plan yet',
  },

  /**
   * What the projection knowingly leaves out.
   *
   * Shown next to the figures, never in a footnote nobody opens. A projection missing required
   * distributions is optimistic by an amount the reader cannot see, and not saying so would be the
   * quiet kind of wrong this app exists to avoid.
   */
  notModelled: {
    heading: 'Not included yet',
    required_minimum_distributions:
      'Required minimum distributions. The age and the divisors change by law and have to come from an IRS source, not from this app’s memory. Without them the projection pays less tax than it would.',
    social_security_taxation:
      'Tax on Social Security. The thresholds are statutory and have to come from the same source. Tax here is applied to pre-tax withdrawals only, so the bill is understated.',
  },

  assumptions: {
    heading: 'Assumptions',
    /** Each one badged as observed or entered, so the reader knows which is which. */
    fromData: 'From your data',
    entered: 'You entered this',
    estimate: 'Estimate',

    effectiveRate: 'Tax rate in retirement',
    effectiveRateNote:
      'An assumption, not a calculation. Beans doesn’t know future brackets, future law, or which state you’ll live in.',

    returns: 'Real return',
    returnsNote: 'After inflation. Separate rates before and after you stop working.',

    withdrawalOrder: 'Drawn down in this order',
    withdrawalOrderNote:
      'Taxable first, then after-tax, then pre-tax, then Roth. An HSA and a 529 are never drawn on here.',

    heldBack: (amount: string): string =>
      `${amount} in an HSA or 529 is not counted as money to retire on`,
    heldBackNote:
      'An HSA is for medical costs and a 529 carries a penalty for anything else, so the projection leaves both alone.',
  },

  spending: {
    heading: 'What retirement costs',
    blurb: 'Built from a year of your own spending, one category at a time.',
    /** Replaces "assume 80% of current spending", which is folklore. */
    baselineNote:
      'This is your real spending, not a rule of thumb. Each category continues, stops, or changes by an amount you set.',

    continues: 'Continues',
    stops: 'Stops',
    adjusted: 'Changes',
    adjustedBy: (percent: string): string => `${percent} of today`,

    /** A category nobody answered. Counted, and flagged — not quietly assumed. */
    unreviewed: 'Not reviewed',
    unreviewedNote: (count: number): string =>
      count === 1
        ? '1 category hasn’t been reviewed. It’s counted as continuing, which is the more expensive assumption.'
        : `${count} categories haven’t been reviewed. They’re counted as continuing, which is the more expensive assumption.`,

    /** Field labels for the review, so the screen never builds one by editing another string. */
    adjustedLabel: 'Percent of today',
    untilLabel: 'Last year paid',
    uncategorizedNote:
      'Uncategorized spending is counted as continuing. Categorize it to say otherwise.',

    /** How a mortgage leaves the baseline — on its payoff date, not at retirement. */
    endsAfter: (year: number): string => `Until ${year}`,
    payoffPrefill: (year: number): string => `A loan is scheduled to be paid off in ${year}`,

    partialYear: (months: number): string =>
      `Based on ${months} months of spending, scaled to a year. Costs that arrive once a year won’t be spread evenly, so treat this as rough.`,

    /** Pre-65 healthcare gets its own line rather than hiding in a category. */
    healthcareBridge: 'Healthcare before 65',
    healthcareBridgeNote:
      'The largest unknown for anyone stopping work before Medicare starts. Averaged into a category it disappears, so it’s asked for separately.',
  },

  /** The setup wizard. Ordered from what Beans knows to what only you know. */
  setup: {
    title: 'Set up your plan',
    /**
     * Said once, at the top, so the order makes sense — and it names what is *not* here.
     *
     * The people in the plan and their Social Security figures live on the dashboard, beside the
     * numbers they move. An earlier draft of this line promised "six steps" and then showed three,
     * which is the kind of small lie that makes a reader wonder what else is missing.
     */
    blurb:
      'Three things Beans can make a start on: how your accounts are taxed, what you’ll spend, and what returns to assume. Who’s retiring and when is on the Retirement screen.',

    steps: {
      who: 'Who and when',
      accounts: 'How your accounts are taxed',
      spending: 'What you’ll spend',
      socialSecurity: 'Social Security',
      scenarios: 'Return assumptions',
      review: 'Review',
    },

    who: {
      blurb: 'Everyone whose retirement this plan covers, including anyone without a Beans login.',
      name: 'Name',
      birthYear: 'Birth year',
      retirementDate: 'Planning to stop working',
      lifeExpectancy: 'Plan through age',
      lifeExpectancyNote:
        'This sets how long the projection runs. There’s no right answer, and Beans won’t pick one for you — the figure changes the result more than almost anything else.',
      add: 'Add someone',
      remove: 'Remove',
    },

    accounts: {
      blurb:
        'Beans guessed these from the account type. Correct anything that’s wrong, and split an account if it holds more than one kind of money.',
      split: 'Split into buckets',
      splitNote:
        'A 401(k) often holds pre-tax, Roth and after-tax money at once, and the provider reports one balance. Enter what yours shows and the date it showed it.',
      asOf: 'As your provider showed it on',
      /** Why a dated breakdown rather than a percentage. */
      anchorNote:
        'Stored as a dated reading, not a percentage. A frozen balance beside one you’re still contributing to changes ratio every year on its own.',
      contributions: 'Going in each year',
      contributionsNote: 'Where new money lands. This is what moves the split over time.',

      planFeatures: 'What your plan allows',
      planFeaturesNote:
        'None of this is in any API — it’s in your plan documents. Beans won’t guess, and leaves a question unanswered rather than assuming.',
      allowsAfterTax: 'After-tax contributions beyond the normal limit',
      allowsInPlanRoth: 'Converting those to Roth inside the plan',
      allowsInService: 'Withdrawing while still employed',
      acceptsRollIns: 'Accepting a rollover in from an IRA',
      employerMatch: 'Match formula, in your own words',
      yes: 'Yes',
      no: 'No',
      unknown: 'Don’t know',
    },

    socialSecurity: {
      blurb:
        'Read these off your Social Security statement. Beans can’t work them out — the formula needs your full wage history, which it doesn’t have.',
      claimAge: 'Claiming at age',
      benefit: 'Yearly benefit',
      /** The link is required: every figure that depends on law points at its source. */
      sourceLabel: 'Get your statement at ssa.gov',
      sourceUrl: 'https://www.ssa.gov/myaccount/',
      missing: 'Not entered, so the projection counts nothing for it',
    },

    scenarios: {
      blurb:
        'Three sets of return assumptions, run together. Edit any of them — these are starting points, not forecasts.',
      preRetirement: 'Before retiring',
      postRetirement: 'After retiring',
      /** Why post is lower by default. */
      deRiskNote: 'Lower after retiring, because most people shift to safer holdings on approach.',
      makeDefault: 'Use for the headline',
      isDefault: 'Headline',
      realNote: 'Real returns, after inflation. A nominal 8% and a real 5% can describe the same portfolio.',
    },

    review: {
      blurb: 'Everything the projection will use. Change anything before you run it.',
      run: 'Run the projection',
    },

    /** What is still needed. Listed plainly, all of it, not one at a time. */
    missing: {
      heading: 'Still needed',
      members: 'Someone to retire — add at least one person',
      retirement_date: 'A date someone plans to stop working',
      life_expectancy: 'An age to plan through',
      spending_baseline: 'Some spending history to build a baseline from',
      balances: 'An account with a balance to draw on',
    },
  },

  /** The after-tax equivalent, shown beside net worth and never instead of it. */
  afterTax: {
    label: 'After tax',
    note: (rate: string): string =>
      `What’s left after an assumed ${rate} on pre-tax money. Shown beside net worth, not instead of it — net worth is a fact, this is a fact plus an assumption.`,
    deferredTax: (amount: string): string => `${amount} of this is owed, not owned`,
    /**
     * The honest omission. Beans has no cost basis, so a haircut here would be a guess dressed as
     * arithmetic.
     */
    ignoresGains:
      'This ignores gains Beans can’t see. Taxable and after-tax balances are counted at face value because no provider reports what they cost you.',
  },

  /** Table fallback for the band chart. Every chart here needs one. */
  table: {
    caption: 'Projected balance by year, for each set of return assumptions',
    /**
     * Replaces the shared sampled-rows sentence, which mentions a slider and talks about days.
     * This chart has neither: it plots calendar years and is not scrubbable, so pointing a
     * screen-reader user at a slider would send them looking for a control that is not there.
     */
    sampledNote: (shown: number, total: number): string =>
      `${shown} of ${total} years, evenly spaced.`,
    year: 'Year',
    total: 'Total',
    spending: 'Spending',
    withdrawals: 'Withdrawn',
    shortfall: 'Short',
  },
} as const
