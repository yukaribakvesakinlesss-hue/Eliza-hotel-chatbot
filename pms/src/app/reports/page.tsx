import { ReportsView } from '@/components/reports/ReportsView';
import { demoProperty, demoRooms } from '@/lib/demo/data';
import { DEMO_CHANNELS, demoFinance } from '@/lib/demo/reservations';
import { calculatePMSMetrics } from '@/lib/finance/metrics';
import { loadMetricsInput } from '@/lib/finance/load';
import { parsePeriod } from '@/lib/finance/period';
import { todayIn } from '@/lib/reservations/dates';
import { getPropertyContext } from '@/lib/supabase/context';
import { getServerClient } from '@/lib/supabase/server';
import { isHousekeepingRole } from '@/lib/rooms/rules';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function ReportsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const supabase = await getServerClient();

  if (!supabase) {
    const today = todayIn(demoProperty.timezone);
    const period = parsePeriod(sp.from, sp.to, today);
    const data = demoFinance(today);
    const metrics = calculatePMSMetrics({
      from: period.from,
      to: period.to,
      rooms: demoRooms(),
      outOfOrder: data.outOfOrder,
      reservations: data.reservations.filter((r) => r.check_in < period.to && r.check_out > period.from),
      transactions: data.transactions.filter((t) => t.service_date >= period.from && t.service_date < period.to),
      channels: DEMO_CHANNELS,
      taxRates: { vatRooms: demoProperty.vat_rate_rooms, lodging: demoProperty.lodging_tax_rate }
    });
    return <ReportsView demo property={demoProperty} role="owner" today={today} period={period} metrics={metrics} />;
  }

  const ctx = await getPropertyContext(supabase);
  if (isHousekeepingRole(ctx.role)) redirect('/housekeeping');
  const today = todayIn(ctx.property.timezone);
  const period = parsePeriod(sp.from, sp.to, today);
  if (ctx.role !== 'owner' && ctx.role !== 'manager') {
    return <ReportsView demo={false} property={ctx.property} role={ctx.role} today={today} period={period} metrics={null} />;
  }
  const metrics = calculatePMSMetrics(await loadMetricsInput(supabase, ctx.property, period.from, period.to));
  return <ReportsView demo={false} property={ctx.property} role={ctx.role} today={today} period={period} metrics={metrics} />;
}
