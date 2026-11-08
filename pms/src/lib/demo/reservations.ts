/** Demo reservations for the tape chart (demo mode only; never written anywhere). Dates are relative to "today". */
import type { ReservationStatus, ReservationWithGuest } from '@/types/database';
import { addDays } from '@/lib/reservations/dates';
import { demoProperty, demoRooms } from './data';

const PLAN: [room: string, startOffset: number, nights: number, status: ReservationStatus, guest: string][] = [
  ['101', -2, 4, 'CHECKED_IN', 'Ayşe Yılmaz'],
  ['101', 2, 3, 'CONFIRMED', 'Lukas Weber'],
  ['102', 0, 2, 'CONFIRMED', 'Mehmet Kaya'],
  ['103', -1, 3, 'CHECKED_IN', 'Sophie Martin'],
  ['104', 3, 5, 'PENDING', 'Elena Rossi'],
  ['105', -3, 5, 'CHECKED_IN', 'John Smith'],
  ['106', 1, 6, 'CONFIRMED', 'Al-Farsi Ailesi'],
  ['201', 0, 1, 'CONFIRMED', 'Zeynep Demir'],
  ['202', -1, 4, 'CHECKED_IN', 'Anna Kowalska'],
  ['203', 4, 2, 'CONFIRMED', 'Can Öztürk'],
  ['205', 1, 3, 'PENDING', 'Maria Garcia'],
  ['206', -2, 7, 'CHECKED_IN', 'Kenji Tanaka'],
  ['301', 5, 4, 'CONFIRMED', 'Olivia Brown'],
  ['302', 0, 3, 'CONFIRMED', 'Ahmet Şahin'],
  ['305', 2, 2, 'CONFIRMED', 'Fatma Aydın'],
  ['401', -1, 2, 'CHECKED_IN', 'Pierre Dubois'],
  ['402', 6, 3, 'PENDING', 'Hans Müller'],
  ['404', 0, 4, 'CONFIRMED', 'Selin Arslan'],
  ['406', 3, 4, 'CONFIRMED', 'Yuki Sato']
];

export function demoReservations(today: string): ReservationWithGuest[] {
  const rooms = new Map(demoRooms().map((r) => [r.number, r]));
  return PLAN.flatMap(([number, offset, nights, status, guest], i) => {
    const room = rooms.get(number);
    if (!room) return [];
    const checkIn = addDays(today, offset);
    const checkOut = addDays(checkIn, nights);
    return [{
      id: `00000000-0000-4000-c000-${String(i + 1).padStart(12, '0')}`,
      organization_id: demoProperty.organization_id,
      property_id: demoProperty.id,
      room_id: room.id,
      code: `R${String(i + 1).padStart(6, '0')}`,
      status,
      check_in: checkIn,
      check_out: checkOut,
      stay: `[${checkIn},${checkOut})`,
      adults: 2,
      children: 0,
      source: 'direct' as const,
      notes: null,
      version: 1,
      created_by: null,
      updated_by: null,
      checked_in_at: null,
      checked_out_at: null,
      cancelled_at: null,
      cancel_reason: null,
      created_at: `${today}T08:00:00.000Z`,
      updated_at: `${today}T08:00:00.000Z`,
      guest_name: guest
    }];
  });
}
