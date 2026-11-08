import type { HousekeepingStatus, MaintenanceStatus, OccupancyStatus, StatusDimension } from '@/types/database';
import type { RuleError } from '@/lib/rooms/rules';

export type Lang = 'tr' | 'en';

type UiKey =
  | 'rooms' | 'demo' | 'live' | 'connecting' | 'offline' | 'ready' | 'occupied' | 'dirty' | 'ooo' | 'all' | 'floor'
  | 'search' | 'noteTitle' | 'notePlaceholder' | 'save' | 'cancel' | 'signOut' | 'updated' | 'empty' | 'saving' | 'role';

type Dict = {
  dimension: Record<StatusDimension, string>;
  occupancy: Record<OccupancyStatus, string>;
  housekeeping: Record<HousekeepingStatus, string>;
  maintenance: Record<MaintenanceStatus, string>;
  errors: Record<RuleError | 'NOT_FOUND' | 'UNKNOWN', string>;
  ui: Record<UiKey, string>;
};

export const LABELS: Record<Lang, Dict> = {
  tr: {
    dimension: { occupancy: 'Doluluk', housekeeping: 'Temizlik', maintenance: 'Teknik' },
    occupancy: { VACANT: 'Boş', RESERVED: 'Rezerve', OCCUPIED: 'Dolu' },
    housekeeping: { CLEAN: 'Temiz', DIRTY: 'Kirli', IN_PROGRESS: 'Temizleniyor', INSPECTION_REQUIRED: 'Kontrol bekliyor' },
    maintenance: { OPERATIONAL: 'Çalışır', OUT_OF_ORDER: 'Arızalı' },
    errors: {
      FORBIDDEN: 'Bu durumu değiştirme yetkiniz yok.',
      RULE_OUT_OF_ORDER: 'Arızalı odaya misafir yerleştirilemez.',
      RULE_OCCUPIED: 'Dolu oda arızalı olarak işaretlenemez. Önce misafiri taşıyın.',
      NOT_FOUND: 'Oda bulunamadı.',
      UNKNOWN: 'Değişiklik kaydedilemedi. Tekrar deneyin.'
    },
    ui: {
      rooms: 'Oda durumu',
      demo: 'Demo modu · örnek veriler, değişiklikler veritabanına yazılmaz',
      live: 'Canlı',
      connecting: 'Bağlanıyor',
      offline: 'Bağlantı yok',
      ready: 'Satışa hazır',
      occupied: 'Dolu',
      dirty: 'Temizlik bekliyor',
      ooo: 'Arızalı',
      all: 'Tümü',
      floor: 'Kat',
      search: 'Oda ara',
      noteTitle: 'Arıza notu',
      notePlaceholder: 'Örn. klima arızası',
      save: 'Kaydet',
      cancel: 'Vazgeç',
      signOut: 'Çıkış',
      updated: 'Güncellendi',
      empty: 'Filtreye uyan oda yok.',
      saving: 'Kaydediliyor',
      role: 'Rol'
    }
  },
  en: {
    dimension: { occupancy: 'Occupancy', housekeeping: 'Housekeeping', maintenance: 'Maintenance' },
    occupancy: { VACANT: 'Vacant', RESERVED: 'Reserved', OCCUPIED: 'Occupied' },
    housekeeping: { CLEAN: 'Clean', DIRTY: 'Dirty', IN_PROGRESS: 'In progress', INSPECTION_REQUIRED: 'Inspection required' },
    maintenance: { OPERATIONAL: 'Operational', OUT_OF_ORDER: 'Out of order' },
    errors: {
      FORBIDDEN: 'You are not allowed to change this status.',
      RULE_OUT_OF_ORDER: 'A guest cannot be checked into an out-of-order room.',
      RULE_OCCUPIED: 'An occupied room cannot be set out of order. Move the guest first.',
      NOT_FOUND: 'Room not found.',
      UNKNOWN: 'The change could not be saved. Please try again.'
    },
    ui: {
      rooms: 'Room status',
      demo: 'Demo mode · sample data, changes are not written to a database',
      live: 'Live',
      connecting: 'Connecting',
      offline: 'Offline',
      ready: 'Ready to sell',
      occupied: 'Occupied',
      dirty: 'Needs cleaning',
      ooo: 'Out of order',
      all: 'All',
      floor: 'Floor',
      search: 'Search room',
      noteTitle: 'Out-of-order note',
      notePlaceholder: 'e.g. air conditioning repair',
      save: 'Save',
      cancel: 'Cancel',
      signOut: 'Sign out',
      updated: 'Updated',
      empty: 'No rooms match the filter.',
      saving: 'Saving',
      role: 'Role'
    }
  }
};

export const ROLE_LABELS: Record<Lang, Record<string, string>> = {
  tr: { owner: 'Sahip', manager: 'Müdür', front_desk: 'Ön büro', housekeeping: 'Kat hizmetleri' },
  en: { owner: 'Owner', manager: 'Manager', front_desk: 'Front desk', housekeeping: 'Housekeeping' }
};

export function statusLabel(lang: Lang, dimension: StatusDimension, value: string): string {
  const table = LABELS[lang][dimension] as Record<string, string>;
  return table[value] ?? value;
}
