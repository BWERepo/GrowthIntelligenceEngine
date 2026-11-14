// A tiny in-memory stand-in for the Supabase query builder: enough for
// select / eq / gte / in / order / range / limit and awaiting the result.
type Row = Record<string, any>;

export function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const builder: any = {
        select: () => builder,
        eq: (k: string, v: unknown) => ((rows = rows.filter((r) => r[k] === v)), builder),
        neq: (k: string, v: unknown) => ((rows = rows.filter((r) => r[k] !== v)), builder),
        gte: (k: string, v: string) => ((rows = rows.filter((r) => r[k] >= v)), builder),
        in: (k: string, v: unknown[]) => ((rows = rows.filter((r) => v.includes(r[k]))), builder),
        order: () => builder,
        limit: (n: number) => ((rows = rows.slice(0, n)), builder),
        range: (a: number, b: number) => ((rows = rows.slice(a, b + 1)), builder),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
      };
      return builder;
    },
  } as any;
}
