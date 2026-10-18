import type { ReactNode } from 'react';

/** A numbered part of a report page. */
export function Section({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-line">
      <h2 className="label border-b border-line bg-surface-2 px-4 py-2 text-fg">
        <span className="text-muted">{number}.</span> {title}
      </h2>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** One stage of the way (of a frame, of a voice), as a column of label/value rows. */
export function Stage({
  title,
  rows,
}: {
  title: string;
  rows: Array<[string, string | number | null]>;
}) {
  return (
    <div className="min-w-0 bg-surface p-3">
      <h3 className="label mb-2 truncate text-fg">{title}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="label text-muted">{label}</dt>
            <dd className="m-0 truncate text-right font-mono text-[12px] tabular-nums text-fg">
              {value ?? '—'}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
