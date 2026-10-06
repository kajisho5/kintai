export const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;

export const durJa = (m: number): string => {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h && r ? `${h}時間${r}分` : h ? `${h}時間` : `${r}分`;
};
