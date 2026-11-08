import Link from 'next/link';

/** Screens that only make sense with a real database say so instead of showing invented data. */
export function DemoNotice({ title }: { title: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4">
      <p className="eyebrow">AXON PMS</p>
      <h1 className="mt-1 font-display text-[1.6rem] font-semibold text-ink">{title}</h1>
      <p className="tone tone-amber mt-4 rounded-xl px-4 py-3 text-[14px]">
        Demo modu: bu ekran misafir mesajları ve kişisel veriler içerdiği için yalnızca gerçek veritabanı bağlantısıyla çalışır. Örnek veri gösterilmez.
      </p>
      <Link href="/rooms" className="btn-line mt-4 w-fit">Oda durumuna dön</Link>
    </main>
  );
}
