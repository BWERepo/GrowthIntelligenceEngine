// A small in-memory Supabase stand-in that also supports writes, for testing
// server code. Filters: eq, neq, gte, lte, lt, in, is, not(col,"is",null), like.
// Writes: update, insert, upsert (onConflict + ignoreDuplicates). Terminals: await,
// maybeSingle, single; select(_, {count:"exact", head:true}) returns a count.
type Row = Record<string, any>;

export function mutableDb(tables: Record<string, Row[]>, defaults: Record<string, Row> = {}) {
  let serial = 0;
  const db = {
    tables,
    from(table: string) {
      tables[table] ??= [];
      const filters: Array<(r: Row) => boolean> = [];
      let mode: "select" | "update" | "insert" | "upsert" = "select";
      let patch: any = {};
      let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
      let head = false;
      let wantRows = false;
      const matched = () => tables[table]!.filter((r) => filters.every((f) => f(r)));
      const run = () => {
        if (mode === "insert" || mode === "upsert") {
          const input: Row[] = Array.isArray(patch) ? patch : [patch];
          const out: Row[] = [];
          for (const row of input) {
            if (mode === "upsert" && upsertOpts.onConflict) {
              const keys = upsertOpts.onConflict.split(",");
              const dupe = tables[table]!.find((r) => keys.every((k) => r[k] === row[k]));
              if (dupe) {
                if (upsertOpts.ignoreDuplicates) continue;
                Object.assign(dupe, row);
                out.push(dupe);
                continue;
              }
            }
            const stored = { id: `${table}-${++serial}`, ...(defaults[table] ?? {}), ...row };
            tables[table]!.push(stored);
            out.push(stored);
          }
          return { data: wantRows ? out : null, error: null, count: null };
        }
        const rows = matched();
        if (mode === "update") {
          for (const r of rows) Object.assign(r, patch);
          return { data: wantRows ? rows.map((r) => ({ ...r })) : null, error: null, count: null };
        }
        return { data: head ? null : rows, error: null, count: rows.length };
      };
      const b: any = {
        select: (_c?: string, o?: { head?: boolean }) => ((head = !!o?.head), (wantRows = true), b),
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
        neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
        gte: (k: string, v: string) => (filters.push((r) => r[k] >= v), b),
        lte: (k: string, v: string) => (filters.push((r) => r[k] <= v), b),
        lt: (k: string, v: string) => (filters.push((r) => r[k] < v), b),
        in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), b),
        is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
        not: (k: string, _op: string, v: unknown) => (filters.push((r) => (r[k] ?? null) !== v), b),
        like: (k: string, pat: string) => (filters.push((r) => new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`).test(String(r[k] ?? ""))), b),
        order: () => b,
        limit: () => b,
        range: () => b,
        update: (p: Row) => ((mode = "update"), (patch = p), b),
        insert: (p: Row | Row[]) => ((mode = "insert"), (patch = p), b),
        upsert: (p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) => ((mode = "upsert"), (patch = p), (upsertOpts = o ?? {}), b),
        maybeSingle: async () => {
          const r = run();
          return { ...r, data: (r.data as Row[] | null)?.[0] ?? null };
        },
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
