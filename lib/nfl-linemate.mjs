// Linemate's published terms prohibit automated access and systematic extraction.
// This adapter accepts only manually transcribed personal-research observations or
// a provider-authorized export covered by written permission. It is never a feed.
export function normalizeLinemateExport(rows, {
 collectionMethod,
 permissionBasis,
 permissionReference = null,
 observedAt,
} = {}) {
 if(!['manual_entry','provider_export'].includes(collectionMethod))throw Error('Linemate import requires manual_entry or provider_export');
 if(!['personal_noncommercial','written_permission'].includes(permissionBasis))throw Error('Linemate import requires an explicit permission basis');
 if(collectionMethod==='provider_export'&&permissionBasis!=='written_permission')throw Error('Provider exports require written permission');
 if(permissionBasis==='written_permission'&&!String(permissionReference||'').trim())throw Error('Written permission requires a reference');
 const commonObservedAt=observedAt&&Number.isFinite(Date.parse(observedAt))?new Date(observedAt).toISOString():null;
 if(!Array.isArray(rows))throw Error('Expected an array of player trend rows');
 return rows.map((row,index)=>{
  if(!row||typeof row!=='object')throw Error('Invalid row '+index);
  const player=String(row.player||row.player_name||'').trim();
  const market=String(row.market||row.stat||'').trim();
  const games=Number(row.games||row.sample_size);
  const hits=Number(row.hits);
  const line=Number(row.line);
  const side=String(row.side||'').trim();
  const rowObservedAt=row.observed_at&&Number.isFinite(Date.parse(row.observed_at))?new Date(row.observed_at).toISOString():commonObservedAt;
  if(!player||!market||!['Over','Under'].includes(side)||!Number.isInteger(games)||games<=0||!Number.isInteger(hits)||hits<0||hits>games||!Number.isFinite(line)||!rowObservedAt)throw Error('Invalid trend row '+index);
  return {
   source:'linemate_manual_reference',
   collectionMethod,
   permissionBasis,
   permissionReference:permissionReference||null,
   player,
   market,
   side,
   line,
   games,
   hits,
   hitRate:hits/games,
   observedAt:rowObservedAt,
   actionable:false,
   reason:'Historical hit rate is context, not a probability estimate or trade signal',
  };
 });
}
export function wilsonInterval(hits,games,z=1.96) {
 if(!Number.isInteger(games)||games<=0||!Number.isInteger(hits)||hits<0||hits>games)throw Error('Invalid observations');
 const p=hits/games,d=1+z*z/games,center=(p+z*z/(2*games))/d,margin=z*Math.sqrt(p*(1-p)/games+z*z/(4*games*games))/d;
 return {low:Math.max(0,center-margin),high:Math.min(1,center+margin)};
}
