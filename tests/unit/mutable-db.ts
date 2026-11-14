// A small in-memory Supabase stand-in that also supports update / insert, for
// testing server code that writes. Filters: eq, gte, in. Terminal: await,
// maybeSingle, single. select(_, {count:"exact", head:true}) returns a count.
type Row = Record<string, any>;

export function mutableDb(tables: Record<string, Row[]>) {
  const log: Array<{ table: string; op: string; patch?: Row }> = [];
  const db = {
    tables,
    log,
    from(table: string) {
      tables[table] ??= [];
      const filters: Array<(r: Row) => boolean> = [];
      let mode: "select" | "update" | "insert" = "select";
      let patch: Row = {};
      let head = false;
      let wantRows = false;
      const matched = () => tables[table]!.filter((r) => filters.every((f) => f(r)));
      const run = () => {
        if (mode === "insert") {
          const rows = Array.isArray(patch) ? patch : [patch];
          tables[table]!.push(...rows.map((r) => ({ id: `id-${tables[table]!.length + 1}`, ...r })));
          log.push({ table, op: "insert", patch });
          return { data: wantRows ? rows : null, error: null, count: null };
        }
        const rows = matched();
        if (mode === "update") {
          for (const r of rows) Object.assign(r, patch);
          log.push({ table, op: "update", patch });
          return { data: wantRows ? rows.map((r) => ({ id: r.id })) : null, error: null, count: null };
        }
        return { data: head ? null : rows, error: null, count: rows.length };
      };
      const b: any = {
        select: (_c?: string, o?: { head?: boolean }) => ((head = !!o?.head), (wantRows = true), b),
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
        gte: (k: string, v: string) => (filters.push((r) => r[k] >= v), b),
        in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), b),
        order: () => b,
        limit: () => b,
        update: (p: Row) => ((mode = "update"), (patch = p), b),
        insert: (p: Row) => ((mode = "insert"), (patch = p), b),
        maybeSingle: async () => ({ ...run(), data: (run().data as Row[] | null)?.[0] ?? null }),
        single: async () => {
          const r = run();
          const first = (r.data as Row[] | null)?.[0];
          return first ? { ...r, data: first } : { data: null, error: { message: "not found" }, count: null };
        },
        then: (resolve: (v: unknown) => unknown) => resolve(run()),
      };
      return b;
    },
  };
  return db as any;
}
