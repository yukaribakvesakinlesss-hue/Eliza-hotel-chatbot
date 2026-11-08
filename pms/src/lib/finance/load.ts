/**
 * Loads the raw rows calculatePMSMetrics needs for one property and period, straight from the
 * database (RLS applies: the user must be allowed to read folio data). Paginates past the API row cap.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Property } from '@/types/database';
import type { MetricsInput } from './metrics';

const PAGE = 1000;

async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await page(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

export async function loadMetricsInput(
  supabase: SupabaseClient<Database>,
  property: Pick<Property, 'id' | 'organization_id' | 'vat_rate_rooms' | 'lodging_tax_rate'>,
  from: string,
  to: string
): Promise<MetricsInput> {
  const [rooms, outOfOrder, reservations, transactions, channels] = await Promise.all([
    fetchAll((a, b) => supabase.from('rooms').select('id').eq('property_id', property.id).order('id').range(a, b)),
    fetchAll((a, b) =>
      supabase.from('room_out_of_order_periods').select('room_id, start_date, end_date').eq('property_id', property.id)
        .lt('start_date', to).or(`end_date.is.null,end_date.gt.${from}`).order('id').range(a, b)),
    fetchAll((a, b) =>
      supabase.from('reservations').select('id, status, check_in, check_out, nightly_rate, channel_code, commission_rate, is_complimentary')
        .eq('property_id', property.id).lt('check_in', to).gt('check_out', from).order('id').range(a, b)),
    fetchAll((a, b) =>
      supabase.from('folio_transactions').select('id, reservation_id, txn_type, account_code, amount, service_date, tax_code, parent_id')
        .eq('property_id', property.id).gte('service_date', from).lt('service_date', to).order('id').range(a, b)),
    fetchAll((a, b) => supabase.from('distribution_channels').select('code, name').eq('organization_id', property.organization_id).order('code').range(a, b))
  ]);
  return {
    from,
    to,
    rooms,
    outOfOrder,
    reservations,
    transactions,
    channels,
    taxRates: { vatRooms: Number(property.vat_rate_rooms), lodging: Number(property.lodging_tax_rate) }
  };
}
