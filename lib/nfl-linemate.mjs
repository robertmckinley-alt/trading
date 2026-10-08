// Accepts user-authorized exports of public player trend rows. Does not bypass
// authentication, crawl Linemate, or access undocumented private endpoints.
export function normalizeLinemateExport(rows) {
 if(!Array.isArray(rows))throw Error('Expected an array of player trend rows');
 return rows.map((row,index)=>{
  if(!row||typeof row!=='object')throw Error('Invalid row '+index);
  const player=String(row.player||row.player_name||'').trim();
  const market=String(row.market||row.stat||'').trim();
  const games=Number(row.games||row.sample_size);
  const hits=Number(row.hits);
  const line=Number(row.line);
  if(!player||!market||!Number.isInteger(games)||games<=0||!Number.isInteger(hits)||hits<0||hits>games||!Number.isFinite(line))throw Error('Invalid trend row '+index);
  return {source:'user_authorized_export',player,market,line,games,hits,hitRate:hits/games,observedAt:row.observed_at||null};
 });
}
export function wilsonInterval(hits,games,z=1.96) {
 if(!Number.isInteger(games)||games<=0||!Number.isInteger(hits)||hits<0||hits>games)throw Error('Invalid observations');
 const p=hits/games,d=1+z*z/games,center=(p+z*z/(2*games))/d,margin=z*Math.sqrt(p*(1-p)/games+z*z/(4*games*games))/d;
 return {low:Math.max(0,center-margin),high:Math.min(1,center+margin)};
}
