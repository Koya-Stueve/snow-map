import type { ForecastDataset, GridSpec } from './types';
import { createSyntheticDataset } from './synthetic';

/** Shape of meta.json written by scripts/fetch-forecast.ts */
interface MetaFile {
  version: 1;
  model: string;
  provider: string;
  providerUrl: string;
  licence: string;
  runTime: number;
  times: number[];
  grid: GridSpec;
  cells: { file: string; count: number };
  variables: Record<string, { file: string; scale: number; unit: string; kind: 'sum' | 'instant' }>;
  notes: string[];
  points?: Array<{ id: string; elevation: number | null; series: Record<string, (number | null)[]> }>;
}

const MISSING = 65535;

async function getBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** Load the newest fetched forecast from /data (static files). */
export async function loadForecast(base = `${import.meta.env.BASE_URL}data/`): Promise<ForecastDataset> {
  const latestRes = await fetch(`${base}latest.json`, { cache: 'no-cache' });
  // Dev servers answer missing files with index.html, so check the type too
  if (!latestRes.ok || !latestRes.headers.get('content-type')?.includes('json'))
    throw new Error('keine Prognosedaten gefunden – „npm run fetch“ ausführen');
  const latest = (await latestRes.json()) as { meta: string };
  const metaUrl = new URL(latest.meta, new URL(base, location.href)).href;
  const meta = (await (await fetch(metaUrl)).json()) as MetaFile;
  if (meta.version !== 1) throw new Error(`unsupported data version ${meta.version}`);
  const dir = metaUrl.slice(0, metaUrl.lastIndexOf('/') + 1);

  const cells = new Int32Array(await getBuffer(dir + meta.cells.file));
  const n = cells.length;
  const nT = meta.times.length;
  const fields: Record<string, Float32Array[]> = {};
  await Promise.all(
    Object.entries(meta.variables).map(async ([name, v]) => {
      const raw = new Uint16Array(await getBuffer(dir + v.file));
      if (raw.length !== n * nT) throw new Error(`${v.file}: size mismatch`);
      const perTime: Float32Array[] = [];
      for (let t = 0; t < nT; t++) {
        const f = new Float32Array(n);
        for (let c = 0; c < n; c++) {
          const q = raw[t * n + c];
          f[c] = q === MISSING ? NaN : q * v.scale;
        }
        perTime.push(f);
      }
      fields[name] = perTime;
    }),
  );

  return {
    meta: {
      model: meta.model,
      provider: meta.provider,
      providerUrl: meta.providerUrl,
      licence: meta.licence,
      runTime: meta.runTime,
      synthetic: false,
      notes: meta.notes,
    },
    times: meta.times,
    grid: meta.grid,
    cells,
    fields,
    points: meta.points
      ? Object.fromEntries(
          meta.points.map((p) => [
            p.id,
            {
              elevation: p.elevation,
              fields: Object.fromEntries(
                Object.entries(p.series).map(([k, s]) => [k, Float32Array.from(s, (x) => (x == null ? NaN : x))]),
              ),
            },
          ]),
        )
      : undefined,
  };
}

/** Real data if available, otherwise synthetic sample data (with the reason). */
export async function loadDataset(): Promise<{ dataset: ForecastDataset; fallbackReason?: string }> {
  try {
    return { dataset: await loadForecast() };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn('[snow-map] using synthetic data:', reason);
    return { dataset: createSyntheticDataset(), fallbackReason: reason };
  }
}
