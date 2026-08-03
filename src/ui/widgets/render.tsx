// Catalogue id → component. The JSX half of `catalog.ts`.
//
// Split from the catalogue for the reason `EXPLAIN` holds no JSX: the data half has to be
// importable by a node-environment test. Keeping the map typed as `Record<WidgetId, …>` is what
// makes the pairing total — adding a catalogue entry without a renderer is a type error here, not
// a blank tile at runtime.
import { EmergencyFundWidget, NetWorthWidget, type WidgetChrome } from './AccountsWidgets'
import { DrillTrendWidget, MonthlyTrendWidget, YearlyTrendWidget } from './TrendsWidgets'
import { IncomeSavingsWidget, MomentumWidget, SeasonalityCard } from './InsightWidgets'
import { TripCategoriesWidget, TripDailyWidget, TripTimelineWidget } from './TripsWidgets'
import { RulesOfThumb } from './PlanWidgets'
import type { WidgetId, WidgetParams } from './catalog'

type Render = (params: WidgetParams, chrome: WidgetChrome) => React.ReactNode

export const WIDGET_RENDER: Record<WidgetId, Render> = {
  'trends.yearly': (params, chrome) => <YearlyTrendWidget params={params} {...chrome} />,
  'trends.monthly': (params, chrome) => <MonthlyTrendWidget params={params} {...chrome} />,
  'trends.drill': (params, chrome) => <DrillTrendWidget params={params} {...chrome} />,
  'trends.momentum': (params, chrome) => <MomentumWidget params={params} {...chrome} />,
  'trends.income': (params, chrome) => <IncomeSavingsWidget params={params} {...chrome} />,
  'trends.seasonality': (params, chrome) => <SeasonalityCard params={params} {...chrome} />,
  'accounts.net-worth': (params, chrome) => <NetWorthWidget params={params} {...chrome} />,
  'accounts.emergency': (_params, chrome) => <EmergencyFundWidget {...chrome} />,
  'trips.timeline': (_params, chrome) => <TripTimelineWidget {...chrome} />,
  'trips.daily': (params, chrome) => <TripDailyWidget params={params} {...chrome} />,
  'trips.categories': (params, chrome) => <TripCategoriesWidget params={params} {...chrome} />,
  'plan.rules': (_params, chrome) => <RulesOfThumb {...chrome} />,
}
