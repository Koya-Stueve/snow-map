// All times are shown in Japan time (JST), the relevant local time for the resorts.
export const DISPLAY_TZ = 'Asia/Tokyo';
export const DISPLAY_TZ_LABEL = 'JST';

const dateFmt = new Intl.DateTimeFormat('de-DE', { timeZone: DISPLAY_TZ, weekday: 'short', day: '2-digit', month: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('de-DE', { timeZone: DISPLAY_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat('de-DE', { timeZone: DISPLAY_TZ, weekday: 'short', day: 'numeric' });
const hourFmt = new Intl.DateTimeFormat('de-DE', { timeZone: DISPLAY_TZ, hour: 'numeric', hourCycle: 'h23' });
const runFmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', hourCycle: 'h23' });

/** "Do. 26.11." → "Do 26.11." */
export const formatDate = (ms: number) => dateFmt.format(ms).replace('.,', '').replace(/^(\w+)\./, '$1');
export const formatTime = (ms: number) => timeFmt.format(ms);
export const formatDay = (ms: number) => dayFmt.format(ms).replace('.,', '').replace(/^(\w+)\./, '$1');
// de-DE formats a lone hour as "0 Uhr", so parse the leading number
export const hourInTz = (ms: number) => parseInt(hourFmt.format(ms), 10);
/** Model run in UTC, e.g. "26.11. 00 UTC" */
export const formatRun = (ms: number) => `${runFmt.format(ms).replace(',', '')} UTC`;
